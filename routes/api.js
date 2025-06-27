const express = require('express');
const cors = require('cors');
const redis = require('redis');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');
const { HfInference } = require('@huggingface/inference');
const PQueue = require('p-queue');
const Post = require('../models/Post');
const Project = require('../models/Project');
const User = require('../models/User');
const crypto = require('crypto');

// Initialize request queue (1 concurrent request)
const queue = new PQueue({ concurrency: 1 });

const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.on('error', err => console.error('[Redis] Error:', err));
redisClient.connect().then(() => console.log('[Redis] Connected'));

// Validate environment variables
if (!process.env.X_BEARER_TOKEN || !process.env.MONGODB_URI) {
  console.error('[API] Error: Required environment variables not set');
  throw new Error('Required environment variables not set');
}
const client = new TwitterApi(process.env.X_BEARER_TOKEN);
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY || '');

// Enable CORS
router.use(cors());

// Cache middleware with request body hashing for POST /users
const cacheMiddleware = async (req, res, next) => {
  let cacheKey = `${req.method}:${req.originalUrl}`;
  if (req.method === 'POST' && req.originalUrl === '/solcontent/users') {
    const bodyHash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex');
    cacheKey = `${cacheKey}:${bodyHash}`;
  }
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log(`[Cache] Hit for ${cacheKey}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(cached);
      return;
    }
    console.log(`[Cache] Miss for ${cacheKey}`);
  } catch (err) {
    console.error('[Cache] Error:', err.message);
  }
  const originalJson = res.json;
  res.json = async (data) => {
    try {
      await redisClient.setEx(cacheKey, 86400, JSON.stringify(data)); // 24-hour cache
      console.log(`[Cache] Stored for ${cacheKey} (expires in 86400 seconds)`);
      return originalJson.call(res, data);
    } catch (err) {
      console.error('[Cache] Error storing:', err.message);
      return originalJson.call(res, data);
    }
  };
  next();
};

// Invalidate cache
async function invalidateCache(username) {
  const cacheKeys = [
    `GET:/solcontent/user-details/${username}`,
    `GET:/solcontent/posts/${username}`,
    `POST:/solcontent/users:${username}`
  ];
  try {
    for (const cacheKey of cacheKeys) {
      const keys = await redisClient.keys(`${cacheKey}*`);
      for (const key of keys) {
        await redisClient.del(key);
        console.log(`[Cache] Invalidated cache for ${key}`);
      }
    }
  } catch (err) {
    console.error(`[Cache] Error invalidating cache:`, err.message);
  }
}

// Retry logic for Twitter API with 429 handling
async function retryRequest(fn, cacheKey, res, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await queue.add(async () => {
        const response = await fn();
        if (response.headers) {
          console.log(`[API] Rate Limits: Remaining=${response.headers['x-rate-limit-remaining'] || 'unknown'}, Reset=${response.headers['x-rate-limit-reset'] || 'unknown'}`);
        }
        return response;
      });
      return result;
    } catch (err) {
      console.warn(`[API] Retry ${i + 1}/${retries}: ${err.message}`);
      if (err.code === 429) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached && !res.headersSent) {
            console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
            res.setHeader('Content-Type', 'application/json');
            res.end(cached);
            return null;
          }
          const retryAfter = err.headers?.['x-rate-limit-reset']
            ? Math.max((parseInt(err.headers['x-rate-limit-reset']) * 1000 - Date.now()) / 1000, 1)
            : 120;
          console.warn(`[API] 429 Rate Limit: Waiting ${retryAfter} seconds`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        } catch (cacheErr) {
          console.error('[Cache] Error:', cacheErr.message);
        }
      }
      if (i === retries - 1) {
        console.error(`[API] Request failed after ${retries} retries: ${err.message}`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 5000 * (i + 1)));
    }
  }
  return null;
}

// Validate Solana address
function isValidSolanaAddress(address) {
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

// Validate DEV_ID
function isValidDevId(devId) {
  const devIdRegex = /^[a-zA-Z0-9_-]{8,64}$/;
  return devIdRegex.test(devId);
}

// Extract hashtags
function extractHashtags(text) {
  const hashtagRegex = /#(\w+)/g;
  const hashtags = [];
  let match;
  while ((match = hashtagRegex.exec(text)) !== null) {
    hashtags.push(match[1]);
  }
  return hashtags;
}

// Extract mentions and count characters
function extractMentions(text) {
  const mentionRegex = /@(\w+)/g;
  let mentionChars = 0;
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    mentionChars += match[0].length;
  }
  return mentionChars;
}

// Sentiment analysis for scoring (0–1)
async function analyzeContentForScoring(tweet) {
  console.log(`[API] Bypassing sentiment analysis for tweet "${tweet.text.slice(0, 50)}...": Defaulting to score=0.5`);
  return { sentimentScore: 0.5 }; // Placeholder due to previous HuggingFace errors
}

// Calculate quality score (1–100)
function calculateQualityScore(analysis, tweet, followersCount) {
  const sentimentScore = analysis.sentimentScore;
  const lengthScore = Math.min(Math.max((tweet.text.length - 50) / 200, 0), 1);
  const { like_count, retweet_count, quote_count } = tweet.public_metrics;
  const engagementRaw = like_count + 2 * retweet_count + 3 * quote_count;
  const engagementScore = Math.min(engagementRaw / Math.max(1, followersCount), 1);
  const combinedScore = 0.5 * sentimentScore + 0.25 * lengthScore + 0.25 * engagementScore;
  return Math.round(combinedScore * 99) + 1;
}

// Calculate Blabz per project
function calculateBlabzPerProject(qualityScore) {
  return (qualityScore / 300).toFixed(4);
}

// POST /users
router.post('/users', cacheMiddleware, async (req, res) => {
  try {
    const { username, SOL_ID, DEV_ID } = req.body;
    if (!username || !SOL_ID || !DEV_ID) {
      return res.status(400).json({ error: 'username, SOL_ID, and DEV_ID are required' });
    }
    if (!isValidSolanaAddress(SOL_ID)) {
      return res.status(400).json({ error: 'Invalid SOL_ID format (must be 32-44 Base58 characters)' });
    }
    if (!isValidDevId(DEV_ID)) {
      return res.status(400).json({ error: 'Invalid DEV_ID format (must be alphanumeric, 8-64 characters)' });
    }

    const existingUser = await User.findOne({
      $or: [
        { SOL_ID, username: { $ne: username } },
        { DEV_ID, username: { $ne: username } }
      ]
    });
    if (existingUser) {
      return res.status(400).json({ error: `SOL_ID ${SOL_ID} or DEV_ID ${DEV_ID} is already associated with username ${existingUser.username}` });
    }

    let twitterUser;
    const cacheKey = `GET:/solcontent/user-details/${username}`;
    try {
      twitterUser = await retryRequest(
        () => client.v2.userByUsername(username, {
          'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location', 'created_at']
        }),
        cacheKey,
        res
      );
      if (!twitterUser || !twitterUser.data) {
        return res.status(404).json({ error: 'Twitter user not found' });
      }
    } catch (err) {
      console.error('[Twitter] Error fetching user:', err.message);
      return res.status(500).json({ error: 'Failed to fetch Twitter user data', details: err.message });
    }

    const userData = {
      SOL_ID,
      DEV_ID,
      userId: twitterUser.data.id || '',
      username: twitterUser.data.username,
      name: twitterUser.data.name || '',
      profile_image_url: twitterUser.data.profile_image_url || '',
      followers_count: twitterUser.data.public_metrics?.followers_count || 0,
      following_count: twitterUser.data.public_metrics?.following_count || 0,
      bio: twitterUser.data.description || '',
      location: twitterUser.data.location || '',
      created_at: twitterUser.data.created_at ? new Date(twitterUser.data.created_at) : undefined,
      updated_at: new Date()
    };

    const user = await User.findOneAndUpdate(
      { username },
      { $set: userData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`[MongoDB] User ${username} (SOL_ID: ${SOL_ID}, DEV_ID: ${DEV_ID}) created/updated`);
    await invalidateCache(username);
    res.json({ message: `User ${username} saved`, user });
  } catch (err) {
    console.error('[API] Error in POST /users:', err.message);
    if (err.code === 11000) {
      return res.status(400).json({ error: `Duplicate key error: ${err.keyValue ? Object.keys(err.keyValue).join(', ') : 'unknown field'}` });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /user-details/:username
router.get('/user-details/:username', cacheMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    const { username } = req.params;
    console.log(`[API] Fetching user details for: ${username}`);

    // Try database first
    const userDoc = await User.findOne({ username }).lean();
    const cacheAge = await redisClient.ttl(cacheKey);
    const isCacheFresh = cacheAge > 0 && cacheAge <= 86400; // Cache valid within 24 hours

    if (userDoc && userDoc.updated_at && (Date.now() - new Date(userDoc.updated_at).getTime()) < 24 * 60 * 60 * 1000 && isCacheFresh) {
      console.log(`[MongoDB] Serving user ${username} from database (last updated: ${userDoc.updated_at})`);
      return res.json({
        SOL_ID: userDoc.SOL_ID || '',
        DEV_ID: userDoc.DEV_ID || '',
        userId: userDoc.userId || '',
        username: userDoc.username,
        name: userDoc.name || '',
        profile_image_url: userDoc.profile_image_url || '',
        followers_count: userDoc.followers_count || 0,
        following_count: userDoc.following_count || 0,
        bio: userDoc.bio || '',
        location: userDoc.location || '',
        created_at: userDoc.created_at
      });
    }

    // Fetch from Twitter if data is stale or missing
    let twitterUser = await retryRequest(
      () => client.v2.userByUsername(username, {
        'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'created_at', 'location']
      }),
      cacheKey,
      res
    );
    if (!twitterUser || !twitterUser.data) {
      if (userDoc) {
        console.log(`[MongoDB] Serving stale user ${username} from database`);
        return res.json({
          SOL_ID: userDoc.SOL_ID || '',
          DEV_ID: userDoc.DEV_ID || '',
          userId: userDoc.userId || '',
          username: userDoc.username,
          name: userDoc.name || '',
          profile_image_url: userDoc.profile_image_url || '',
          followers_count: userDoc.followers_count || 0,
          following_count: userDoc.following_count || 0,
          bio: userDoc.bio || '',
          location: userDoc.location || '',
          created_at: userDoc.created_at
        });
      }
      return res.status(404).json({ error: 'User not found in database or Twitter' });
    }

    // Update or create user in database
    const userData = {
      SOL_ID: userDoc?.SOL_ID || `TEMP_${username}_${Date.now()}`,
      DEV_ID: userDoc?.DEV_ID || `TEMP_${username}_${Date.now()}`,
      userId: twitterUser.data.id || '',
      username: twitterUser.data.username,
      name: twitterUser.data.name || '',
      profile_image_url: twitterUser.data.profile_image_url || '',
      followers_count: twitterUser.data.public_metrics?.followers_count || 0,
      following_count: twitterUser.data.public_metrics?.following_count || 0,
      bio: twitterUser.data.description || '',
      location: twitterUser.data.location || '',
      created_at: twitterUser.data.created_at ? new Date(twitterUser.data.created_at) : undefined,
      updated_at: new Date()
    };

    const user = await User.findOneAndUpdate(
      { username },
      { $set: userData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`[MongoDB] User ${username} updated from Twitter`);
    await invalidateCache(username);

    res.json({
      SOL_ID: user.SOL_ID || '',
      DEV_ID: user.DEV_ID || '',
      userId: user.userId,
      username: user.username,
      name: user.name,
      profile_image_url: user.profile_image_url,
      followers_count: user.followers_count,
      following_count: user.following_count,
      bio: user.bio || '',
      location: user.location || '',
      created_at: user.created_at
    });
  } catch (err) {
    console.error('[API] Error in /user-details/:username:', err.message);
    if (err.code === 429 && !res.headersSent) {
      const userDoc = await User.findOne({ username: req.params.username }).lean();
      if (userDoc) {
        console.log(`[MongoDB] Serving database response for ${req.params.username}`);
        res.json({
          SOL_ID: userDoc.SOL_ID || '',
          DEV_ID: userDoc.DEV_ID || '',
          userId: userDoc.userId || '',
          username: userDoc.username,
          name: userDoc.name || '',
          profile_image_url: userDoc.profile_image_url || '',
          followers_count: userDoc.followers_count || 0,
          following_count: userDoc.following_count || 0,
          bio: userDoc.bio || '',
          location: userDoc.location || '',
          created_at: userDoc.created_at
        });
        return;
      }
      res.status(404).json({ error: 'User not found, no cache or database data available' });
      return;
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /projects
router.post('/projects', cacheMiddleware, async (req, res) => {
  try {
    const { name, keywords, description, website } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name required' });
    }
    console.log('[API] POST /projects: keywords=', keywords);
    const validatedKeywords = Array.isArray(keywords) ? keywords : (keywords === null || keywords === undefined || keywords === 'null' || keywords === '' ? [] : [String(keywords)]);
    const project = await Project.findOneAndUpdate(
      { name: name.toUpperCase() },
      {
        name: name.toUpperCase(),
        keywords: validatedKeywords,
        description: description || '',
        website: website || '',
        updated_at: new Date()
      },
      { upsert: true, new: true }
    );
    res.json({ message: `Project ${name.toLowerCase()} added`, project });
  } catch (err) {
    console.error('[API] Error adding project:', err.message);
    res.status(400).json({ error: 'Server error', details: err.message });
  }
});

// PUT /project/:project
router.put('/project/:project', cacheMiddleware, async (req, res) => {
  try {
    const fields = req.body;
    console.log('[API] PUT /project: keywords=', fields.keywords);
    if (fields.keywords) {
      fields.keywords = Array.isArray(fields.keywords) ? fields.keywords : (fields.keywords === null || fields.keywords === undefined || fields.keywords === 'null' || fields.keywords === '' ? [] : [String(fields.keywords)]);
    }
    fields.updated_at = new Date();
    const project = await Project.findOneAndUpdate(
      { name: req.params.project.toUpperCase() },
      { $set: fields },
      { new: true }
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ message: `Project ${req.params.project} updated`, project });
  } catch (err) {
    console.error('[API] Error updating project:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /posts/:username
router.get('/posts/:username', cacheMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    const { username } = req.params;
    console.log(`[API] Fetching posts for user: ${username}`);

    // Check if user exists, auto-register if not
    let userDoc = await User.findOne({ username }).lean();
    if (!userDoc) {
      console.log(`[API] User ${username} not found in database, attempting to fetch from Twitter`);
      let twitterUser = await retryRequest(
        () => client.v2.userByUsername(username, {
          'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location', 'created_at']
        }),
        `GET:/solcontent/user-details/${username}`,
        res
      );
      if (!twitterUser || !twitterUser.data) {
        return res.status(404).json({ error: 'Twitter user not found' });
      }
      const userData = {
        SOL_ID: `TEMP_${username}_${Date.now()}`,
        DEV_ID: `TEMP_${username}_${Date.now()}`,
        userId: twitterUser.data.id || '',
        username: twitterUser.data.username,
        name: twitterUser.data.name || '',
        profile_image_url: twitterUser.data.profile_image_url || '',
        followers_count: twitterUser.data.public_metrics?.followers_count || 0,
        following_count: twitterUser.data.public_metrics?.following_count || 0,
        bio: twitterUser.data.description || '',
        location: twitterUser.data.location || '',
        created_at: twitterUser.data.created_at ? new Date(twitterUser.data.created_at) : undefined,
        updated_at: new Date()
      };
      userDoc = await User.findOneAndUpdate(
        { username },
        { $set: userData },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      console.log(`[MongoDB] Auto-registered user ${username} with temporary SOL_ID and DEV_ID`);
      await invalidateCache(username);
    }

    // Check if posts are fresh (within 24 hours)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const cacheAge = await redisClient.ttl(cacheKey);
    const isCacheFresh = cacheAge > 0 && cacheAge <= 86400;

    if (userDoc.updated_at && (Date.now() - new Date(userDoc.updated_at).getTime()) < 24 * 60 * 60 * 1000 && isCacheFresh) {
      // Serve posts from database if fresh
      const dbPosts = await Post.find({ userId: userDoc.userId, createdAt: { $gte: sevenDaysAgo } })
        .select('SOL_ID DEV_ID userId username postId content project score blabz likes retweets replies hashtags tweetUrl createdAt')
        .lean();
      const dbProjects = await Project.find().lean();
      const categorizedPosts = {};
      dbProjects.forEach(project => {
        categorizedPosts[project.name.toUpperCase()] = [];
      });
      dbPosts.forEach(post => {
        if (post.tweetType === 'reply') return;
        const postData = {
          SOL_ID: post.SOL_ID || userDoc.userId,
          DEV_ID: post.DEV_ID || '',
          userId: post.userId,
          username: post.username,
          postId: post.postId,
          content: post.content,
          project: post.project,
          score: post.score,
          blabz: post.blabz,
          likes: post.likes,
          retweets: post.retweets,
          replies: post.replies,
          hashtags: post.hashtags || [],
          tweetUrl: post.tweetUrl,
          createdAt: post.createdAt
        };
        post.project.forEach(project => {
          if (categorizedPosts[project]) {
            categorizedPosts[project].push(postData);
          }
        });
      });
      for (const project in categorizedPosts) {
        const seenPostIds = new Set();
        categorizedPosts[project] = categorizedPosts[project].filter(post => {
          if (seenPostIds.has(post.postId)) return false;
          seenPostIds.add(post.postId);
          return true;
        });
        categorizedPosts[project].sort((a, b) => b.score - a.score);
      }
      const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
      if (totalPosts === 0) {
        return res.status(200).json({ message: 'No posts found in database for this user', posts: categorizedPosts });
      }
      console.log(`[API] Returning ${totalPosts} posts from database for ${username}`);
      return res.json({ posts: categorizedPosts });
    }

    // Fetch from Twitter if data is stale
    let twitterUser = await retryRequest(
      () => client.v2.userByUsername(username, {
        'user.fields': ['id', 'public_metrics']
      }),
      cacheKey,
      res
    );
    if (!twitterUser || !twitterUser.data) {
      twitterUser = { data: { id: userDoc.userId, public_metrics: { followers_count: userDoc.followers_count || 0 } } };
    }
    const userId = twitterUser.data.id;
    const followersCount = twitterUser.data.public_metrics?.followers_count || 0;

    // Fetch projects
    const dbProjects = await Project.find().lean();
    if (!dbProjects.length) {
      console.warn('[MongoDB] No projects found');
      return res.status(404).json({ error: 'No projects configured in database' });
    }

    // Fetch tweets
    let tweets;
    try {
      tweets = await retryRequest(
        () => client.v2.userTimeline(userId.toString(), {
          'tweet.fields': ['created_at', 'public_metrics', 'text', 'referenced_tweets'],
          'expansions': ['referenced_tweets.id'],
          exclude: ['retweets'],
          max_results: 50,
          start_time: sevenDaysAgo.toISOString()
        }),
        cacheKey,
        res
      );
      if (!tweets) {
        const dbPosts = await Post.find({ userId, createdAt: { $gte: sevenDaysAgo } })
          .select('SOL_ID DEV_ID userId username postId content project score blabz likes retweets replies hashtags tweetUrl createdAt')
          .lean();
        const categorizedPosts = {};
        dbProjects.forEach(project => {
          categorizedPosts[project.name.toUpperCase()] = [];
        });
        dbPosts.forEach(post => {
          if (post.tweetType === 'reply') return;
          const postData = {
            SOL_ID: post.SOL_ID || userId,
            DEV_ID: post.DEV_ID || '',
            userId: post.userId,
            username: post.username,
            postId: post.postId,
            content: post.content,
            project: post.project,
            score: post.score,
            blabz: post.blabz,
            likes: post.likes,
            retweets: post.retweets,
            replies: post.replies,
            hashtags: post.hashtags || [],
            tweetUrl: post.tweetUrl,
            createdAt: post.createdAt
          };
          post.project.forEach(project => {
            if (categorizedPosts[project]) {
              categorizedPosts[project].push(postData);
            }
          });
        });
        for (const project in categorizedPosts) {
          const seenPostIds = new Set();
          categorizedPosts[project] = categorizedPosts[project].filter(post => {
            if (seenPostIds.has(post.postId)) return false;
            seenPostIds.add(post.postId);
            return true;
          });
          categorizedPosts[project].sort((a, b) => b.score - a.score);
        }
        const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
        if (totalPosts === 0) {
          return res.status(200).json({ message: 'No posts found in database during rate limit', posts: categorizedPosts });
        }
        console.log(`[API] Returning ${totalPosts} posts from database for ${username}`);
        return res.json({ posts: categorizedPosts });
      }
      console.log(`[Twitter] Fetched ${tweets.meta?.result_count || 0} tweets for user ${username}`);
    } catch (err) {
      console.error(`[Twitter] Error fetching tweets for ${username}:`, err.message);
      return res.status(500).json({ error: 'Failed to fetch tweets', details: err.message });
    }

    // Initialize categorized posts
    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });

    if (tweets.meta.result_count) {
      for await (const tweet of tweets) {
        console.log(`[Debug] Processing tweet ID ${tweet.id}: ${tweet.text.slice(0, 50)}...`);

        // Filter: Length < 51 chars
        if (tweet.text.length < 51) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: too short (${tweet.text.length} characters)`);
          continue;
        }

        // Filter: Mention-heavy
        const mentionChars = extractMentions(tweet.text);
        const totalChars = tweet.text.length;
        const mentionRatio = mentionChars / totalChars;
        const nonMentionText = tweet.text.replace(/@(\w+)/g, '').replace(/\s+/g, ' ').trim();
        if (mentionRatio > 0.6 || nonMentionText.length < 10) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: mention-heavy (ratio=${mentionRatio.toFixed(2)})`);
          continue;
        }

        // Determine tweet type
        let tweetType = 'main';
        if (tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
          const refTweet = tweet.referenced_tweets[0];
          if (refTweet.type === 'replied_to') tweetType = 'reply';
          else if (refTweet.type === 'quoted') tweetType = 'quote';
        }

        // Filter: Skip replies
        if (tweetType === 'reply') {
          console.log(`[Debug] Tweet ${tweet.id} skipped: is a reply`);
          continue;
        }

        // Check if already processed
        const existingPost = await Post.findOne({ postId: tweet.id }).lean();
        if (existingPost) {
          console.log(`[Debug] Tweet ${tweet.id} already processed`);
          continue;
        }

        // Match projects
        const text = tweet.text.toLowerCase();
        const matchedProjects = [];
        for (const project of dbProjects) {
          const projectName = project.name.toLowerCase();
          const projectUsername = `@${username.toLowerCase()}`;
          const projectKeywords = (project.keywords || []).map(k => k.toLowerCase());
          const queryTerms = [projectName, projectUsername, ...projectKeywords];
          const matchesTag = queryTerms.some(term =>
            text.includes(term.toLowerCase()) ||
            text.includes(`@${term.toLowerCase().replace('@', '')}`)
          );
          const matchesKeyword = projectKeywords.some(keyword =>
            text.includes(keyword.toLowerCase())
          );
          if (matchesTag || matchesKeyword) {
            matchedProjects.push(project.name.toUpperCase());
          }
        }

        // Filter: No project match
        if (matchedProjects.length === 0) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: no project match`);
          continue;
        }

        // Sentiment analysis
        let analysis;
        try {
          analysis = await analyzeContentForScoring(tweet);
        } catch (err) {
          console.error('[HuggingFace] Error in scoring:', err.message);
          analysis = { sentimentScore: 0.5 };
        }

        // Calculate scores
        const qualityScore = calculateQualityScore(analysis, tweet, followersCount);
        const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
        const totalBlabz = (projectBlabz * matchedProjects.length).toFixed(4);

        // Save post
        try {
          const post = new Post({
            SOL_ID: userDoc.SOL_ID || userId,
            DEV_ID: userDoc.DEV_ID || '',
            userId,
            username,
            postId: tweet.id,
            content: tweet.text,
            project: matchedProjects,
            projects: matchedProjects.map(project => ({
              project,
              blabz: projectBlabz
            })),
            score: qualityScore,
            blabz: totalBlabz,
            likes: tweet.public_metrics.like_count,
            retweets: tweet.public_metrics.retweet_count,
            replies: tweet.public_metrics.reply_count,
            hashtags: extractHashtags(tweet.text),
            tweetUrl: `https://x.com/${username}/status/${tweet.id}`,
            createdAt: tweet.created_at
          });
          await post.save();
          console.log(`[MongoDB] Saved post for ${username}, projects: ${matchedProjects.join(', ')}, postId: ${tweet.id}`);
        } catch (err) {
          if (err.code === 11000) {
            console.log(`[MongoDB] Duplicate post detected for postId ${tweet.id}`);
          } else {
            console.error('[MongoDB] Error saving Post:', err.message);
          }
          continue;
        }

        // Add to categorized posts
        const postData = {
          SOL_ID: userDoc.SOL_ID || userId,
          DEV_ID: userDoc.DEV_ID || '',
          userId,
          username,
          postId: tweet.id,
          content: tweet.text,
          project: matchedProjects,
          score: qualityScore,
          blabz: totalBlabz,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count,
          hashtags: extractHashtags(tweet.text),
          tweetUrl: `https://x.com/${username}/status/${tweet.id}`,
          createdAt: tweet.created_at
        };
        matchedProjects.forEach(project => {
          categorizedPosts[project].push(postData);
        });
      }
    }

    // Fetch existing posts from DB
    const dbPosts = await Post.find({ userId, createdAt: { $gte: sevenDaysAgo } })
      .select('SOL_ID DEV_ID userId username postId content project score blabz likes retweets replies hashtags tweetUrl createdAt')
      .lean();
    dbPosts.forEach(post => {
      if (post.tweetType === 'reply') {
        console.log(`[Debug] Existing post ${post.postId} skipped: is a reply`);
        return;
      }
      const postData = {
        SOL_ID: post.SOL_ID || userId,
        DEV_ID: post.DEV_ID || '',
        userId: post.userId,
        username: post.username,
        postId: post.postId,
        content: post.content,
        project: post.project,
        score: post.score,
        blabz: post.blabz,
        likes: post.likes,
        retweets: post.retweets,
        replies: post.replies,
        hashtags: post.hashtags || [],
        tweetUrl: post.tweetUrl,
        createdAt: post.createdAt
      };
      post.project.forEach(project => {
        if (categorizedPosts[project]) {
          categorizedPosts[project].push(postData);
        }
      });
    });

    // Remove duplicates by postId
    for (const project in categorizedPosts) {
      const seenPostIds = new Set();
      categorizedPosts[project] = categorizedPosts[project].filter(post => {
        if (seenPostIds.has(post.postId)) return false;
        seenPostIds.add(post.postId);
        return true;
      });
      categorizedPosts[project].sort((a, b) => b.score - a.score);
    }

    // Update user timestamp
    await User.findOneAndUpdate({ username }, { $set: { updated_at: new Date() } });

    const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
    if (totalPosts === 0) {
      let errorMessage = 'No posts found for this user in the last 7 days.';
      if (!tweets.meta.result_count) {
        errorMessage = 'No tweets found for this user in the last 7 days.';
      } else {
        errorMessage = 'No tweets passed the filters (>50 chars, <60% mentions, project match, non-reply).';
      }
      return res.status(200).json({ message: errorMessage, posts: categorizedPosts });
    }

    console.log(`[API] Returning ${totalPosts} posts for ${username}, categorized by project`);
    res.json({ posts: categorizedPosts });
  } catch (err) {
    console.error('[API] Error in GET /posts/:username:', err.message);
    if (err.code === 429 && !res.headersSent) {
      const dbPosts = await Post.find({ username, createdAt: { $gte: sevenDaysAgo } })
        .select('SOL_ID DEV_ID userId username postId content project score blabz likes retweets replies hashtags tweetUrl createdAt')
        .lean();
      const dbProjects = await Project.find().lean();
      const categorizedPosts = {};
      dbProjects.forEach(project => {
        categorizedPosts[project.name.toUpperCase()] = [];
      });
      dbPosts.forEach(post => {
        if (post.tweetType === 'reply') return;
        const postData = {
          SOL_ID: post.SOL_ID || userDoc?.userId || '',
          DEV_ID: post.DEV_ID || '',
          userId: post.userId,
          username: post.username,
          postId: post.postId,
          content: post.content,
          project: post.project,
          score: post.score,
          blabz: post.blabz,
          likes: post.likes,
          retweets: post.retweets,
          replies: post.replies,
          hashtags: post.hashtags || [],
          tweetUrl: post.tweetUrl,
          createdAt: post.createdAt
        };
        post.project.forEach(project => {
          if (categorizedPosts[project]) {
            categorizedPosts[project].push(postData);
          }
        });
      });
      for (const project in categorizedPosts) {
        const seenPostIds = new Set();
        categorizedPosts[project] = categorizedPosts[project].filter(post => {
          if (seenPostIds.has(post.postId)) return false;
          seenPostIds.add(post.postId);
          return true;
        });
        categorizedPosts[project].sort((a, b) => b.score - a.score);
      }
      const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
      if (totalPosts === 0) {
        console.log(`[Cache] No cache or database posts for ${cacheKey}, returning empty data`);
        return res.status(200).json({ message: 'No posts found in cache or database', posts: {} });
      }
      console.log(`[API] Returning ${totalPosts} posts from database for ${username}`);
      res.json({ posts: categorizedPosts });
      return;
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

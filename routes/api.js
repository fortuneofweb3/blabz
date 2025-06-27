const express = require('express');
const cors = require('cors');
const redis = require('redis');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');
const { HfInference } = require('@huggingface/inference');
const Post = require('../models/Post');
const ProcessedPost = require('../models/ProcessedPost');
const Project = require('../models/Project');
const User = require('../models/User');
const mongoose = require('mongoose');
const crypto = require('crypto');

const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.on('error', err => console.error('[Redis] Error:', err));
redisClient.connect().then(() => console.log('[Redis] Connected'));

// Validate environment variables
if (!process.env.X_BEARER_TOKEN) {
  console.error('[API] Error: X_BEARER_TOKEN is not set');
  throw new Error('X_BEARER_TOKEN is not set');
}
if (!process.env.MONGODB_URI) {
  console.error('[API] Error: MONGODB_URI is not set');
  throw new Error('MONGODB_URI is not set');
}
console.log('[API] X_BEARER_TOKEN loaded:', process.env.X_BEARER_TOKEN.substring(0, 10) + '...');
const client = new TwitterApi(process.env.X_BEARER_TOKEN);
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY || '');

// Enable CORS
router.use(cors());

// Custom error for skipping tweets
class SkipTweetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipTweetError';
  }
}

// Cache middleware with request body hashing for POST /users
const cacheMiddleware = async (req, res, next) => {
  let cacheKey = `${req.method}:${req.originalUrl}`;
  if (req.method === 'POST' && req.originalUrl === '/solcontent/users') {
    const bodyHash = crypto
      .createHash('md5')
      .update(JSON.stringify(req.body))
      .digest('hex');
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
      await redisClient.setEx(cacheKey, 86400, JSON.stringify(data)); // 24 hours
      console.log(`[Cache] Stored for ${cacheKey} (expires in 86400 seconds)`);
      return originalJson.call(res, data);
    } catch (err) {
      console.error('[Cache] Error storing:', err.message);
      return originalJson.call(res, data);
    }
  };
  next();
};

// Invalidate cache (only for user updates)
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
async function retryRequest(fn, cacheKey, res, retries = 3, delay = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      if (result) {
        await redisClient.setEx(cacheKey, 86400, JSON.stringify(result)); // 24 hours
        if (!res.headersSent) {
          res.json(result);
        }
        return result;
      }
      continue;
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
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
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
  return { sentimentScore: 0.5 };
}

// Calculate quality score (1–100)
function calculateQualityScore(analysis, tweet, followersCount) {
  const sentimentScore = analysis.sentimentScore;
  const lengthScore = Math.min(Math.max((tweet.text.length - 50) / 200, 0), 1);
  const { like_count, retweet_count, quote_count } = tweet.public_metrics;
  const engagementRaw = like_count + 2 * retweet_count + 3 * quote_count;
  const engagementScore = Math.min(engagementRaw / Math.max(1, followersCount), 1);
  const combinedScore = 0.5 * sentimentScore + 0.25 * lengthScore + 0.25 * engagementScore;
  const qualityScore = Math.round(combinedScore * 99) + 1;
  console.log(`[Debug] Quality score: Sentiment=${sentimentScore.toFixed(2)}, Length=${lengthScore.toFixed(2)}, Engagement=${engagementScore.toFixed(2)}, Combined=${combinedScore.toFixed(2)}, Final=${qualityScore}`);
  return qualityScore;
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
      if (!twitterUser) return;
      if (!twitterUser.data) {
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
      additionalFields: {}
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
  const cacheKey = `GET:/solcontent/user-details/${req.params.username}`;
  try {
    console.log(`[API] Fetching user details for: ${req.params.username}`);
    let user = await retryRequest(
      () => client.v2.userByUsername(req.params.username, {
        'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'created_at', 'location']
      }),
      cacheKey,
      res
    );
    if (!user) {
      // Fallback to database
      const userDoc = await User.findOne({ username: req.params.username }).lean();
      if (!userDoc) {
        return res.status(404).json({ error: 'User not found in database or Twitter' });
      }
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
    if (!user.data) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userDoc = await User.findOne({ userId: user.data.id }).lean();
    res.json({
      SOL_ID: userDoc?.SOL_ID || '',
      DEV_ID: userDoc?.DEV_ID || '',
      userId: user.data.id,
      username: user.data.username,
      name: user.data.name,
      profile_image_url: user.data.profile_image_url,
      followers_count: user.data.public_metrics.followers_count,
      following_count: user.data.public_metrics.following_count,
      bio: user.data.description || '',
      location: user.data.location || '',
      created_at: user.data.created_at
    });
  } catch (err) {
    console.error('[API] Error in /user-details/:username:', err.message);
    if (err.code === 429) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(cached);
        return;
      }
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
    const { name, keywords, description, website, attributes } = req.body;
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
        verified: false,
        additionalProjectFields: attributes || {}
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

// POST /projects/:project/verify
router.post('/projects/:project/verify', cacheMiddleware, async (req, res) => {
  try {
    const project = await Project.findOneAndUpdate(
      { name: req.params.project.toUpperCase() },
      { $set: { verified: true } },
      { new: true }
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ message: 'Project verified', project });
  } catch (err) {
    console.error('[API] Error verifying project:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /projects/:project/unverify
router.post('/projects/:project/unverify', cacheMiddleware, async (req, res) => {
  try {
    const project = await Project.findOneAndUpdate(
      { name: req.params.project.toUpperCase() },
      { $set: { verified: false } },
      { new: true }
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ message: 'Project unverified', project });
  } catch (err) {
    console.error('[API] Error unverifying project:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /projects/:project/verification
router.get('/projects/:project/verification', cacheMiddleware, async (req, res) => {
  try {
    const project = await Project.findOne({ name: req.params.project.toUpperCase() }).lean();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ name: project.name, verified: project.verified });
  } catch (err) {
    console.error('[API] Error checking project verification:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /projects/verified
router.get('/projects/verified', cacheMiddleware, async (req, res) => {
  try {
    const verifiedProjects = await Project.find({ verified: true }).lean();
    res.json({ projects: verifiedProjects });
  } catch (err) {
    console.error('[API] Error fetching verified projects:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /posts/:username
router.get('/posts/:username', cacheMiddleware, async (req, res) => {
  const cacheKey = `GET:/solcontent/posts/${req.params.username}`;
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
        SOL_ID: `TEMP_${username}_${Date.now()}`, // Placeholder
        DEV_ID: `TEMP_${username}_${Date.now()}`, // Placeholder
        userId: twitterUser.data.id || '',
        username: twitterUser.data.username,
        name: twitterUser.data.name || '',
        profile_image_url: twitterUser.data.profile_image_url || '',
        followers_count: twitterUser.data.public_metrics?.followers_count || 0,
        following_count: twitterUser.data.public_metrics?.following_count || 0,
        bio: twitterUser.data.description || '',
        location: twitterUser.data.location || '',
        created_at: twitterUser.data.created_at ? new Date(twitterUser.data.created_at) : undefined,
        additionalFields: {}
      };
      userDoc = await User.findOneAndUpdate(
        { username },
        { $set: userData },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      console.log(`[MongoDB] Auto-registered user ${username} with temporary SOL_ID and DEV_ID`);
      await invalidateCache(username);
    }

    // Fetch user details from Twitter or use database
    let twitterUser;
    try {
      twitterUser = await retryRequest(
        () => client.v2.userByUsername(username, {
          'user.fields': ['id', 'public_metrics']
        }),
        `${cacheKey}:user`,
        res
      );
      if (!twitterUser) {
        twitterUser = { data: { id: userDoc.userId, public_metrics: { followers_count: userDoc.followers_count || 0 } } };
      }
      if (!twitterUser.data) {
        return res.status(404).json({ error: 'Twitter user not found' });
      }
    } catch (err) {
      console.error(`[Twitter] Error fetching user ${username}:`, err.message);
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

    // Fetch tweets (up to 50, last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let tweets;
    try {
      tweets = await retryRequest(
        () => client.v2.userTimeline(userId.toString(), {
          'tweet.fields': ['created_at', 'public_metrics', 'text', 'referenced_tweets'],
          'expansions': ['referenced_tweets.id'],
          exclude: ['retweets'],
          max_results: 50,
          start_time: sevenDaysAgo
        }),
        cacheKey,
        res
      );
      console.log(`[Twitter] Fetched ${tweets?.meta?.result_count || 0} tweets for user ${username}`);
    } catch (err) {
      console.error(`[Twitter] Error fetching tweets for ${username}:`, err.message);
    }

    // Initialize categorized posts
    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });

    if (tweets && tweets.meta?.result_count) {
      for await (const tweet of tweets) {
        console.log(`[Debug] Processing tweet ID ${tweet.id}: ${tweet.text.slice(0, 50)}...`);

        // Filter: Length < 51 chars
        if (tweet.text.length < 51) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: too short (${tweet.text.length} characters)`);
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
          continue;
        }

        // Filter: Mention-heavy
        const mentionChars = extractMentions(tweet.text);
        const totalChars = tweet.text.length;
        const mentionRatio = mentionChars / totalChars;
        const nonMentionText = tweet.text.replace(/@(\w+)/g, '').replace(/\s+/g, ' ').trim();
        if (mentionRatio > 0.6 || nonMentionText.length < 10) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: mention-heavy (ratio=${mentionRatio.toFixed(2)})`);
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
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
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
          continue;
        }

        // Check if already processed
        const processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean();
        if (processedPost) {
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
            text.includes(term.toLowerCase()) || text.includes(`@${term.toLowerCase().replace('@', '')}`)
          );
          const matchesKeyword = projectKeywords.some(keyword => text.includes(keyword.toLowerCase()));
          if (matchesTag || matchesKeyword) {
            matchedProjects.push(project);
          }
        }

        // Filter: No project match
        if (matchedProjects.length === 0) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: no project match`);
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
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
        const verifiedProjects = matchedProjects.filter(project => project.verified);
        const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
        const totalBlabz = verifiedProjects.length > 0 ? (projectBlabz * verifiedProjects.length).toFixed(4) : 0;

        // Save post
        try {
          const post = new Post({
            SOL_ID: userDoc.SOL_ID || `TEMP_${username}_${Date.now()}`,
            DEV_ID: userDoc.DEV_ID || `TEMP_${username}_${Date.now()}`,
            userId,
            username,
            postId: tweet.id,
            content: tweet.text,
            project: matchedProjects.map(project => project.name.toUpperCase()),
            projects: verifiedProjects.map(project => ({
              project: project.name.toUpperCase(),
              blabz: projectBlabz
            })),
            score: qualityScore,
            blabz: totalBlabz,
            likes: tweet.public_metrics.like_count,
            retweets: tweet.public_metrics.retweet_count,
            replies: tweet.public_metrics.reply_count,
            hashtags: extractHashtags(tweet.text),
            tweetUrl: `https://x.com/${username}/status/${tweet.id}`,
            createdAt: tweet.created_at,
            tweetType,
            additionalFields: { quote_count: tweet.public_metrics.quote_count }
          });
          await post.save();
          console.log(`[MongoDB] Saved post for ${username}, projects: ${matchedProjects.map(p => p.name).join(', ')}`);
        } catch (err) {
          if (err.code !== 11000) console.error('[MongoDB] Error saving Post:', err.message);
          continue;
        }

        // Mark as processed
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed`);
        } catch (err) {
          if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }

        // Add to categorized posts
        const postData = {
          SOL_ID: userDoc.SOL_ID || `TEMP_${username}_${Date.now()}`,
          DEV_ID: userDoc.DEV_ID || `TEMP_${username}_${Date.now()}`,
          userId,
          username,
          postId: tweet.id,
          content: tweet.text,
          project: matchedProjects.map(project => project.name.toUpperCase()),
          score: qualityScore,
          blabz: totalBlabz,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          replies: tweet.public_metrics.reply_count,
          hashtags: extractHashtags(tweet.text),
          tweetUrl: `https://x.com/${username}/status/${tweet.id}`,
          createdAt: tweet.created_at,
          tweetType,
          additionalFields: { quote_count: tweet.public_metrics.quote_count }
        };
        matchedProjects.forEach(project => {
          categorizedPosts[project.name.toUpperCase()].push(postData);
        });
      }
    }

    // Fetch existing posts from DB
    const dbPosts = await Post.find({ userId, createdAt: { $gte: new Date(sevenDaysAgo) } })
      .select('SOL_ID DEV_ID userId username postId content project score blabz likes retweets replies hashtags tweetUrl createdAt tweetType additionalFields')
      .lean();
    dbPosts.forEach(post => {
      if (post.tweetType === 'reply') {
        console.log(`[Debug] Existing post ${post.postId} skipped: is a reply`);
        return;
      }
      const postData = {
        SOL_ID: post.SOL_ID || `TEMP_${username}_${Date.now()}`,
        DEV_ID: post.DEV_ID || `TEMP_${username}_${Date.now()}`,
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
        createdAt: post.createdAt,
        tweetType: post.tweetType,
        additionalFields: post.additionalFields || {}
      };
      post.project.forEach(project => {
        if (categorizedPosts[project]) {
          categorizedPosts[project].push(postData);
        }
      });
    });

    // Remove duplicates and sort
    for (const project in categorizedPosts) {
      const seenPostIds = new Set();
      categorizedPosts[project] = categorizedPosts[project].filter(post => {
        if (seenPostIds.has(post.postId)) return false;
        seenPostIds.add(post.postId);
        return true;
      });
      categorizedPosts[project].sort((a, b) => b.score - a.score);
    }

    // Check if any posts exist
    const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
    if (totalPosts === 0) {
      const errorMessage = tweets && tweets.meta?.result_count
        ? 'No tweets passed the filters (>50 chars, <60% mentions, project match, non-reply)'
        : 'No tweets found for this user in the last 7 days';
      console.log(`[API] ${errorMessage} for ${username}`);
      return res.status(200).json({ message: errorMessage, posts: categorizedPosts });
    }

    // Removed invalidateCache to preserve cache
    console.log(`[API] Returning ${totalPosts} posts for ${username}`);
    res.json({ posts: categorizedPosts });
  } catch (err) {
    console.error('[API] Error in GET /posts/:username:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  }
});

// GET /clear-cache
router.get('/clear-cache', async (req, res) => {
  try {
    await redisClient.flushAll();
    console.log('[Redis] All cache cleared');
    res.json({ clear: 'All Redis cache cleared' });
  } catch (err) {
    console.error('[Redis] Error clearing cache:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /clear-processed
router.get('/clear-processed', async (req, res) => {
  try {
    await ProcessedPost.deleteMany({});
    console.log('[MongoDB] All processed posts cleared');
    res.json({ message: 'Processed posts cleared' });
  } catch (err) {
    console.error('[MongoDB] Error clearing processed posts:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /clear-posts
router.get('/clear-posts', async (req, res) => {
  try {
    await Post.deleteMany({});
    console.log('[MongoDB] All posts cleared');
    res.json({ message: 'All posts cleared' });
  } catch (err) {
    console.error('[MongoDB] Error clearing posts:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /check-processed/:postId
router.get('/check-processed/:postId', async (req, res) => {
  try {
    const post = await ProcessedPost.findOne({ postId: req.params.postId }).lean();
    res.json({ found: !!post, post });
  } catch (err) {
    console.error('[MongoDB] Error checking ProcessedPost:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /check-post/:postId
router.get('/check-post/:postId', async (req, res) => {
  try {
    const post = await Post.findOne({ postId: req.params.postId }).lean();
    res.json({ found: !!post, post });
  } catch (err) {
    console.error('[MongoDB] Error checking Post:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /tweet/:postId
router.get('/tweet/:postId', async (req, res) => {
  try {
    const tweet = await client.v2.singleTweet(req.params.postId, {
      'tweet.fields': ['created_at', 'public_metrics', 'text', 'referenced_tweets']
    });
    res.json(tweet.data || { error: 'Tweet not found' });
  } catch (err) {
    console.error('[Twitter] Error fetching tweet:', err.message);
    res.status(500).json({ error: 'Failed to fetch tweet', details: err.message });
  }
});

// GET /rate-limit-status
router.get('/rate-limit-status', async (req, res) => {
  try {
    res.json({ status: 'Not implemented' });
  } catch (err) {
    console.error('[API] Error in /rate-limit-status:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

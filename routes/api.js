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

// Helper to map userIds to SOL_IDs and DEV_IDs
async function getUserIdMap(userIds) {
  try {
    const users = await User.find({ userId: { $in: userIds } }).select('userId SOL_ID DEV_ID').lean();
    const userIdMap = {};
    users.forEach(user => {
      userIdMap[user.userId] = { SOL_ID: user.SOL_ID || user.userId, DEV_ID: user.DEV_ID || '' };
    });
    return userIdMap;
  } catch (err) {
    console.error('[MongoDB] Error fetching userId map:', err.message);
    return {};
  }
}

// Twitter API delay (2 minutes before each request) with cache fallback on 429
const twitterDelayMiddleware = async (req, res, next) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    console.log('[Twitter Delay] Waiting 120 seconds before next request...');
    await new Promise(resolve => setTimeout(resolve, 120000));
    next();
  } catch (err) {
    console.error('[Twitter Delay] Error:', err.message);
    if (err.code === 429) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
      console.warn('[Twitter Delay] 429 Rate Limit: No cached data available');
      return res.status(429).json({ error: 'Twitter API rate limit exceeded, no cached data available' });
    }
    next();
  }
};

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
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    console.log(`[Cache] Hit for ${cacheKey}`);
    return res.json(JSON.parse(cached));
  }
  console.log(`[Cache] Miss for ${cacheKey}`);
  const originalJson = res.json;
  res.json = async (data) => {
    await redisClient.setEx(cacheKey, 600, JSON.stringify(data)); // 10 minutes
    console.log(`[Cache] Stored for ${cacheKey} (expires in 600 seconds)`);
    return originalJson.call(res, data);
  };
  next();
};

// Invalidate cache
async function invalidateCache(username, project = null) {
  const cacheKeys = [
    `GET:/solcontent/user/${username}`,
    `GET:/solcontent/user-details/${username}`,
    `GET:/solcontent/posts/${username}`,
    `GET:/solcontent/community-feed`
  ];
  if (project) {
    cacheKeys.push(`GET:/solcontent/username/${username}/${project}`);
  }
  cacheKeys.push(`POST:/solcontent/users:${username}`);
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
async function retryRequest(fn, cacheKey, res, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[API] Retry ${i + 1}/${retries}: ${err.message}`);
      if (err.code === 429) {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
          res.json(JSON.parse(cached));
          return null;
        }
        const retryAfter = err.headers?.['retry-after'] || 900;
        console.warn(`[API] 429 Rate Limit: Waiting ${retryAfter} seconds`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
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
  const text = tweet.text;
  try {
    const sentiment = await hf.textClassification({
      model: 'distilbert-base-uncased-finetuned-sst-2-english',
      inputs: text
    });
    const sentimentScore = sentiment[0]?.score || 0.5;
    console.log(`[API] Sentiment analysis for tweet "${text.slice(0, 50)}...": Score=${sentimentScore}`);
    return { sentimentScore };
  } catch (err) {
    console.error('[API] Sentiment analysis error:', err.message);
    if (err.message.includes('An error occurred while fetching the blob')) {
      throw new SkipTweetError('Skipping tweet due to blob fetch error');
    }
    return { sentimentScore: 0.5 };
  }
}

// Calculate quality score (1–100)
function calculateQualityScore(analysis, tweet, followersCount) {
  const sentimentScore = analysis.sentimentScore;
  const lengthScore = Math.min(Math.max((tweet.text.length - 80) / 200, 0), 1);
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

// GET /user/:username
router.get('/user/:username', twitterDelayMiddleware, cacheMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);
    if (mongoose.connection.readyState !== 1) {
      console.error('[MongoDB] Not connected, state:', mongoose.connection.readyState);
      throw new Error('MongoDB not connected');
    }
    let user;
    try {
      user = await retryRequest(
        () => client.v2.userByUsername(req.params.username, {
          'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
        }),
        cacheKey,
        res
      );
      if (!user) return;
      console.log(`[Twitter] User fetched: ${JSON.stringify(user.data)}`);
    } catch (err) {
      console.error('[Twitter] Error fetching user:', err.message);
      return res.status(500).json({ error: 'Failed to fetch user from Twitter API', details: err.message });
    }
    if (!user.data) {
      console.error('[Twitter] User not found');
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;
    const followersCount = user.data.public_metrics.followers_count;
    const userDoc = await User.findOne({ userId }).lean();
    const profile = {
      SOL_ID: userDoc?.SOL_ID || '',
      DEV_ID: userDoc?.DEV_ID || '',
      userId,
      username: user.data.username,
      name: user.data.name,
      profile_image_url: user.data.profile_image_url,
      followers_count: followersCount,
      following_count: user.data.public_metrics.following_count,
      bio: user.data.description || '',
      location: user.data.location || '',
      ...(userDoc?.additionalFields || {})
    };
    let dbProjects;
    try {
      dbProjects = await Project.find().lean();
      console.log(`[MongoDB] Fetched ${dbProjects.length} projects`);
    } catch (err) {
      console.error('[MongoDB] Error fetching projects:', err.message);
      throw err;
    }
    const curatedPosts = { profile, posts: {} };
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    dbProjects.forEach(project => {
      curatedPosts.posts[project.name] = [];
    });
    let tweets;
    try {
      tweets = await retryRequest(
        () => client.v2.userTimeline(userId.toString(), {
          'tweet.fields': ['created_at', 'public_metrics', 'text', 'referenced_tweets'],
          'expansions': ['referenced_tweets.id'],
          exclude: ['retweets'],
          max_results: 100,
          start_time: sevenDaysAgo
        }),
        cacheKey,
        res
      );
      if (!tweets) return;
      console.log(`[Twitter] Fetched ${tweets.meta?.result_count || 0} tweets for user ${req.params.username}`);
    } catch (err) {
      console.error('[Twitter] Error fetching tweets:', err.message, err.data || '');
      return res.status(500).json({ error: 'Failed to fetch tweets from Twitter API', details: err.message });
    }
    if (!tweets.meta.result_count) {
      console.log('[Twitter] No tweets found for user within 7 days');
      return res.json(curatedPosts);
    }
    for await (const tweet of tweets) {
      console.log(`[Debug] Processing tweet ID ${tweet.id}: ${tweet.text.slice(0, 50)}...`);
      if (tweet.text.length < 81) {
        console.log(`[Debug] Tweet ${tweet.id} skipped: too short (${tweet.text.length} characters)`);
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (too short)`);
        } catch (err) {
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        continue;
      }
      const mentionChars = extractMentions(tweet.text);
      const totalChars = tweet.text.length;
      const mentionRatio = mentionChars / totalChars;
      const nonMentionText = tweet.text.replace(/@(\w+)/g, '').replace(/\s+/g, ' ').trim();
      if (mentionRatio > 0.5 || nonMentionText.length < 10) {
        console.log(`[Debug] Tweet ${tweet.id} skipped: mention-heavy (ratio=${mentionRatio.toFixed(2)}, non-mention text="${nonMentionText}" (${nonMentionText.length} chars))`);
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (mention-heavy)`);
        } catch (err) {
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        continue;
      }
      let tweetType = 'main';
      if (tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
        const refTweet = tweet.referenced_tweets[0];
        if (refTweet.type === 'replied_to') {
          tweetType = 'reply';
        } else if (refTweet.type === 'quoted') {
          tweetType = 'quote';
        }
      }
      console.log(`[Debug] Tweet ${tweet.id} type: ${tweetType}`);
      let processedPost, existingPost;
      try {
        processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean();
        existingPost = await Post.findOne({ postId: tweet.id }).lean();
        console.log(`[MongoDB] ProcessedPost exists: ${!!processedPost}, Post exists: ${!!existingPost}`);
      } catch (err) {
        console.error('[MongoDB] Error checking posts:', err.message);
        continue;
      }
      if (processedPost) {
        console.log(`[Debug] Tweet already processed: ${tweet.id}`);
        continue;
      }
      const text = tweet.text.toLowerCase();
      const matchedProjects = [];
      for (const project of dbProjects) {
        const projectName = project.name.toLowerCase();
        const projectUsername = `@${req.params.username.toLowerCase()}`;
        const projectKeywords = (project.keywords || []).map(k => k.toLowerCase());
        const queryTerms = [projectName, projectUsername, ...projectKeywords];
        let matchesProject = false;
        if (tweetType === 'reply') {
          matchesProject = projectKeywords.some(keyword => text.includes(keyword.toLowerCase()));
        } else {
          const matchesTag = queryTerms.some(term => 
            text.includes(term.toLowerCase()) || 
            text.includes(`@${term.toLowerCase().replace('@', '')}`)
          );
          const matchesKeyword = projectKeywords.some(keyword => 
            text.includes(keyword.toLowerCase())
          );
          matchesProject = matchesTag || matchesKeyword;
        }
        if (matchesProject) {
          matchedProjects.push(project.name.toUpperCase());
        }
      }
      if (matchedProjects.length === 0) {
        console.log(`[Debug] Tweet ${tweet.id} skipped: no project ${tweetType === 'reply' ? 'keyword' : 'tag or keyword'}`);
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (no match)`);
        } catch (err) {
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        continue;
      }
      let analysis;
      try {
        analysis = await analyzeContentForScoring(tweet);
        console.log(`[Debug] Scoring analysis result: ${JSON.stringify(analysis)}`);
      } catch (err) {
        if (err.name === 'SkipTweetError') {
          console.log(`[Debug] Tweet ${tweet.id} skipped: ${err.message}`);
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
            console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (sentiment error)`);
          } catch (saveErr) {
            console.error('[MongoDB] Error saving ProcessedPost:', saveErr.message);
          }
          continue;
        }
        console.error('[HuggingFace] Error in scoring analysis:', err.message);
        analysis = { sentimentScore: 0.5 };
      }
      const qualityScore = calculateQualityScore(analysis, tweet, followersCount);
      const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
      const totalBlabz = (projectBlabz * matchedProjects.length).toFixed(4);
      console.log(`[Debug] Quality score: ${qualityScore}, Project Blabz: ${projectBlabz}, Total Blabz: ${totalBlabz}, Projects: ${matchedProjects.join(', ')}`);
      if (!existingPost) {
        try {
          const post = new Post({
            SOL_ID: userDoc?.SOL_ID || '',
            DEV_ID: userDoc?.DEV_ID || '',
            userId,
            username: user.data.username,
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
            tweetUrl: `https://x.com/${user.data.username}/status/${tweet.id}`,
            createdAt: tweet.created_at,
            tweetType,
            additionalFields: {
              quote_count: tweet.public_metrics.quote_count
            }
          });
          await post.save();
          console.log(`[MongoDB] Saved post to DB for projects ${matchedProjects.join(', ')}, postId: ${tweet.id}, tweetUrl: ${post.tweetUrl}, totalBlabz: ${totalBlabz}, type: ${tweetType}`);
        } catch (err) {
          if (err.code === 11000) {
            console.warn(`[MongoDB] Duplicate post detected for postId ${tweet.id}`);
          } else {
            console.error('[MongoDB] Error saving Post:', err.message);
          }
          continue;
        }
      } else {
        console.log(`[Debug] Found existing post for projects ${existingPost.project.join(', ')}`);
      }
      try {
        await new ProcessedPost({ postId: tweet.id }).save();
        console.log(`[MongoDB] Marked tweet ${tweet.id} as processed`);
      } catch (err) {
        if (err.code === 11000) {
          console.warn(`[MongoDB] Duplicate processed post detected for postId ${tweet.id}`);
        } else {
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        continue;
      }
      const postData = {
        SOL_ID: userDoc?.SOL_ID || '',
        DEV_ID: userDoc?.DEV_ID || '',
        userId,
        username: user.data.username,
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
        tweetUrl: `https://x.com/${user.data.username}/status/${tweet.id}`,
        createdAt: tweet.created_at,
        tweetType,
        additionalFields: {
          quote_count: tweet.public_metrics.quote_count
        }
      };
      matchedProjects.forEach(project => {
        curatedPosts.posts[project].push(postData);
      });
      for (const project of matchedProjects) {
        try {
          await invalidateCache(req.params.username, project);
        } catch (err) {
          console.error('[Redis] Error invalidating cache:', err.message);
        }
      }
    }
    for (const project in curatedPosts.posts) {
      curatedPosts.posts[project].sort((a, b) => b.score - a.score);
    }
    console.log(`[Debug] Final response: ${JSON.stringify(curatedPosts, null, 2)}`);
    res.json(curatedPosts);
  } catch (err) {
    console.error('[API] Error in /user:', err.message, err.stack);
    if (err.code === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (err.code === 429) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
      return res.status(429).json({ error: 'Twitter API rate limit exceeded, no cached data available' });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /posts/:username
router.get('/posts/:username', cacheMiddleware, async (req, res) => {
  try {
    const { username } = req.params;
    const user = await User.findOne({ username }).lean();
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const posts = await Post.find({ userId: user.userId })
      .select('SOL_ID DEV_ID userId username postId content project projects score blabz likes retweets replies hashtags tweetUrl createdAt tweetType additionalFields')
      .lean();
    res.json({ posts });
  } catch (err) {
    console.error('[API] Error in GET /posts/:username:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /community-feed
router.get('/community-feed', cacheMiddleware, async (req, res) => {
  try {
    console.log('[API] Fetching community feed');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    console.log(`[Debug] Querying posts created after: ${sevenDaysAgo.toLocaleString('en-US', { timeZone: 'Africa/Lagos' })} WAT`);
    const posts = await Post.find({
      createdAt: { $gte: sevenDaysAgo }
    })
      .sort({ score: -1 })
      .limit(100)
      .lean();
    const totalPosts = await Post.countDocuments();
    const recentPostsCount = await Post.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
    console.log(`[Debug] Total posts in DB: ${totalPosts}, Posts in last 7 days: ${recentPostsCount}, Returned posts: ${posts.length}`);
    if (posts.length === 0) {
      console.warn('[Debug] Community feed empty. Possible reasons:');
      console.warn('  - No tweets saved in Post collection for last 7 days');
      console.warn('  - Tweets filtered out (e.g., <81 chars, mentions >50%, non-mention text <10 chars, no project tag/keyword for main/quote or keyword for reply)');
      console.warn('  - Tweets marked as processed without saving to Post');
    }
    const userIds = [...new Set(posts.map(post => post.userId))];
    const userIdMap = await getUserIdMap(userIds);
    const communityFeed = posts.map(post => ({
      SOL_ID: userIdMap[post.userId]?.SOL_ID || post.userId,
      DEV_ID: userIdMap[post.userId]?.DEV_ID || '',
      userId: post.userId,
      username: post.username || 'Unknown',
      project: post.project,
      projects: post.projects,
      content: post.content,
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
    }));
    res.json({ posts: communityFeed });
  } catch (err) {
    console.error('[API] Error in /community-feed:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /username/:username/:project
router.get('/username/:username/:project', twitterDelayMiddleware, cacheMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    console.log(`[API] Fetching posts for user: ${req.params.username}, project: ${req.params.project}`);
    if (mongoose.connection.readyState !== 1) {
      console.error('[MongoDB] Not connected, state:', mongoose.connection.readyState);
      throw new Error('MongoDB not connected');
    }
    let user;
    try {
      user = await retryRequest(
        () => client.v2.userByUsername(req.params.username, {
          'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
        }),
        cacheKey,
        res
      );
      if (!user) return;
      console.log(`[Twitter] User fetched: ${JSON.stringify(user.data)}`);
    } catch (err) {
      console.error('[Twitter] Error fetching user:', err.message);
      return res.status(500).json({ error: 'Failed to fetch user', details: err.message });
    }
    if (!user.data) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;
    const userDoc = await User.findOne({ userId }).lean();
    const profile = {
      SOL_ID: userDoc?.SOL_ID || '',
      DEV_ID: userDoc?.DEV_ID || '',
      userId,
      username: user.data.username,
      name: user.data.name,
      profile_image_url: user.data.profile_image_url,
      followers_count: user.data.public_metrics.followers_count,
      following_count: user.data.public_metrics.following_count,
      bio: user.data.description || '',
      location: user.data.location || '',
      ...(userDoc?.additionalFields || {})
    };
    let project;
    try {
      project = await Project.findOne({ name: req.params.project.toUpperCase() }).lean();
      console.log(`[MongoDB] Project query result: ${JSON.stringify(project)}`);
    } catch (err) {
      console.error('[MongoDB] Error fetching project:', err.message);
      throw err;
    }
    if (!project) {
      console.error('[MongoDB] Project not found:', req.params.project.toUpperCase());
      return res.status(404).json({ error: 'Project not found' });
    }
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const posts = await Post.find({
      userId,
      project: req.params.project.toUpperCase(),
      createdAt: { $gte: sevenDaysAgo }
    })
      .sort({ score: -1 })
      .limit(50)
      .lean();
    console.log(`[MongoDB] Fetched ${posts.length} posts for user ${req.params.username}, project ${req.params.project}`);
    const userIdMap = await getUserIdMap([userId]);
    const curatedPosts = {
      profile,
      posts: posts.map(post => ({
        SOL_ID: userIdMap[post.userId]?.SOL_ID || post.userId,
        DEV_ID: userIdMap[post.userId]?.DEV_ID || '',
        userId: post.userId,
        username: post.username || 'Unknown',
        content: post.content,
        project: post.project,
        projects: post.projects,
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
      }))
    };
    console.log(`[Debug] Final response: ${JSON.stringify(curatedPosts, null, 2)}`);
    res.json(curatedPosts);
  } catch (err) {
    console.error('[API] Error in /username/:username/:project:', err.message, err.stack);
    if (err.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (err.status === 429) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
      return res.status(429).json({ error: 'Twitter API rate limit exceeded, no cached data available' });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /project/:project
router.get('/project/:project', cacheMiddleware, async (req, res) => {
  try {
    console.log(`[API] Fetching posts for project: ${req.params.project}`);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const posts = await Post.find({
      project: req.params.project.toUpperCase(),
      createdAt: { $gte: sevenDaysAgo }
    })
      .sort({ score: -1 })
      .limit(50)
      .lean();
    console.log(`[MongoDB] Fetched ${posts.length} posts for project ${req.params.project}`);
    const userIds = [...new Set(posts.map(post => post.userId))];
    const userIdMap = await getUserIdMap(userIds);
    res.json({
      posts: posts.map(post => ({
        SOL_ID: userIdMap[post.userId]?.SOL_ID || post.userId,
        DEV_ID: userIdMap[post.userId]?.DEV_ID || '',
        userId: post.userId,
        username: post.username || 'Unknown',
        content: post.content,
        project: post.project,
        projects: post.projects,
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
      }))
    });
  } catch (err) {
    console.error('[API] Error in /project/:project:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /project-stats/:project
router.get('/project-stats/:project', cacheMiddleware, async (req, res) => {
  try {
    console.log(`[API] Fetching stats for project: ${req.params.project}`);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const posts = await Post.find({
      project: req.params.project.toUpperCase(),
      createdAt: { $gte: sevenDaysAgo }
    }).lean();
    const userIds = [...new Set(posts.map(post => post.userId))];
    const userIdMap = await getUserIdMap(userIds);
    const postsWithUserId = posts.map(post => ({
      ...post,
      SOL_ID: userIdMap[post.userId]?.SOL_ID || post.userId,
      DEV_ID: userIdMap[post.userId]?.DEV_ID || ''
    }));
    const stats = {
      project: req.params.project.toUpperCase(),
      postCount: postsWithUserId.length,
      totalBlabz: postsWithUserId.reduce((sum, post) => {
        const projectEntry = post.projects.find(p => p.project === req.params.project.toUpperCase());
        return sum + (projectEntry ? parseFloat(projectEntry.blabz) : 0);
      }, 0).toFixed(4),
      totalScore: postsWithUserId.reduce((sum, post) => sum + post.score, 0),
      totalLikes: postsWithUserId.reduce((sum, post) => sum + post.likes, 0),
      totalRetweets: postsWithUserId.reduce((sum, post) => sum + post.retweets, 0),
      totalReplies: postsWithUserId.reduce((sum, post) => sum + post.replies, 0),
      totalQuotes: postsWithUserId.reduce((sum, post) => sum + (post.additionalFields?.quote_count || 0), 0)
    };
    console.log(`[Debug] Project stats: ${JSON.stringify(stats)}`);
    res.json(stats);
  } catch (err) {
    console.error('[API] Error in /project-stats/:project:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /rate-limit-status
router.get('/rate-limit-status', async (req, res) => {
  try {
    res.json({});
  } catch (err) {
    console.error('[API] Error in /rate-limit-status:', err.message);
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
    const project = await Project.findOneAndUpdate(
      { name: name.toUpperCase() },
      { name: name.toUpperCase(), keywords, description, website, ...attributes },
      { upsert: true, new: true }
    );
    res.json({ message: `Project ${name.toLowerCase()} added`, project });
  } catch (err) {
    console.error('[API] Error adding project:', err.message);
    res.status(400).json({ error: 'Server error', details: err.message });
  }
});

// GET /projects
router.get('/projects', cacheMiddleware, async (req, res) => {
  try {
    const projects = await Project.find().lean();
    res.json(projects);
  } catch (err) {
    console.error('[API] Error fetching projects:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// PUT /user/:username
router.put('/user/:username', cacheMiddleware, async (req, res) => {
  try {
    const fields = req.body;
    if (fields.SOL_ID) {
      if (!isValidSolanaAddress(fields.SOL_ID)) {
        return res.status(400).json({ error: 'Invalid SOL_ID format' });
      }
      const existingUser = await User.findOne({ SOL_ID: fields.SOL_ID, username: { $ne: req.params.username } });
      if (existingUser) {
        return res.status(400).json({ error: 'SOL_ID already in use by another user' });
      }
    }
    if (fields.DEV_ID) {
      if (!isValidDevId(fields.DEV_ID)) {
        return res.status(400).json({ error: 'Invalid DEV_ID format' });
      }
      const existingUser = await User.findOne({ DEV_ID: fields.DEV_ID, username: { $ne: req.params.username } });
      if (existingUser) {
        return res.status(400).json({ error: 'DEV_ID already in use by another user' });
      }
    }
    const user = await User.findOneAndUpdate(
      { username: req.params.username },
      { $set: fields },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    console.log(`[MongoDB] User ${req.params.username} updated`);
    await invalidateCache(req.params.username);
    res.json({ message: `User ${req.params.username} updated`, user });
  } catch (err) {
    console.error('[API] Error updating user:', err.message);
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Duplicate SOL_ID, DEV_ID, or username' });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// PUT /project/:project
router.put('/project/:project', cacheMiddleware, async (req, res) => {
  try {
    const fields = req.body;
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

// POST /user/:username
router.post('/user/:username', cacheMiddleware, async (req, res) => {
  req.method = 'GET';
  return router.handle(req, res);
});

// GET /user-details/:username
router.get('/user-details/:username', twitterDelayMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    console.log(`[API] Fetching user details for: ${req.params.username}`);
    const user = await retryRequest(
      () => client.v2.userByUsername(req.params.username, {
        'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'created_at', 'location']
      }),
      cacheKey,
      res
    );
    if (!user) return;
    if (!user.data) {
      console.error('[Twitter] User not found');
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;
    const userDoc = await User.findOne({ userId }).lean();
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
    console.error('[API] Error in /user-details/:username:', err.message, err.stack);
    if (err.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (err.status === 429) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
        return res.json(JSON.parse(cached));
      }
      return res.status(429).json({ error: 'Twitter API rate limit exceeded, no cached data available' });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
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
router.get('/tweet/:postId', twitterDelayMiddleware, async (req, res) => {
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

// POST /populate-community-posts
router.post('/populate-community-posts', twitterDelayMiddleware, async (req, res) => {
  try {
    console.log('[API] Populating community posts for all users and projects...');

    const users = await User.find().select('userId username SOL_ID DEV_ID').lean();
    if (!users.length) {
      console.warn('[MongoDB] No users found in User collection');
      return res.status(404).json({ error: 'No users found' });
    }
    console.log(`[MongoDB] Found ${users.length} users`);

    const dbProjects = await Project.find().lean();
    if (!dbProjects.length) {
      console.warn('[MongoDB] No projects found in Project collection');
      return res.status(404).json({ error: 'No projects found' });
    }
    console.log(`[MongoDB] Found ${dbProjects.length} projects`);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let totalPostsSaved = 0;

    for (const user of users) {
      const { userId, username, SOL_ID, DEV_ID } = user;
      console.log(`[API] Processing user: ${username} (userId: ${userId})`);

      let tweets;
      const cacheKey = `GET:/solcontent/user/${username}`;
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
        if (!tweets) continue;
        console.log(`[Twitter] Fetched ${tweets.meta?.result_count || 0} tweets for user ${username}`);
      } catch (err) {
        console.error(`[Twitter] Error fetching tweets for ${username}:`, err.message);
        continue;
      }

      if (!tweets.meta.result_count) {
        console.log(`[Twitter] No tweets found for user ${username} within 7 days`);
        continue;
      }

      let twitterUser;
      try {
        twitterUser = await client.v2.userByUsername(username, {
          'user.fields': ['public_metrics']
        });
        if (!twitterUser.data) throw new Error('User not found');
      } catch (err) {
        console.error(`[Twitter] Error fetching profile for ${username}:`, err.message);
        continue;
      }
      const followersCount = twitterUser.data.public_metrics?.followers_count || 0;

      for await (const tweet of tweets) {
        console.log(`[Debug] Processing tweet ID ${tweet.id}: ${tweet.text.slice(0, 50)}...`);

        if (tweet.text.length < 81) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: too short (${tweet.text.length} characters)`);
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
            console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (too short)`);
          } catch (err) {
            if (err.code === 11000) {
              console.log(`[MongoDB] Tweet ${tweet.id} already processed (too short)`);
            } else {
              console.error('[MongoDB] Error saving ProcessedPost:', err.message);
            }
          }
          continue;
        }

        const mentionChars = extractMentions(tweet.text);
        const totalChars = tweet.text.length;
        const mentionRatio = mentionChars / totalChars;
        const nonMentionText = tweet.text.replace(/@(\w+)/g, '').replace(/\s+/g, ' ').trim();
        if (mentionRatio > 0.5 || nonMentionText.length < 10) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: mention-heavy (ratio=${mentionRatio.toFixed(2)})`);
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
            console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (mention-heavy)`);
          } catch (err) {
            if (err.code === 11000) {
              console.log(`[MongoDB] Tweet ${tweet.id} already processed (mention-heavy)`);
            } else {
              console.error('[MongoDB] Error saving ProcessedPost:', err.message);
            }
          }
          continue;
        }

        let tweetType = 'main';
        if (tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
          const refTweet = tweet.referenced_tweets[0];
          if (refTweet.type === 'replied_to') tweetType = 'reply';
          else if (refTweet.type === 'quoted') tweetType = 'quote';
        }

        const processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean();
        const existingPost = await Post.findOne({ postId: tweet.id }).lean();
        if (processedPost) {
          console.log(`[Debug] Tweet ${tweet.id} already processed`);
          continue;
        }

        const text = tweet.text.toLowerCase();
        const matchedProjects = [];
        for (const project of dbProjects) {
          const projectName = project.name.toLowerCase();
          const projectUsername = `@${username.toLowerCase()}`;
          const projectKeywords = (project.keywords || []).map(k => k.toLowerCase());
          const queryTerms = [projectName, projectUsername, ...projectKeywords];
          let matchesProject = false;
          if (tweetType === 'reply') {
            matchesProject = projectKeywords.some(keyword => text.includes(keyword.toLowerCase()));
          } else {
            const matchesTag = queryTerms.some(term => 
              text.includes(term.toLowerCase()) || 
              text.includes(`@${term.toLowerCase().replace('@', '')}`)
            );
            const matchesKeyword = projectKeywords.some(keyword => 
              text.includes(keyword.toLowerCase())
            );
            matchesProject = matchesTag || matchesKeyword;
          }
          if (matchesProject) {
            matchedProjects.push(project.name.toUpperCase());
          }
        }

        if (matchedProjects.length === 0) {
          console.log(`[Debug] Tweet ${tweet.id} skipped: no project match`);
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
            console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (no match)`);
          } catch (err) {
            if (err.code === 11000) {
              console.log(`[MongoDB] Tweet ${tweet.id} already processed (no match)`);
            } else {
              console.error('[MongoDB] Error saving ProcessedPost:', err.message);
            }
          }
          continue;
        }

        let analysis;
        try {
          analysis = await analyzeContentForScoring(tweet);
        } catch (err) {
          if (err.name === 'SkipTweetError') {
            console.log(`[Debug] Tweet ${tweet.id} skipped: ${err.message}`);
            try {
              await new ProcessedPost({ postId: tweet.id }).save();
              console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (sentiment error)`);
            } catch (saveErr) {
              if (saveErr.code === 11000) {
                console.log(`[MongoDB] Tweet ${tweet.id} already processed (sentiment error)`);
              } else {
                console.error('[MongoDB] Error saving ProcessedPost:', saveErr.message);
              }
            }
            continue;
          }
          console.error('[HuggingFace] Error in scoring:', err.message);
          analysis = { sentimentScore: 0.5 };
        }

        const qualityScore = calculateQualityScore(analysis, tweet, followersCount);
        const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
        const totalBlabz = (projectBlabz * matchedProjects.length).toFixed(4);

        if (!existingPost) {
          try {
            const post = new Post({
              SOL_ID: SOL_ID || userId,
              DEV_ID: DEV_ID || '',
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
              createdAt: tweet.created_at,
              tweetType,
              additionalFields: {
                quote_count: tweet.public_metrics.quote_count
              }
            });
            await post.save();
            console.log(`[MongoDB] Saved post for ${username}, projects: ${matchedProjects.join(', ')}, postId: ${tweet.id}`);
            totalPostsSaved++;
          } catch (err) {
            if (err.code === 11000) {
              console.warn(`[MongoDB] Duplicate post detected for postId ${tweet.id}`);
            } else {
              console.error('[MongoDB] Error saving Post:', err.message);
            }
            continue;
          }
        }

        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed`);
        } catch (err) {
          if (err.code === 11000) {
            console.log(`[MongoDB] Tweet ${tweet.id} already processed`);
          } else {
            console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
        }

        try {
          await invalidateCache(username);
        } catch (err) {
          console.error('[Redis] Error invalidating cache:', err.message);
        }
      }
    }

    console.log(`[API] Populated ${totalPostsSaved} new posts`);
    res.json({ message: `Populated ${totalPostsSaved} new community posts` });
  } catch (err) {
    console.error('[API] Error in /populate-community-posts:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

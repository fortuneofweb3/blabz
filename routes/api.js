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
      return res.json(JSON.parse(cached));
    }
    console.log(`[Cache] Miss for ${cacheKey}`);
    const originalJson = res.json;
    res.json = async (data) => {
      if (res.headersSent) {
        console.warn(`[Cache] Headers already sent for ${cacheKey}, skipping cache storage`);
        return originalJson.call(res, data);
      }
      await redisClient.setEx(cacheKey, 600, JSON.stringify(data)); // 10 minutes
      console.log(`[Cache] Stored for ${cacheKey} (expires in 600 seconds)`);
      return originalJson.call(res, data);
    };
    next();
  } catch (err) {
    console.error(`[Cache] Error in cacheMiddleware for ${cacheKey}:`, err.message);
    next();
  }
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

// Retry logic for Twitter API (single attempt, no retries)
async function retryRequest(fn, cacheKey, res) {
  try {
    console.log(`[API] Attempt 1/1 for ${cacheKey}`);
    const result = await fn();
    return result;
  } catch (err) {
    console.error(`[API] Failed for ${cacheKey}: ${err.message}`);
    if (err.code === 429 || (err.errors && err.errors.some(e => e.title === 'Too Many Requests'))) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          console.log(`[Cache] Serving cached response due to 429 for ${cacheKey}`);
          res.json(JSON.parse(cached));
          return null;
        }
        console.log(`[Cache] No cache found for ${cacheKey}, returning empty data`);
        res.json({});
        return null;
      } catch (cacheErr) {
        console.error(`[Cache] Error accessing cache for ${cacheKey}:`, cacheErr.message);
        res.status(500).json({ error: 'Cache error during rate limit', details: cacheErr.message });
        return null;
      }
    }
    throw err;
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
  console.log(`[API] Bypassing sentiment analysis for tweet "${text.slice(0, 50)}...": Defaulting to score=0.5`);
  return { sentimentScore: 0.5 }; // Bypass HuggingFace due to blob fetch errors
}

// Calculate quality score (1–100)
function calculateQualityScore(analysis, tweet, followersCount) {
  const sentimentScore = analysis.sentimentScore;
  const lengthScore = Math.min(Math.max((tweet.text.length - 50) / 200, 0), 1);
  const { like_count, retweet_count, quote_count } = tweet.public_metrics || {};
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

// GET /posts/:username
router.get('/posts/:username', cacheMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    const { username } = req.params;
    console.log(`[API] Fetching posts for user: ${username}`);

    // Check if user exists
    const userDoc = await User.findOne({ username }).lean();
    if (!userDoc) {
      return res.status(404).json({ error: 'User not found in database. Please register user via POST /users.' });
    }
    const userId = userDoc.userId;

    // Fetch projects
    const dbProjects = await Project.find().lean();
    if (!dbProjects.length) {
      console.warn('[MongoDB] No projects found');
      return res.status(404).json({ error: 'No projects configured in database' });
    }

    // Initialize categorized posts
    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });

    // Fetch existing posts from DB (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dbPosts = await Post.find({ userId, createdAt: { $gte: sevenDaysAgo } })
      .select('SOL_ID DEV_ID userId username postId content project score blabz likes retweets replies hashtags tweetUrl createdAt tweetType additionalFields')
      .lean();

    dbPosts.forEach(post => {
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

    // Remove duplicates by postId within each project
    for (const project in categorizedPosts) {
      const seenPostIds = new Set();
      categorizedPosts[project] = categorizedPosts[project].filter(post => {
        if (seenPostIds.has(post.postId)) return false;
        seenPostIds.add(post.postId);
        return true;
      });
      // Sort by score descending
      categorizedPosts[project].sort((a, b) => b.score - a.score);
    }

    // Check if any posts exist
    const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
    if (totalPosts === 0) {
      const errorMessage = 'No posts found for this user in the last 7 days in database.';
      return res.status(200).json({ message: errorMessage, posts: categorizedPosts });
    }

    // Invalidate cache
    try {
      await invalidateCache(username);
    } catch (err) {
      console.error('[Redis] Error invalidating cache:', err.message);
    }

    console.log(`[API] Returning ${totalPosts} posts for ${username}, categorized by project from MongoDB`);
    res.json({ posts: categorizedPosts });
  } catch (err) {
    console.error('[API] Error in GET /posts/:username:', err.message, err.stack);
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
    res.json({});
  } catch (err) {
    console.error('[API] Error in /rate-limit-status:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

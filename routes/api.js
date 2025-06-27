const express = require('express');
const cors = require('cors');
const redis = require('redis');
const Queue = require('bull');
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

const twitterQueue = new Queue('twitter-api', process.env.REDIS_URL || 'redis://localhost:6379');

if (!process.env.X_BEARER_TOKEN || !process.env.MONGODB_URI) {
  console.error('[API] Error: Missing required environment variables');
  throw new Error('Missing required environment variables');
}
const client = new TwitterApi(process.env.X_BEARER_TOKEN);
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY || '');

router.use(cors());

class SkipTweetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipTweetError';
  }
}

const cacheMiddleware = async (req, res, next) => {
  let cacheKey = req.method + ':' + req.originalUrl;
  if (req.method === 'POST' && req.originalUrl === '/solcontent/users') {
    const bodyHash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex');
    cacheKey = cacheKey + ':' + bodyHash;
  }
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    console.log('[Cache] Hit for ' + cacheKey);
    res.setHeader('X-Cache-Hit', 'true');
    return res.json(JSON.parse(cached));
  }
  res.locals.cacheKey = cacheKey;
  next();
};

async function invalidateCache(username) {
  const cacheKeys = [
    'GET:/solcontent/user-details/' + username,
    'GET:/solcontent/posts/' + username,
    'POST:/solcontent/users:' + username
  ];
  for (const cacheKey of cacheKeys) {
    const keys = await redisClient.keys(cacheKey + '*');
    for (const key of keys) {
      await redisClient.del(key);
    }
  }
}

async function retryRequest(fn, cacheKey, res, retries = 3, delay = 1000) {
  const job = await twitterQueue.add({ fn: fn.toString(), cacheKey }, {
    attempts: retries,
    backoff: { type: 'fixed', delay }
  });
  try {
    const result = await job.finished();
    if (result) {
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
      if (!res.headersSent) {
        res.setHeader('X-Cache-Hit', 'false');
        res.json(result);
      }
      return result;
    }
  } catch (err) {
    if (err.code === 429) {
      const cached = await redisClient.get(cacheKey);
      if (cached && !res.headersSent) {
        console.log('[Cache] Serving cached response due to 429 for ' + cacheKey);
        res.setHeader('X-Cache-Hit', 'true');
        res.json(JSON.parse(cached));
        return null;
      }
      const retryAfter = err.headers?.['x-rate-limit-reset']
        ? Math.max((parseInt(err.headers['x-rate-limit-reset']) * 1000 - Date.now()) / 1000, 1)
        : 120;
      console.log(`[API] 429 Rate Limit: Waiting ${retryAfter} seconds`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
    }
    if (!res.headersSent) {
      res.status(500).json({ error: 'Request failed after retries', details: err.message });
    }
    return null;
  }
  if (!res.headersSent) {
    res.status(500).json({ error: 'No response generated after retries' });
  }
  return null;
}

function isValidSolanaAddress(address) {
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return base58Regex.test(address);
}

function isValidDevId(devId) {
  const devIdRegex = /^[a-zA-Z0-9_-]{8,64}$/;
  return devIdRegex.test(devId);
}

function extractHashtags(text) {
  const hashtagRegex = /#(\w+)/g;
  const hashtags = [];
  let match;
  while ((match = hashtagRegex.exec(text)) !== null) {
    hashtags.push(match[1]);
  }
  return hashtags;
}

function extractMentions(text) {
  const mentionRegex = /@(\w+)/g;
  let mentionChars = 0;
  let match;
  while ((match = mentionRegex.exec(text)) !== null) {
    mentionChars += match[0].length;
  }
  return mentionChars;
}

async function analyzeContentForScoring(tweet) {
  return { sentimentScore: 0.5 };
}

function calculateQualityScore(analysis, tweet, followersCount) {
  const sentimentScore = analysis.sentimentScore;
  const lengthScore = Math.min(Math.max((tweet.text.length - 50) / 200, 0), 1);
  const { like_count, retweet_count, quote_count } = tweet.public_metrics;
  const engagementRaw = like_count + 2 * retweet_count + 3 * quote_count;
  const engagementScore = Math.min(engagementRaw / Math.max(1, followersCount), 1);
  const combinedScore = 0.5 * sentimentScore + 0.25 * lengthScore + 0.25 * engagementScore;
  return Math.round(combinedScore * 99) + 1;
}

function calculateBlabzPerProject(qualityScore) {
  return (qualityScore / 300).toFixed(4);
}

router.post('/users', cacheMiddleware, async (req, res) => {
  try {
    const { username, SOL_ID, DEV_ID } = req.body;
    if (!username || !SOL_ID || !DEV_ID) {
      return res.status(400).json({ error: 'username, SOL_ID, and DEV_ID are required' });
    }
    if (!isValidSolanaAddress(SOL_ID)) {
      return res.status(400).json({ error: 'Invalid SOL_ID format' });
    }
    if (!isValidDevId(DEV_ID)) {
      return res.status(400).json({ error: 'Invalid DEV_ID format' });
    }
    let twitterUser = await retryRequest(
      () => client.v2.userByUsername(username, { 'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location', 'created_at'] }),
      'GET:/solcontent/user-details/' + username,
      res
    );
    if (!twitterUser) return;
    if (!twitterUser.data) {
      return res.status(404).json({ error: 'Twitter user not found' });
    }
    const user = await User.findOneAndUpdate(
      { username },
      {
        $set: {
          SOL_ID,
          DEV_ID,
          userId: twitterUser.data.id,
          username: twitterUser.data.username,
          name: twitterUser.data.name || '',
          profile_image_url: twitterUser.data.profile_image_url || '',
          followers_count: twitterUser.data.public_metrics?.followers_count || 0,
          following_count: twitterUser.data.public_metrics?.following_count || 0,
          bio: twitterUser.data.description || '',
          location: twitterUser.data.location || '',
          created_at: twitterUser.data.created_at ? new Date(twitterUser.data.created_at) : undefined,
          additionalFields: {}
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await invalidateCache(username);
    res.json({ message: 'User saved', user });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Duplicate key error' });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/user-details/:username', cacheMiddleware, async (req, res) => {
  try {
    const user = await retryRequest(
      () => client.v2.userByUsername(req.params.username, { 'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'created_at', 'location'] }),
      'GET:/solcontent/user-details/' + req.params.username,
      res
    );
    if (!user) return;
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
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.post('/projects', cacheMiddleware, async (req, res) => {
  try {
    const { name, keywords, description, website, additionalProjectFields } = req.body;
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
        additionalProjectFields: additionalProjectFields || {}
      },
      { upsert: true, new: true }
    );
    res.json({ message: 'Project added', project });
  } catch (err) {
    res.status(400).json({ error: 'Server error', details: err.message });
  }
});

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
    res.json({ message: 'Project updated', project });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

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
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

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
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/projects/:project/verification', cacheMiddleware, async (req, res) => {
  try {
    const project = await Project.findOne({ name: req.params.project.toUpperCase() }).lean();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ name: project.name, verified: project.verified });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/projects/verified', cacheMiddleware, async (req, res) => {
  try {
    const verifiedProjects = await Project.find({ verified: true }).lean();
    res.json({ projects: verifiedProjects });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/posts/:username', cacheMiddleware, async (req, res) => {
  const cacheKey = 'GET:/solcontent/posts/' + req.params.username;
  try {
    const { username } = req.params;
    console.log('[API] Fetching posts for user:', username);
    const userDoc = await User.findOne({ username }).lean();
    if (!userDoc) {
      return res.status(404).json({ error: 'User not found in database' });
    }
    let twitterUser = await retryRequest(
      () => client.v2.userByUsername(username, { 'user.fields': ['id', 'public_metrics'] }),
      cacheKey + ':user',
      res
    );
    if (!twitterUser) return;
    if (!twitterUser.data) {
      return res.status(404).json({ error: 'Twitter user not found' });
    }
    const userId = twitterUser.data.id;
    const posts = await Post.find({ userId }).lean();
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

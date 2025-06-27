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
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log('[Cache] Hit for ' + cacheKey);
      res.setHeader('Content-Type', 'application/json');
      res.end(cached); // Use res.end to avoid multiple header sets
      return;
    }
  } catch (err) {
    console.error('[Cache] Error:', err.message);
  }
  const originalJson = res.json;
  res.json = async (data) => {
    try {
      await redisClient.setEx(cacheKey, 3600, JSON.stringify(data));
      return originalJson.call(res, data);
    } catch (err) {
      console.error('[Cache] Error storing:', err.message);
      return originalJson.call(res, data);
    }
  };
  next();
};

async function invalidateCache(username) {
  const cacheKeys = [
    'GET:/solcontent/user-details/' + username,
    'GET:/solcontent/posts/' + username,
    'POST:/solcontent/users:' + username
  ];
  try {
    for (const cacheKey of cacheKeys) {
      const keys = await redisClient.keys(cacheKey + '*');
      for (const key of keys) {
        await redisClient.del(key);
      }
    }
  } catch (err) {
    console.error('[Cache] Invalidate error:', err.message);
  }
}

async function retryRequest(fn, cacheKey, res, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fn();
      if (result) {
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(result));
        if (!res.headersSent) {
          res.json(result);
        }
        return result;
      }
      continue;
    } catch (err) {
      if (err.code === 429) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached && !res.headersSent) {
            console.log('[Cache] Serving cached response due to 429 for ' + cacheKey);
            res.setHeader('Content-Type', 'application/json');
            res.end(cached);
            return null;
          }
          const retryAfter = err.headers?.['x-rate-limit-reset']
            ? Math.max((parseInt(err.headers['x-rate-limit-reset']) * 1000 - Date.now()) / 1000, 1)
            : 120;
          console.log(`[API] 429 Rate Limit: Waiting ${retryAfter} seconds`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        } catch (cacheErr) {
          console.error('[Cache] Error:', cacheErr.message);
        }
      }
      if (i === retries - 1 && !res.headersSent) {
        res.status(500).json({ error: 'Request failed after retries', details: err.message });
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
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
    const existingUser = await User.findOne({
      $or: [
        { SOL_ID, username: { $ne: username } },
        { DEV_ID, username: { $ne: username } }
      ]
    });
    if (existingUser) {
      return res.status(400).json({ error: 'SOL_ID or DEV_ID already associated with another user' });
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
    const followersCount = twitterUser.data.public_metrics?.followers_count || 0;
    const dbProjects = await Project.find().lean();
    if (!dbProjects.length) {
      return res.status(404).json({ error: 'No projects configured' });
    }
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let tweets = await retryRequest(
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
    if (!tweets) return;
    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });
    if (tweets.meta.result_count) {
      for await (const tweet of tweets) {
        if (tweet.text.length < 51) {
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
          continue;
        }
        const mentionChars = extractMentions(tweet.text);
        const totalChars = tweet.text.length;
        const mentionRatio = mentionChars / totalChars;
        const nonMentionText = tweet.text.replace(/@(\w+)/g, '').replace(/\s+/g, ' ').trim();
        if (mentionRatio > 0.6 || nonMentionText.length < 10) {
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
          continue;
        }
        let tweetType = 'main';
        if (tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
          const refTweet = tweet.referenced_tweets[0];
          if (refTweet.type === 'replied_to') tweetType = 'reply';
          else if (refTweet.type === 'quoted') tweetType = 'quote';
        }
        if (tweetType === 'reply') {
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
          continue;
        }
        const processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean();
        if (processedPost) continue;
        const text = tweet.text.toLowerCase();
        const matchedProjects = [];
        for (const project of dbProjects) {
          const projectName = project.name.toLowerCase();
          const projectUsername = '@' + username.toLowerCase();
          const projectKeywords = (project.keywords || []).map(k => k.toLowerCase());
          const queryTerms = [projectName, projectUsername, ...projectKeywords];
          const matchesTag = queryTerms.some(term => text.includes(term.toLowerCase()) || text.includes('@' + term.toLowerCase().replace('@', '')));
          const matchesKeyword = projectKeywords.some(keyword => text.includes(keyword.toLowerCase()));
          if (matchesTag || matchesKeyword) {
            matchedProjects.push(project);
          }
        }
        if (matchedProjects.length === 0) {
          try {
            await new ProcessedPost({ postId: tweet.id }).save();
          } catch (err) {
            if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
          }
          continue;
        }
        let analysis;
        try {
          analysis = await analyzeContentForScoring(tweet);
        } catch (err) {
          analysis = { sentimentScore: 0.5 };
        }
        const qualityScore = calculateQualityScore(analysis, tweet, followersCount);
        const verifiedProjects = matchedProjects.filter(project => project.verified);
        const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
        const totalBlabz = verifiedProjects.length > 0 ? (projectBlabz * verifiedProjects.length).toFixed(4) : 0;
        try {
          const post = new Post({
            SOL_ID: userDoc.SOL_ID || userId,
            DEV_ID: userDoc.DEV_ID || '',
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
            tweetUrl: 'https://x.com/' + username + '/status/' + tweet.id,
            createdAt: tweet.created_at,
            tweetType,
            additionalFields: { quote_count: tweet.public_metrics.quote_count }
          });
          await post.save();
        } catch (err) {
          if (err.code !== 11000) console.error('[MongoDB] Error saving Post:', err.message);
          continue;
        }
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
        } catch (err) {
          if (err.code !== 11000) console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        const postData = {
          SOL_ID: userDoc.SOL_ID || userId,
          DEV_ID: userDoc.DEV_ID || '',
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
          tweetUrl: 'https://x.com/' + username + '/status/' + tweet.id,
          createdAt: tweet.created_at,
          tweetType,
          additionalFields: { quote_count: tweet.public_metrics.quote_count }
        };
        matchedProjects.forEach(project => {
          if (categorizedPosts[project.name.toUpperCase()]) {
            categorizedPosts[project.name.toUpperCase()].push(postData);
          }
        });
      }
    }
    const dbPosts = await Post.find({ userId, createdAt: { $gte: new Date(sevenDaysAgo) } })
      .select('SOL_ID DEV_ID userId username postId content project score blabz likes retweets replies hashtags tweetUrl createdAt tweetType additionalFields')
      .lean();
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
      const errorMessage = tweets.meta.result_count
        ? 'No tweets passed the filters'
        : 'No tweets found for this user in the last 7 days';
      return res.status(200).json({ message: errorMessage, posts: categorizedPosts });
    }
    await invalidateCache(username);
    res.json({ posts: categorizedPosts });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  }
});

router.get('/clear-cache', async (req, res) => {
  try {
    await redisClient.flushAll();
    res.json({ clear: 'All Redis cache cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/clear-processed', async (req, res) => {
  try {
    await ProcessedPost.deleteMany({});
    res.json({ message: 'Processed posts cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/clear-posts', async (req, res) => {
  try {
    await Post.deleteMany({});
    res.json({ message: 'All posts cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/check-processed/:postId', async (req, res) => {
  try {
    const post = await ProcessedPost.findOne({ postId: req.params.postId }).lean();
    res.json({ found: !!post, post });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/check-post/:postId', async (req, res) => {
  try {
    const post = await Post.findOne({ postId: req.params.postId }).lean();
    res.json({ found: !!post, post });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/tweet/:postId', async (req, res) => {
  try {
    const tweet = await client.v2.singleTweet(req.params.postId, {
      'tweet.fields': ['created_at', 'public_metrics', 'text', 'referenced_tweets']
    });
    res.json(tweet.data || { error: 'Tweet not found' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tweet', details: err.message });
  }
});

router.get('/rate-limit-status', async (req, res) => {
  try {
    res.json({ status: 'Not implemented' });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

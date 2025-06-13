const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const redis = require('redis');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');
const { HfInference } = require('@huggingface/inference');
const Post = require('../models/Post');
const ProcessedPost = require('../models/ProcessedPost');
const Project = require('../models/Project');
const User = require('../models/User');
const mongoose = require('mongoose');

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

// Rate limiting: 10 requests per 60 seconds per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
  handler: async (req, res) => {
    const cacheKey = `${req.method}:${req.originalUrl}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log(`[Cache] Serving cached response for ${cacheKey}`);
      return res.json(JSON.parse(cached));
    }
    res.status(429).json({ error: 'Rate limit exceeded, try again in 60 seconds' });
  }
});

// Cache middleware
const cacheMiddleware = async (req, res, next) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  const cached = await redisClient.get(cacheKey);
  if (cached) {
    console.log(`[Cache] Hit for ${cacheKey}`);
    return res.json(JSON.parse(cached));
  }
  const originalJson = res.json;
  res.json = async (data) => {
    await redisClient.setEx(cacheKey, 120, JSON.stringify(data)); // Cache for 2 minutes
    console.log(`[Cache] Stored for ${cacheKey} (expires in 120 seconds)`);
    return originalJson.call(res, data);
  };
  next();
};

// Function to invalidate cache for a user/project pair
async function invalidateCache(username, project) {
  const cacheKey = `GET:/solcontent/username/${username}/${project}`;
  try {
    await redisClient.del(cacheKey);
    console.log(`[Cache] Invalidated cache for ${cacheKey}`);
  } catch (err) {
    console.error(`[Cache] Error invalidating cache for ${cacheKey}:`, err.message);
  }
}

// Retry logic for X API
async function retryRequest(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      console.warn(`[API] Retry ${i + 1}/${retries}: ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
    }
  }
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

// Analyze content with AI for scoring
async function analyzeContentForScoring(tweet) {
  const text = tweet.text;
  try {
    const sentiment = await hf.textClassification({
      model: 'nlptown/bert-base-multilingual-uncased-sentiment',
      inputs: text
    });
    const sentimentScore = sentiment[0].label.includes('positive') ? 0.8 : sentiment[0].label.includes('neutral') ? 0.6 : 0.4;

    const classification = await hf.zeroShotClassification({
      model: 'facebook/bart-large-mnli',
      inputs: text,
      parameters: { candidate_labels: ['informative', 'hype', 'logical', 'spam', 'incoherent'] }
    });

    const scores = classification.scores.reduce((acc, score, i) => {
      acc[classification.labels[i]] = score;
      return acc;
    }, {});

    console.log(`[API] Content analysis for scoring tweet "${text}": ${JSON.stringify(scores)}`);

    return {
      sentimentScore,
      informativeScore: scores.informative,
      hypeScore: scores.hype,
      logicalScore: scores.logical
    };
  } catch (err) {
    console.error('[API] Content analysis error for scoring:', err.message);
    return { sentimentScore: 0.5, informativeScore: 0.5, hypeScore: 0.5, logicalScore: 0.5 };
  }
}

// Calculate quality score
function calculateQualityScore(analysis, tweet) {
  let qualityScore = analysis.sentimentScore * 50;
  qualityScore += analysis.informativeScore * 20;
  qualityScore += analysis.hypeScore * 15;
  qualityScore += analysis.logicalScore * 15;

  const text = tweet.text.toLowerCase();
  if (text.match(/(https?:\/\/[^\s]+)|(\d+%|\$\d+)|blockchain|solana|smart contract|defi|nft/i)) qualityScore += 10;
  if (text.match(/how to|guide|tutorial|learn|explain|step by step/i)) qualityScore += 10;
  if (text.match(/announc|update|new|launch|reveal/i)) qualityScore += 5;

  return Math.max(0, Math.min(100, qualityScore));
}

// Calculate Blabz from quality score
function calculateBlabz(qualityScore) {
  return Math.floor(qualityScore / 10); // 1 Blabz = 10 score points
}

// GET /user/:username
router.get('/user/:username', limiter, cacheMiddleware, async (req, res) => {
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);

    // Verify MongoDB connection
    if (mongoose.connection.readyState !== 1) {
      console.error('[MongoDB] Not connected, state:', mongoose.connection.readyState);
      throw new Error('MongoDB not connected');
    }
    console.log('[MongoDB] Connection verified, state:', mongoose.connection.readyState);

    // Fetch user from Twitter API
    let user;
    try {
      user = await retryRequest(() => client.v2.userByUsername(req.params.username, {
        'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
      }));
      console.log(`[Twitter API] User fetched: ${JSON.stringify(user.data)}`);
    } catch (err) {
      console.error('[Twitter API] Error fetching user:', err.message);
      return res.status(500).json({ error: 'Failed to fetch user from Twitter API', details: err.message });
    }
    if (!user.data) {
      console.error('[Twitter API] User not found');
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;

    // Update or create user in MongoDB
    try {
      await User.findOneAndUpdate(
        { userId },
        {
          userId,
          username: user.data.username,
          name: user.data.name,
          profile_image_url: user.data.profile_image_url,
          followers_count: user.data.public_metrics.followers_count,
          following_count: user.data.public_metrics.following_count,
          bio: user.data.description || '',
          location: user.data.location || '',
          ...req.body.additionalFields
        },
        { upsert: true, new: true }
      );
      console.log(`[MongoDB] User ${user.data.username} updated/created`);
    } catch (err) {
      console.error('[MongoDB] Error updating user:', err.message);
      throw err;
    }

    const userDoc = await User.findOne({ userId }).lean();
    const profile = {
      username: user.data.username,
      name: user.data.name,
      profile_image_url: user.data.profile_image_url,
      followers_count: user.data.public_metrics.followers_count,
      following_count: user.data.public_metrics.following_count,
      bio: user.data.description || '',
      location: user.data.location || '',
      ...(userDoc.additionalFields || {})
    };

    // Fetch tweets from the last 24 hours
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let tweets;
    try {
      tweets = await retryRequest(() => client.v2.userTimeline(userId, {
        max_results: 50,
        start_time: oneDayAgo,
        'tweet.fields': ['created_at', 'public_metrics', 'text']
      }));
      console.log(`[Twitter API] Fetched ${tweets.meta.result_count} tweets for user ${req.params.username}`);
    } catch (err) {
      console.error('[Twitter API] Error fetching tweets:', err.message, err.data || '');
      return res.status(500).json({ error: 'Failed to fetch tweets from Twitter API', details: err.message });
    }

    const curatedPosts = { profile, posts: {} };
    let dbProjects;
    try {
      dbProjects = await Project.find().lean();
      console.log(`[MongoDB] Fetched ${dbProjects.length} projects`);
    } catch (err) {
      console.error('[MongoDB] Error fetching projects:', err.message);
      throw err;
    }
    const projectsMap = dbProjects.reduce((acc, proj) => {
      acc[proj.name] = proj.keywords || [];
      return acc;
    }, {});

    if (!tweets.meta.result_count) {
      console.log('[Twitter API] No tweets found for user within 24 hours');
      return res.json(curatedPosts);
    }

    for await (const tweet of tweets) {
      console.log(`[Debug] Processing tweet ID ${tweet.id}: ${tweet.text}`);

      let processedPost, existingPost;
      try {
        processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean();
        existingPost = await Post.findOne({ postId: tweet.id }).lean();
        console.log(`[MongoDB] ProcessedPost exists: ${!!processedPost}, Post exists: ${!!existingPost}`);
      } catch (err) {
        console.error('[MongoDB] Error checking posts:', err.message);
        continue;
      }

      if (existingPost) {
        curatedPosts.posts[existingPost.project] = curatedPosts.posts[existingPost.project] || [];
        curatedPosts.posts[existingPost.project].push({
          content: existingPost.content,
          score: existingPost.score,
          blabz: calculateBlabz(existingPost.score),
          likes: existingPost.likes,
          retweets: existingPost.retweets,
          hashtags: existingPost.hashtags,
          createdAt: existingPost.createdAt,
          ...(existingPost.additionalFields || {})
        });
        continue;
      }

      if (processedPost) {
        console.log(`[Debug] Tweet already processed: ${tweet.id}`);
        continue;
      }

      let analysis;
      try {
        analysis = await analyzeContentForScoring(tweet);
        console.log(`[Debug] Scoring analysis result: ${JSON.stringify(analysis)}`);
      } catch (err) {
        console.error('[HuggingFace] Error in scoring analysis:', err.message);
        analysis = { sentimentScore: 0.5, informativeScore: 0.5, hypeScore: 0.5, logicalScore: 0.5 };
      }

      const text = tweet.text.toLowerCase();
      let projectMatch = null;
      for (const [project, keywords] of Object.entries(projectsMap)) {
        const extendedKeywords = [
          ...keywords,
          project.toLowerCase(),
          req.params.username.toLowerCase(),
          `@${req.params.username.toLowerCase()}`
        ];
        if (extendedKeywords.some(keyword => 
          text.includes(keyword.toLowerCase()) || 
          keyword.toLowerCase().split('.').some(part => text.includes(part)) ||
          text.includes(`@${keyword.toLowerCase().replace('@', '')}`)
        )) {
          projectMatch = project;
          break;
        }
      }

      if (!projectMatch) {
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (no project match)`);
        } catch (err) {
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        continue;
      }

      try {
        await new ProcessedPost({ postId: tweet.id }).save();
        console.log(`[MongoDB] Marked tweet ${tweet.id} as processed`);
      } catch (err) {
        console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        continue;
      }

      const qualityScore = calculateQualityScore(analysis, tweet);
      console.log(`[Debug] Quality score: ${qualityScore}`);

      // Remove qualityScore threshold to ensure all matching tweets are saved
      try {
        const post = new Post({
          userId,
          postId: tweet.id,
          content: tweet.text,
          project: projectMatch,
          score: qualityScore,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          hashtags: extractHashtags(tweet.text),
          createdAt: tweet.created_at,
          ...req.body.additionalPostFields
        });
        await post.save();
        console.log(`[MongoDB] Saved post to DB for project ${projectMatch}, postId: ${tweet.id}`);
      } catch (err) {
        console.error('[MongoDB] Error saving Post:', err.message);
        continue;
      }

      try {
        await invalidateCache(req.params.username, projectMatch);
      } catch (err) {
        console.error('[Redis] Error invalidating cache:', err.message);
      }

      curatedPosts.posts[projectMatch] = curatedPosts.posts[projectMatch] || [];
      curatedPosts.posts[projectMatch].push({
        content: tweet.text,
        score: qualityScore,
        blabz: calculateBlabz(qualityScore),
        likes: tweet.public_metrics.like_count,
        retweets: tweet.public_metrics.retweet_count,
        hashtags: extractHashtags(tweet.text),
        createdAt: tweet.created_at,
        ...req.body.additionalPostFields
      });
    }

    // Sort posts by score within each project
    for (const project in curatedPosts.posts) {
      curatedPosts.posts[project].sort((a, b) => b.score - a.score);
    }

    console.log(`[Debug] Final response: ${JSON.stringify(curatedPosts, null, 2)}`);
    res.json(curatedPosts);
  } catch (err) {
    console.error('[API] Error in /user:', err.message, err.stack);
    if (err.code === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (err.code === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /community-feed
router.get('/community-feed', limiter, cacheMiddleware, async (req, res) => {
  try {
    console.log('[API] Fetching community feed');

    // Fetch all posts from the last 24 hours, sorted by score
    const posts = await Post.find({
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    })
      .sort({ score: -1 })
      .limit(100)
      .lean();

    console.log(`[MongoDB] Fetched ${posts.length} posts for community feed`);

    const communityFeed = posts.map(post => ({
      username: post.username || 'Unknown', // Add username if stored in Post schema
      project: post.project,
      content: post.content,
      score: post.score,
      blabz: calculateBlabz(post.score),
      likes: post.likes,
      retweets: post.retweets,
      hashtags: post.hashtags,
      createdAt: post.createdAt,
      ...(post.additionalFields || {})
    }));

    res.json({ posts: communityFeed });
  } catch (err) {
    console.error('[API] Error in /community-feed:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /username/:username/:project (simplified, same as previous)
router.get('/username/:username/:project', limiter, cacheMiddleware, async (req, res) => {
  try {
    console.log(`[API] Fetching posts for user: ${req.params.username}, project: ${req.params.project}`);

    if (mongoose.connection.readyState !== 1) {
      console.error('[MongoDB] Not connected, state:', mongoose.connection.readyState);
      throw new Error('MongoDB not connected');
    }

    let user;
    try {
      user = await retryRequest(() => client.v2.userByUsername(req.params.username, {
        'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
      }));
      console.log(`[Twitter API] User fetched: ${JSON.stringify(user.data)}`);
    } catch (err) {
      console.error('[Twitter API] Error fetching user:', err.message);
      return res.status(500).json({ error: 'Failed to fetch user', details: err.message });
    }
    if (!user.data) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;

    try {
      await User.findOneAndUpdate(
        { userId },
        {
          userId,
          username: user.data.username,
          name: user.data.name,
          profile_image_url: user.data.profile_image_url,
          followers_count: user.data.public_metrics.followers_count,
          following_count: user.data.public_metrics.following_count,
          bio: user.data.description || '',
          location: user.data.location || '',
          ...req.body.additionalFields
        },
        { upsert: true, new: true }
      );
      console.log(`[MongoDB] User ${user.data.username} updated/created`);
    } catch (err) {
      console.error('[MongoDB] Error updating user:', err.message);
      throw err;
    }

    const userDoc = await User.findOne({ userId }).lean();
    const profile = {
      username: user.data.username,
      name: user.data.name,
      profile_image_url: user.data.profile_image_url,
      followers_count: user.data.public_metrics.followers_count,
      following_count: user.data.public_metrics.following_count,
      bio: user.data.description || '',
      location: user.data.location || '',
      ...(userDoc.additionalFields || {})
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

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let tweets;
    try {
      tweets = await retryRequest(() => client.v2.userTimeline(userId, {
        max_results: 50,
        start_time: sevenDaysAgo,
        'tweet.fields': ['created_at', 'public_metrics', 'text']
      }));
      console.log(`[Twitter API] Fetched ${tweets.meta.result_count} tweets for user ${req.params.username}`);
    } catch (err) {
      console.error('[Twitter API] Error fetching tweets:', err.message, err.data || '');
      return res.status(500).json({ error: 'Failed to fetch tweets', details: err.message });
    }

    const curatedPosts = { profile, posts: [] };
    const projectKeywords = project.keywords || [];
    const extendedKeywords = [
      ...projectKeywords,
      req.params.project.toLowerCase(),
      req.params.username.toLowerCase(),
      `@${req.params.username.toLowerCase()}`
    ];
    console.log(`[Debug] Extended keywords: ${JSON.stringify(extendedKeywords)}`);

    if (!tweets.meta.result_count) {
      console.log('[Twitter API] No tweets found for user within 7 days');
      return res.json(curatedPosts);
    }

    for await (const tweet of tweets) {
      console.log(`[Debug] Processing tweet ID ${tweet.id}: ${tweet.text}`);

      let processedPost, existingPost;
      try {
        processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean();
        existingPost = await Post.findOne({ postId: tweet.id }).lean();
        console.log(`[MongoDB] ProcessedPost exists: ${!!processedPost}, Post exists: ${!!existingPost}`);
      } catch (err) {
        console.error('[MongoDB] Error checking posts:', err.message);
        continue;
      }

      if (existingPost && existingPost.project.toUpperCase() === req.params.project.toUpperCase()) {
        console.log(`[Debug] Found existing post for project ${req.params.project}`);
        curatedPosts.posts.push({
          content: existingPost.content,
          score: existingPost.score,
          blabz: calculateBlabz(existingPost.score),
          likes: existingPost.likes,
          retweets: existingPost.retweets,
          hashtags: existingPost.hashtags,
          createdAt: existingPost.createdAt,
          ...(existingPost.additionalFields || {})
        });
        continue;
      }

      if (processedPost) {
        console.log(`[Debug] Tweet already processed: ${tweet.id}`);
        continue;
      }

      const text = tweet.text.toLowerCase();
      const matchesProject = extendedKeywords.some(keyword => 
        text.includes(keyword.toLowerCase()) || 
        keyword.toLowerCase().split('.').some(part => text.includes(part)) ||
        text.includes(`@${keyword.toLowerCase().replace('@', '')}`)
      );
      console.log(`[Debug] Matches project keywords: ${matchesProject}`);
      if (!matchesProject) {
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (no keyword match)`);
        } catch (err) {
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        continue;
      }

      try {
        await new ProcessedPost({ postId: tweet.id }).save();
        console.log(`[MongoDB] Marked tweet ${tweet.id} as processed`);
      } catch (err) {
        console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        continue;
      }

      let analysis;
      try {
        analysis = await analyzeContentForScoring(tweet);
        console.log(`[Debug] Scoring analysis result: ${JSON.stringify(analysis)}`);
      } catch (err) {
        console.error('[HuggingFace] Error in scoring analysis:', err.message);
        analysis = { sentimentScore: 0.5, informativeScore: 0.5, hypeScore: 0.5, logicalScore: 0.5 };
      }

      const qualityScore = calculateQualityScore(analysis, tweet);
      console.log(`[Debug] Quality score: ${qualityScore}`);

      try {
        const post = new Post({
          userId,
          postId: tweet.id,
          content: tweet.text,
          project: req.params.project.toUpperCase(),
          score: qualityScore,
          likes: tweet.public_metrics.like_count,
          retweets: tweet.public_metrics.retweet_count,
          hashtags: extractHashtags(tweet.text),
          createdAt: tweet.created_at,
          username: req.params.username, // Store username for community feed
          ...req.body.additionalPostFields
        });
        await post.save();
        console.log(`[MongoDB] Saved post to DB for project ${req.params.project}, postId: ${tweet.id}`);
      } catch (err) {
        console.error('[MongoDB] Error saving Post:', err.message);
        continue;
      }

      try {
        await invalidateCache(req.params.username, req.params.project);
      } catch (err) {
        console.error('[Redis] Error invalidating cache:', err.message);
      }

      curatedPosts.posts.push({
        content: tweet.text,
        score: qualityScore,
        blabz: calculateBlabz(qualityScore),
        likes: tweet.public_metrics.like_count,
        retweets: tweet.public_metrics.retweet_count,
        hashtags: extractHashtags(tweet.text),
        createdAt: tweet.created_at,
        ...req.body.additionalPostFields
      });
    }

    curatedPosts.posts.sort((a, b) => b.score - a.score);
    console.log(`[Debug] Final response: ${JSON.stringify(curatedPosts, null, 2)}`);
    res.json(curatedPosts);
  } catch (err) {
    console.error('[API] Error in /username/:username/:project:', err.message, err.stack);
    if (err.code === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (err.code === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /project/:token
router.get('/project/:token', limiter, cacheMiddleware, async (req, res) => {
  try {
    const posts = await Post.find({ project: req.params.token.toUpperCase() })
      .sort({ score: -1 })
      .limit(50);
    res.json({
      posts: posts.map(post => ({
        ...post.toObject(),
        blabz: calculateBlabz(post.score)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /projects
router.post('/projects', limiter, async (req, res) => {
  try {
    const { name, keywords, description, website, additionalProjectFields } = req.body;
    if (!name || !keywords?.length) {
      return res.status(400).json({ error: 'Name and keywords required' });
    }

    const project = await Project.findOneAndUpdate(
      { name: name.toUpperCase() },
      { name: name.toUpperCase(), keywords, description, website, ...additionalProjectFields },
      { upsert: true, new: true }
    );

    res.json({ message: `Project ${name} added`, project });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /projects
router.get('/projects', limiter, cacheMiddleware, async (req, res) => {
  try {
    const projects = await Project.find().lean();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// PUT /user/:username
router.put('/user/:username', limiter, async (req, res) => {
  try {
    const fields = req.body;
    const user = await User.findOneAndUpdate(
      { username: req.params.username },
      { $set: fields },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: `User ${user.username} updated`, user });
  } catch (err) {
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// PUT /project/:name
router.put('/project/:name', limiter, async (req, res) => {
  try {
    const fields = req.body;
    const project = await Project.findOneAndUpdate(
      { name: req.params.name.toUpperCase() },
      { $set: fields },
      { new: true }
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ message: `Project ${project.name} updated`, project });
  } catch (err) {
    console.error('[API] Error in /project:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /user/:username
router.post('/user/:username', limiter, cacheMiddleware, async (req, res) => {
  req.method = 'GET';
  return router.handle(req, res);
});

// GET /user-details/:username
router.get('/user-details/:username', limiter, async (req, res) => {
  try {
    console.log(`[API] Fetching user details for: ${req.params.username}`);

    const user = await client.v2.userByUsername(req.params.username, {
      'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
    });

    if (!user.data) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      username: user.data.username,
      name: user.data.name,
      profile_image_url: user.data.profile_image_url,
      followers_count: user.data.public_metrics.followers_count,
      following_count: user.data.public_metrics.following_count,
      bio: user.data.description || '',
      location: user.data.location || ''
    });
  } catch (err) {
    console.error('[API] Error in /user-details:', err.message);
    if (err.code === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (err.code === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /clear-cache
router.get('/clear-cache', limiter, async (req, res) => {
  try {
    await redisClient.flushAll();
    console.log('[Redis] All cache cleared');
    res.json({ message: 'All Redis cache cleared' });
  } catch (err) {
    console.error('[Redis] Error clearing cache:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /clear-processed
router.get('/clear-processed', limiter, async (req, res) => {
  try {
    await ProcessedPost.deleteMany({});
    console.log('[MongoDB] All processed posts cleared');
    res.json({ message: 'Processed posts cleared' });
  } catch (err) {
    console.error('[MongoDB] Error clearing processed posts:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

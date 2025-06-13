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

// Analyze content with AI
async function analyzeContent(tweet) {
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

    console.log(`[API] Content analysis for tweet "${text}": ${JSON.stringify(scores)}`);

    const isValid = scores.informative > 0.2 || scores.hype > 0.2 || scores.logical > 0.2;
    const isSpam = scores.spam > 0.7 || scores.incoherent > 0.7;

    return { isValid, isSpam, sentimentScore, informativeScore: scores.informative, hypeScore: scores.hype, logicalScore: scores.logical };
  } catch (err) {
    console.error('[API] Content analysis error:', err.message);
    return { isValid: true, isSpam: false, sentimentScore: 0.5, informativeScore: 0.5, hypeScore: 0.5, logicalScore: 0.5 };
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

// GET /username/:username/:project
router.get('/username/:username/:project', limiter, cacheMiddleware, async (req, res) => {
  try {
    console.log(`[API] Fetching posts for user: ${req.params.username}, project: ${req.params.project}`);

    // Fetch user from Twitter API
    const user = await retryRequest(() => client.v2.userByUsername(req.params.username, {
      'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
    }));
    if (!user.data) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;

    // Update or create user in MongoDB
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

    // Validate project exists
    const project = await Project.findOne({ name: req.params.project.toUpperCase() }).lean();
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    console.log(`[Debug] Project keywords: ${JSON.stringify(project.keywords)}`);

    // Fetch tweets from the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const tweets = await retryRequest(() => client.v2.userTimeline(userId, {
      max_results: 50,
      start_time: sevenDaysAgo,
      'tweet.fields': ['created_at', 'public_metrics', 'text']
    }));
    console.log(`[Debug] Fetched ${tweets.length} tweets for user ${req.params.username}`);

    const curatedPosts = { profile, posts: [] };
    const projectKeywords = project.keywords || [];
    // Add project name and username to keywords
    const extendedKeywords = [
      ...projectKeywords,
      req.params.project.toLowerCase(),
      req.params.username.toLowerCase(),
      `@${req.params.username.toLowerCase()}`
    ];
    console.log(`[Debug] Extended keywords: ${JSON.stringify(extendedKeywords)}`);

    for await (const tweet of tweets) {
      console.log(`[Debug] Processing tweet: ${tweet.text}`);
      const processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);
      const existingPost = await Post.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);

      // If post exists in DB and matches the project, include it
      if (existingPost && existingPost.project.toUpperCase() === req.params.project.toUpperCase()) {
        console.log(`[Debug] Found existing post for project ${req.params.project}`);
        curatedPosts.posts.push({
          content: existingPost.content,
          score: existingPost.score,
          likes: existingPost.likes,
          retweets: existingPost.retweets,
          hashtags: existingPost.hashtags,
          createdAt: existingPost.createdAt,
          ...(existingPost.additionalFields || {})
        });
        continue;
      }

      // Skip if already processed
      if (processedPost) {
        console.log(`[Debug] Tweet already processed: ${tweet.id}`);
        continue;
      }

      // Mark post as processed
      await new ProcessedPost({ postId: tweet.id }).save();

      // Analyze tweet content
      const analysis = await analyzeContent(tweet);
      console.log(`[Debug] Analysis result: ${JSON.stringify(analysis)}`);
      if (!analysis.isValid || analysis.isSpam) {
        console.log(`[Debug] Skipped: Invalid or spam`);
        continue;
      }

      // Check if tweet matches any keyword (partial, case-insensitive)
      const text = tweet.text.toLowerCase();
      const matchesProject = extendedKeywords.some(keyword => 
        text.includes(keyword.toLowerCase()) || 
        keyword.toLowerCase().split('.').some(part => text.includes(part)) ||
        text.includes(`@${keyword.toLowerCase().replace('@', '')}`)
      );
      console.log(`[Debug] Matches project keywords: ${matchesProject}`);
      if (!matchesProject) continue;

      // Calculate quality score
      const qualityScore = calculateQualityScore(analysis, tweet);
      console.log(`[Debug] Quality score: ${qualityScore}`);

      // Save post to DB
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
        ...req.body.additionalPostFields
      });
      await post.save();
      console.log(`[Debug] Saved post to DB for project ${req.params.project}`);

      // Invalidate cache for this user/project
      await invalidateCache(req.params.username, req.params.project);

      // Add to response
      curatedPosts.posts.push({
        content: tweet.text,
        score: qualityScore,
        likes: tweet.public_metrics.like_count,
        retweets: tweet.public_metrics.retweet_count,
        hashtags: extractHashtags(tweet.text),
        createdAt: tweet.created_at,
        ...req.body.additionalPostFields
      });
    }

    console.log(`[Debug] Final response: ${JSON.stringify(curatedPosts, null, 2)}`);
    res.json(curatedPosts);
  } catch (err) {
    console.error('[API] Error in /username/:username/:project:', err.message);
    if (err.code === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (err.code === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /user/:username
router.get('/user/:username', limiter, cacheMiddleware, async (req, res) => {
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);

    const user = await retryRequest(() => client.v2.userByUsername(req.params.username, {
      'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
    }));
    if (!user.data) {
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;

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

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tweets = await retryRequest(() => client.v2.userTimeline(userId, {
      max_results: 50,
      start_time: oneDayAgo,
      'tweet.fields': ['created_at', 'public_metrics', 'text']
    }));

    const curatedPosts = { profile, posts: {} };
    const dbProjects = await Project.find().lean();
    const projectsMap = dbProjects.reduce((acc, proj) => {
      acc[proj.name] = proj.keywords;
      return acc;
    }, {});

    for await (const tweet of tweets) {
      const processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);
      const existingPost = await Post.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);

      if (existingPost) {
        curatedPosts.posts[existingPost.project] = curatedPosts.posts[existingPost.project] || [];
        curatedPosts.posts[existingPost.project].push({
          content: existingPost.content,
          score: existingPost.score,
          likes: existingPost.likes,
          retweets: existingPost.retweets,
          hashtags: existingPost.hashtags,
          createdAt: existingPost.createdAt,
          ...(existingPost.additionalFields || {})
        });
        continue;
      }

      if (processedPost) continue;

      await new ProcessedPost({ postId: tweet.id }).save();

      const analysis = await analyzeContent(tweet);
      if (!analysis.isValid || analysis.isSpam) continue;

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
      if (!projectMatch) continue;

      const qualityScore = calculateQualityScore(analysis, tweet);
      if (qualityScore < 70) continue;

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

      await invalidateCache(req.params.username, projectMatch);

      curatedPosts.posts[projectMatch] = curatedPosts.posts[projectMatch] || [];
      curatedPosts.posts[projectMatch].push({
        content: tweet.text,
        score: qualityScore,
        likes: tweet.public_metrics.like_count,
        retweets: tweet.public_metrics.retweet_count,
        hashtags: extractHashtags(tweet.text),
        createdAt: tweet.created_at,
        ...req.body.additionalPostFields
      });
    }

    console.log(`[Debug] Final response: ${JSON.stringify(curatedPosts, null, 2)}`);
    res.json(curatedPosts);
  } catch (err) {
    console.error('[API] Error in /user:', err.message);
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
    res.json({ posts });
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

    // Fetch user from Twitter API
    const user = await client.v2.userByUsername(req.params.username, {
      'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
    });

    if (!user.data) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Return user details
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

module.exports = router;

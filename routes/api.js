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
    await redisClient.setEx(cacheKey, 120, JSON.stringify(data));
    console.log(`[Cache] Stored for ${cacheKey} (expires in 120 seconds)`);
    return originalJson.call(res, data);
  };
  next();
};

// Invalidate cache
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

// Analyze content with AI for scoring (robust fallback)
async function analyzeContentForScoring(tweet) {
  const text = tweet.text;
  try {
    const sentiment = await hf.textClassification({
      model: 'nlptown/bert-base-multilingual-uncased-sentiment',
      inputs: text
    });
    const sentimentScore = sentiment[0]?.label.includes('positive') ? 0.8 : sentiment[0]?.label.includes('neutral') ? 0.6 : 0.4;

    const classification = await hf.zeroShotClassification({
      model: 'facebook/bart-large-mnli',
      inputs: text,
      parameters: { candidate_labels: ['informative', 'hype', 'logical', 'spam', 'incoherent'] }
    });

    const scores = classification.scores?.reduce((acc, score, i) => {
      acc[classification.labels[i]] = score;
      return acc;
    }, {}) || { informative: 0.5, hype: 0.5, logical: 0.5, spam: 0.5, incoherent: 0.5 };

    console.log(`[API] Content analysis for tweet "${text.slice(0, 50)}...": ${JSON.stringify(scores)}`);

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
  if (text.match(/how to|guide|tutorial|learn|explain/i)) qualityScore += 10;
  if (text.match(/announc|update|new|launch|reveal/i)) qualityScore += 5;

  return Math.max(0, Math.min(100, qualityScore));
}

// Calculate Blabz
function calculateBlabz(qualityScore) {
  return Math.floor(qualityScore / 10); // 1 Blabz = 10 score points
}

// GET /user/:username
router.get('/user/:username', limiter, cacheMiddleware, async (req, res) => {
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);

    if (mongoose.connection.readyState !== 1) {
      console.error('[MongoDB] Not connected, state:', mongoose.connection.readyState);
      throw new Error('MongoDB not connected');
    }
    console.log('[MongoDB] Connection verified, state:', mongoose.connection.readyState);

    let user;
    try {
      user = await retryRequest(() => client.v2.userByUsername(req.params.username, {
        'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location']
      }));
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
      tweets = await retryRequest(() => client.v2.userTimeline(userId.toString(), {
        'tweet.fields': ['created_at', 'public_metrics', 'text'],
        'expansions': ['referenced_tweets.id'],
        exclude: ['retweets'],
        max_results: 100,
        start_time: sevenDaysAgo
      }));
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

      if (tweet.text.length <= 100) {
        console.log(`[Debug] Tweet ${tweet.id} skipped: too short (${tweet.text.length} characters)`);
        try {
          await new ProcessedPost({ postId: tweet.id }).save();
          console.log(`[MongoDB] Marked tweet ${tweet.id} as processed (too short)`);
        } catch (err) {
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
        continue;
      }

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

        const matchesProject = queryTerms.some(term => 
          text.includes(term.toLowerCase()) || 
          term.toLowerCase().split('.').some(part => text.includes(part)) ||
          text.includes(`@${term.toLowerCase().replace('@', '')}`)
        );

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
          console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        }
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

      if (!existingPost) {
        try {
          const post = new Post({
            userId,
            username: user.data.username,
            postId: tweet.id,
            content: tweet.text,
            projects: matchedProjects,
            score: qualityScore,
            likes: tweet.public_metrics.like_count,
            retweets: tweet.public_metrics.retweet_count,
            replies: tweet.public_metrics.reply_count,
            hashtags: extractHashtags(tweet.text),
            createdAt: tweet.created_at,
            ...req.body.additionalFields
          });
          await post.save();
          console.log(`[MongoDB] Saved post to DB for projects ${matchedProjects.join(', ')}, postId: ${tweet.id}`);
        } catch (err) {
          console.error('[MongoDB] Error saving Post:', err.message);
          continue;
        }
      } else {
        console.log(`[Debug] Found existing post for projects ${existingPost.projects.join(', ')}`);
      }

      try {
        await new ProcessedPost({ postId: tweet.id }).save();
        console.log(`[MongoDB] Marked tweet ${tweet.id} as processed`);
      } catch (err) {
        console.error('[MongoDB] Error saving ProcessedPost:', err.message);
        continue;
      }

      const postData = {
        userId,
        username: user.data.username,
        content: tweet.text,
        projects: matchedProjects,
        score: qualityScore,
        blabz: calculateBlabz(qualityScore),
        likes: tweet.public_metrics.like_count,
        retweets: tweet.public_metrics.retweet_count,
        replies: tweet.public_metrics.reply_count,
        hashtags: extractHashtags(tweet.text),
        createdAt: tweet.created_at,
        ...req.body.additionalFields
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
    if (err.code === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /community-feed
router.get('/community-feed', limiter, cacheMiddleware, async (req, res) => {
  try {
    console.log('[API] Fetching community feed');

    const posts = await Post.find({
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    })
      .sort({ score: -1 })
      .limit(100)
      .lean();

    console.log(`[MongoDB] Fetched ${posts.length} posts for community feed`);

    const communityFeed = posts.map(post => ({
      userId: post.userId,
      username: post.username || 'Unknown',
      projects: post.projects,
      content: post.content,
      score: post.score,
      blabz: calculateBlabz(post.score),
      likes: post.likes,
      retweets: post.retweets,
      replies: post.replies,
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

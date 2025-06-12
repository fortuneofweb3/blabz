const express = require('express');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');
const { HfInference } = require('@huggingface/inference');
const Post = require('../models/Post');
const ProcessedPost = require('../models/ProcessedPost');

// Validate environment variables
if (!process.env.X_BEARER_TOKEN) {
  console.error('[API] Error: X_BEARER_TOKEN is not set');
  throw new Error('X_BEARER_TOKEN is not set');
}
console.log('[API] X_BEARER_TOKEN loaded:', process.env.X_BEARER_TOKEN.substring(0, 10) + '...');
const client = new TwitterApi(process.env.X_BEARER_TOKEN);
const hf = new HfInference(process.env.HUGGINGFACE_API_KEY || '');

// Default Solana projects
const projects = {
  DEVFUN: ['devfun', 'dev.fun', 'devdotfun', '@devfunpump'],
  BUIDL: ['buidldao', '$buidl', '@buidldao_'],
  RICK: ['rick', '$rick', '@vibrationscode'],
  ZALA: ['zala', '$zala', '@zala_ai']
};

// Retry logic for X API calls
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

// Cleanup old posts
async function cleanupOldPosts() {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const postResult = await Post.deleteMany({ createdAt: { $lt: oneDayAgo } });
    const processedResult = await ProcessedPost.deleteMany({ processedAt: { $lt: oneDayAgo } });
    console.log(`[API] Cleanup: Deleted ${postResult.deletedCount} posts and ${processedResult.deletedCount} processed posts older than 24 hours`);
  } catch (err) {
    console.error('[API] Cleanup error:', err.message);
  }
}

// Calculate content quality score
function calculateQualityScore(tweet, sentimentScore) {
  const text = tweet.text.toLowerCase();
  let qualityScore = sentimentScore * 50; // Base score from sentiment (0-50)

  // Informative: Contains data, links, or technical terms
  if (text.match(/(https?:\/\/[^\s]+)|(\d+%|\$\d+)|blockchain|solana|smart contract|defi|nft/i)) {
    qualityScore += 20;
    console.log('[API] Boosted score for informative content');
  }

  // Educational: Explains concepts, tutorials, guides
  if (text.match(/how to|guide|tutorial|learn|explain|step by step/i)) {
    qualityScore += 20;
    console.log('[API] Boosted score for educational content');
  }

  // Revealing: Announcements, updates, new insights
  if (text.match(/announc|update|new|launch|reveal|break|exclusive/i)) {
    qualityScore += 10;
    console.log('[API] Boosted score for revealing content');
  }

  // Penalize low-value content
  if (text.match(/giveaway|pump|moon|win free/i)) {
    qualityScore -= 20;
    console.log('[API] Penalized score for low-value content');
  }

  return Math.max(0, Math.min(100, qualityScore)); // Normalize to 0-100
}

// GET /solcontent/user/:username
router.get('/user/:username', async (req, res) => {
  try {
    console.log(`[API] Fetching user: ${req.params.username}`);

    // Cleanup old posts
    await cleanupOldPosts();

    const user = await retryRequest(() => client.v2.userByUsername(req.params.username, {
      'user.fields': ['id', 'name', 'username']
    }));
    if (!user.data) {
      console.log(`[API] User not found: ${req.params.username}`);
      return res.status(404).json({ error: 'User not found' });
    }
    const userId = user.data.id;
    console.log(`[API] User ID: ${userId}`);

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tweets = await retryRequest(() => client.v2.userTimeline(userId, {
      max_results: 50,
      start_time: oneDayAgo,
      'tweet.fields': ['created_at', 'public_metrics', 'text']
    }));
    console.log(`[API] Fetched ${tweets.tweets.length} tweets`);

    const curatedPosts = { user: req.params.username, posts: {} };
    for await (const tweet of tweets) {
      // Skip if already processed or saved
      const processedExists = await ProcessedPost.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);
      const postExists = await Post.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);
      if (processedExists || postExists) {
        console.log(`[API] Skipping tweet ${tweet.id}: Already processed or saved`);
        continue;
      }

      // Mark as processed
      await new ProcessedPost({ postId: tweet.id }).save();
      console.log(`[API] Marked tweet ${tweet.id} as processed`);

      const text = tweet.text.toLowerCase();
      console.log(`[API] Processing tweet: ${text.substring(0, 50)}...`);

      if (text.length < 15 || text.includes('giveaway') || text.includes('pump')) {
        console.log('[API] Filtered as spam');
        continue;
      }

      let projectMatch = null;
      for (const [project, keywords] of Object.entries(projects)) {
        if (keywords.some(keyword => text.includes(keyword.toLowerCase()))) {
          projectMatch = project;
          break;
        }
      }
      if (!projectMatch) {
        console.log('[API] No project match');
        continue;
      }

      let sentimentScore = 0.7; // Default
      try {
        const score = await hf.textClassification({
          model: 'distilbert-base-uncased-finetuned-sst-2-english',
          inputs: tweet.text
        });
        if (score && typeof score.score === 'number' && !isNaN(score.score)) {
          sentimentScore = score.label === 'POSITIVE' ? score.score : (1 - score.score);
        } else {
          console.warn('[API] Invalid Hugging Face score, using default:', score);
        }
      } catch (err) {
        console.error('[API] Hugging Face error:', err.message);
      }

      const qualityScore = calculateQualityScore(tweet, sentimentScore);
      console.log(`[API] Quality score: ${qualityScore}`);
      if (qualityScore < 70) {
        console.log('[API] Low score, skipping');
        continue;
      }

      const post = new Post({
        userId,
        postId: tweet.id,
        content: tweet.text,
        project: projectMatch,
        score: qualityScore,
        likes: tweet.public_metrics.like_count,
        createdAt: tweet.created_at
      });
      await post.save();
      console.log(`[API] Saved post for project: ${projectMatch}`);

      curatedPosts.posts[projectMatch] = curatedPosts.posts[projectMatch] || [];
      curatedPosts.posts[projectMatch].push({
        content: tweet.text,
        score: qualityScore,
        likes: tweet.public_metrics.like_count,
        createdAt: tweet.created_at
      });
    }

    res.json(curatedPosts);
  } catch (err) {
    console.error('[API] Error in /user:', err.message, err.stack);
    if (err.code === 401) {
      return res.status(401).json({ error: 'Unauthorized: Verify token permissions and Basic Tier access' });
    }
    if (err.code === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /solcontent/project/:token
router.get('/project/:token', async (req, res) => {
  try {
    const posts = await Post.find({ project: req.params.token.toUpperCase() })
      .sort({ score: -1 })
      .limit(50);
    console.log(`[API] Fetched ${posts.length} posts for ${req.params.token}`);
    res.json({ posts });
  } catch (err) {
    console.error('[API] Error in /project:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// POST /solcontent/projects
router.post('/projects', async (req, res) => {
  try {
    const { name, keywords } = req.body;
    if (!name || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Name and keywords array required' });
    }
    projects[name.toUpperCase()] = keywords;
    console.log('[API] Projects updated:', projects);
    res.status(201).json({ message: `Project ${name} added`, projects });
  } catch (err) {
    console.error('[API] Error in /projects:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// GET /solcontent/projects
router.get('/projects', (req, res) => {
  console.log('[API] Listing projects:', Object.keys(projects));
  res.json(projects);
});

module.exports = router;

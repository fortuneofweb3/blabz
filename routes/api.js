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

// Analyze content with AI
async function analyzeContent(tweet) {
  const text = tweet.text;
  try {
    // Sentiment analysis
    const sentiment = await hf.textClassification({
      model: 'nlptown/bert-base-multilingual-uncased-sentiment',
      inputs: text
    });
    const sentimentScore = sentiment[0].label.includes('positive') ? 0.8 : sentiment[0].label.includes('neutral') ? 0.6 : 0.4;

    // Zero-shot classification for content type
    const classification = await hf.zeroShotClassification({
      model: 'facebook/bart-large-mnli',
      inputs: text,
      parameters: {
        candidate_labels: ['informative', 'hype', 'logical', 'spam', 'incoherent']
      }
    });

    const scores = classification.scores.reduce((acc, score, i) => {
      acc[classification.labels[i]] = score;
      return acc;
    }, {});

    console.log(`[API] Content analysis: ${JSON.stringify(scores)}`);

    // Reasoning logic
    const isValid = scores.informative > 0.3 || scores.hype > 0.3 || scores.logical > 0.3;
    const isSpam = scores.spam > 0.5 || scores.incoherent > 0.5 || text.length < 15 || text.includes('giveaway');

    return {
      isValid,
      isSpam,
      sentimentScore,
      informativeScore: scores.informative,
      hypeScore: scores.hype,
      logicalScore: scores.logical
    };
  } catch (err) {
    console.error('[API] Content analysis error:', err.message);
    return { isValid: false, isSpam: true, sentimentScore: 0.6, informativeScore: 0, hypeScore: 0, logicalScore: 0 };
  }
}

// Calculate quality score
function calculateQualityScore(analysis, tweet) {
  let qualityScore = analysis.sentimentScore * 50; // Base score (0-50)

  // Boost for informative, hype, logical content
  qualityScore += analysis.informativeScore * 20;
  qualityScore += analysis.hypeScore * 15;
  qualityScore += analysis.logicalScore * 15;

  // Additional heuristics
  const text = tweet.text.toLowerCase();
  if (text.match(/(https?:\/\/[^\s]+)|(\d+%|\$\d+)|blockchain|solana|smart contract|defi|nft/i)) {
    qualityScore += 10;
    console.log('[API] Boosted score for informative content');
  }
  if (text.match(/how to|guide|tutorial|learn|explain|step by step/i)) {
    qualityScore += 10;
    console.log('[API] Boosted score for educational content');
  }
  if (text.match(/announc|update|new|launch|reveal|break|exclusive/i)) {
    qualityScore += 5;
    console.log('[API] Boosted score for revealing content');
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
      // Check if tweet was processed
      const processedPost = await ProcessedPost.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);
      const existingPost = await Post.findOne({ postId: tweet.id }).lean().maxTimeMS(5000);

      if (existingPost) {
        // Tweet was previously selected, include it
        console.log(`[API] Including previously selected tweet ${tweet.id}`);
        const project = existingPost.project;
        curatedPosts.posts[project] = curatedPosts.posts[project] || [];
        curatedPosts.posts[project].push({
          content: existingPost.content,
          score: existingPost.score,
          likes: existingPost.likes,
          createdAt: existingPost.createdAt
        });
        continue;
      }

      if (processedPost) {
        // Skip if processed but not selected
        console.log(`[API] Skipping tweet ${tweet.id}: Already processed, not selected`);
        continue;
      }

      // Mark as processed
      await new ProcessedPost({ postId: tweet.id }).save();
      console.log(`[API] Marked tweet ${tweet.id} as processed`);

      // AI content analysis
      const analysis = await analyzeContent(tweet);
      if (!analysis.isValid || analysis.isSpam) {
        console.log(`[API] Filtered as spam or invalid: ${tweet.text.substring(0, 50)}...`);
        continue;
      }

      const text = tweet.text.toLowerCase();
      console.log(`[API] Processing tweet: ${text.substring(0, 50)}...`);

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

      const qualityScore = calculateQualityScore(analysis, tweet);
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

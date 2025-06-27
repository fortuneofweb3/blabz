const express = require('express');
const cors = require('cors');
const redis = require('redis');
const router = express.Router();
const { TwitterApi } = require('twitter-api-v2');
const PQueue = require('p-queue').default;
const Post = require('../models/Post');
const Project = require('../models/Project');
const User = require('../models/User');
const crypto = require('crypto');

const queue = new PQueue({ concurrency: 1 });

const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
redisClient.on('error', err => console.error('[Redis] Error:', err));
redisClient.connect().then(() => console.log('[Redis] Connected'));

if (!process.env.X_BEARER_TOKEN || !process.env.MONGODB_URI) {
  console.error('[API] Error: Required environment variables not set');
  throw new Error('Required environment variables not set');
}
const client = new TwitterApi(process.env.X_BEARER_TOKEN);

router.use(cors());

const cacheMiddleware = async (req, res, next) => {
  let cacheKey = `${req.method}:${req.originalUrl}`;
  if (req.method === 'POST' && req.originalUrl === '/solcontent/users') {
    const bodyHash = crypto.createHash('md5').update(JSON.stringify(req.body)).digest('hex');
    cacheKey = `${cacheKey}:${bodyHash}`;
  }
  try {
    const cached = await redisClient.get(cacheKey);
    const cacheTime = await redisClient.get(`${cacheKey}:time`);
    const now = Date.now();
    const cacheAge = cacheTime ? (now - parseInt(cacheTime)) / 1000 : Infinity;
    if (cached && cacheAge < 180) {
      console.log(`[Cache] Hit for ${cacheKey} (age: ${cacheAge}s)`);
      res.setHeader('Content-Type', 'application/json');
      res.end(cached);
      return;
    }
    console.log(`[Cache] Miss for ${cacheKey} (age: ${cacheAge}s)`);
  } catch (err) {
    console.error('[Cache] Error:', err.message);
  }
  const originalJson = res.json;
  res.json = async (data) => {
    try {
      await redisClient.setEx(cacheKey, 180, JSON.stringify(data));
      await redisClient.setEx(`${cacheKey}:time`, 180, Date.now().toString());
      console.log(`[Cache] Stored for ${cacheKey} (expires in 180s)`);
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
    `GET:/solcontent/user-details/${username}`,
    `GET:/solcontent/posts/${username}`,
    `POST:/solcontent/users:${username}`
  ];
  try {
    for (const cacheKey of cacheKeys) {
      const keys = await redisClient.keys(`${cacheKey}*`);
      for (const key of keys) {
        await redisClient.del(key);
        await redisClient.del(`${key}:time`);
        console.log(`[Cache] Invalidated cache for ${key}`);
      }
    }
  } catch (err) {
    console.error(`[Cache] Error invalidating cache:`, err.message);
  }
}

async function retryRequest(fn, cacheKey, res, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await queue.add(async () => {
        const response = await fn();
        if (response.headers) {
          console.log(`[API] Rate Limits: Remaining=${response.headers['x-rate-limit-remaining'] || 'unknown'}, Reset=${response.headers['x-rate-limit-reset'] || 'unknown'}`);
        }
        return response;
      });
      return result;
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
            : 180;
          console.warn(`[API] 429 Rate Limit: Waiting ${retryAfter}s`);
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
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
    }
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

function calculateQualityScore(tweet, followersCount) {
  const lengthScore = Math.min(Math.max((tweet.text.length - 50) / 200, 0), 1);
  const { like_count, retweet_count, quote_count } = tweet.public_metrics;
  const engagementRaw = like_count + 2 * retweet_count + 3 * quote_count;
  const engagementScore = Math.min(engagementRaw / Math.max(1, followersCount), 1);
  const sentimentScore = 0.5; // Placeholder
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
      return res.status(400).json({ error: 'Invalid SOL_ID format (must be 32-44 Base58 characters)' });
    }
    if (!isValidDevId(DEV_ID)) {
      return res.status(400).json({ error: 'Invalid DEV_ID format (must be alphanumeric, 8-64 characters)' });
    }

    const existingUser = await User.findOne({
      $or: [{ SOL_ID, username: { $ne: username } }, { DEV_ID, username: { $ne: username } }]
    });
    if (existingUser) {
      return res.status(400).json({
        error: `SOL_ID ${SOL_ID} or DEV_ID ${DEV_ID} is already associated with username ${existingUser.username}`
      });
    }

    let twitterUser;
    const cacheKey = `GET:/solcontent/user-details/${username}`;
    twitterUser = await retryRequest(
      () =>
        client.v2.userByUsername(username, {
          'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location', 'created_at']
        }),
      cacheKey,
      res
    );
    if (!twitterUser || !twitterUser.data) {
      return res.status(404).json({ error: 'Twitter user not found' });
    }

    const userData = {
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
      updated_at: new Date()
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
      return res.status(400).json({
        error: `Duplicate key error: ${err.keyValue ? Object.keys(err.keyValue).join(', ') : 'unknown field'}`
      });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/user-details/:username', cacheMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    const { username } = req.params;
    console.log(`[API] Fetching user details for: ${username}`);

    const userDoc = await User.findOne({ username }).lean();
    if (userDoc && (Date.now() - new Date(userDoc.updated_at).getTime()) / 1000 < 180) {
      console.log(`[MongoDB] Serving user ${username} from database (fresh)`);
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

    let twitterUser = await retryRequest(
      () =>
        client.v2.userByUsername(username, {
          'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'created_at', 'location']
        }),
      cacheKey,
      res
    );
    if (!twitterUser || !twitterUser.data) {
      if (userDoc && !res.headersSent) {
        console.log(`[MongoDB] Serving user ${username} from database (stale)`);
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
      return res.status(404).json({ error: 'User not found in database or Twitter' });
    }

    const userData = {
      SOL_ID: userDoc?.SOL_ID || `TEMP_${username}_${Date.now()}`,
      DEV_ID: userDoc?.DEV_ID || `TEMP_${username}_${Date.now()}`,
      userId: twitterUser.data.id,
      username: twitterUser.data.username,
      name: twitterUser.data.name || '',
      profile_image_url: twitterUser.data.profile_image_url || '',
      followers_count: twitterUser.data.public_metrics?.followers_count || 0,
      following_count: twitterUser.data.public_metrics?.following_count || 0,
      bio: twitterUser.data.description || '',
      location: twitterUser.data.location || '',
      created_at: twitterUser.data.created_at ? new Date(twitterUser.data.created_at) : undefined,
      updated_at: new Date()
    };

    const user = await User.findOneAndUpdate(
      { username },
      { $set: userData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`[MongoDB] User ${username} updated from Twitter`);
    await invalidateCache(username);

    res.json({
      SOL_ID: user.SOL_ID || '',
      DEV_ID: user.DEV_ID || '',
      userId: user.userId,
      username: user.username,
      name: user.name,
      profile_image_url: user.profile_image_url,
      followers_count: user.followers_count,
      following_count: user.following_count,
      bio: user.bio || '',
      location: user.location || '',
      created_at: user.created_at
    });
  } catch (err) {
    console.error('[API] Error in /user-details/:username:', err.message);
    const userDoc = await User.findOne({ username: req.params.username }).lean();
    if (userDoc && !res.headersSent) {
      console.log(`[MongoDB] Serving user ${req.params.username} from database (error fallback)`);
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
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/posts/:username', cacheMiddleware, async (req, res) => {
  const cacheKey = `${req.method}:${req.originalUrl}`;
  try {
    const { username } = req.params;
    console.log(`[API] Fetching posts for user: ${username}`);

    let userDoc = await User.findOne({ username }).lean();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dbProjects = await Project.find().lean();
    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });

    const dbPosts = await Post.find({
      userId: userDoc?.userId,
      createdAt: { $gte: sevenDaysAgo },
      tweetType: { $in: ['main', 'quote'] }
    }).lean();

    dbPosts.forEach(post => {
      const postData = {
        SOL_ID: post.SOL_ID || userDoc?.userId || '',
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
    if (totalPosts > 0 && userDoc?.updated_at && (Date.now() - new Date(userDoc.updated_at).getTime()) / 1000 < 180) {
      console.log(`[API] Returning ${totalPosts} posts from database for ${username} (fresh)`);
      return res.json({ posts: categorizedPosts });
    }

    if (!userDoc) {
      let twitterUser = await retryRequest(
        () =>
          client.v2.userByUsername(username, {
            'user.fields': ['id', 'name', 'username', 'profile_image_url', 'public_metrics', 'description', 'location', 'created_at']
          }),
        `GET:/solcontent/user-details/${username}`,
        res
      );
      if (!twitterUser || !twitterUser.data) {
        return res.status(404).json({ error: 'Twitter user not found', posts: {} });
      }
      const userData = {
        SOL_ID: `TEMP_${username}_${Date.now()}`,
        DEV_ID: `TEMP_${username}_${Date.now()}`,
        userId: twitterUser.data.id,
        username: twitterUser.data.username,
        name: twitterUser.data.name || '',
        profile_image_url: twitterUser.data.profile_image_url || '',
        followers_count: twitterUser.data.public_metrics?.followers_count || 0,
        following_count: twitterUser.data.public_metrics?.following_count || 0,
        bio: twitterUser.data.description || '',
        location: twitterUser.data.location || '',
        created_at: twitterUser.data.created_at ? new Date(twitterUser.data.created_at) : undefined,
        updated_at: new Date()
      };
      userDoc = await User.findOneAndUpdate(
        { username },
        { $set: userData },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      console.log(`[MongoDB] Auto-registered user ${username}`);
      await invalidateCache(username);
    }

    if (!dbProjects.length) {
      console.warn('[MongoDB] No projects found');
      return res.status(200).json({ message: 'No projects configured, no posts available', posts: {} });
    }

    let twitterUser = await retryRequest(
      () =>
        client.v2.userByUsername(username, {
          'user.fields': ['id', 'public_metrics']
        }),
      cacheKey,
      res
    );
    if (!twitterUser || !twitterUser.data) {
      twitterUser = { data: { id: userDoc.userId, public_metrics: { followers_count: userDoc.followers_count || 0 } } };
    }
    const userId = twitterUser.data.id;
    const followersCount = twitterUser.data.public_metrics?.followers_count || 0;

    let tweets = await retryRequest(
      () =>
        client.v2.userTimeline(userId.toString(), {
          'tweet.fields': ['created_at', 'public_metrics', 'text', 'referenced_tweets'],
          'expansions': ['referenced_tweets.id'],
          exclude: ['retweets'],
          max_results: 50,
          start_time: sevenDaysAgo.toISOString()
        }),
      cacheKey,
      res
    );

    if (!tweets) {
      console.log(`[API] No tweets fetched, checking database for ${username}`);
      if (totalPosts > 0) {
        console.log(`[API] Returning ${totalPosts} posts from database for ${username} (API failed)`);
        return res.json({ posts: categorizedPosts });
      }
      return res.status(200).json({ message: 'No tweets fetched due to rate limits or errors', posts: {} });
    }

    console.log(`[Twitter] Fetched ${tweets.meta?.result_count || 0} tweets for user ${username}`);

    if (tweets.meta.result_count) {
      for await (const tweet of tweets) {
        if (tweet.text.length < 51) continue;
        const mentionChars = extractMentions(tweet.text);
        const totalChars = tweet.text.length;
        const mentionRatio = mentionChars / totalChars;
        const nonMentionText = tweet.text.replace(/@(\w+)/g, '').replace(/\s+/g, ' ').trim();
        if (mentionRatio > 0.6 || nonMentionText.length < 10) continue;

        let tweetType = 'main';
        if (tweet.referenced_tweets?.length) {
          const refTweet = tweet.referenced_tweets[0];
          tweetType = refTweet.type === 'replied_to' ? 'reply' : refTweet.type === 'quoted' ? 'quote' : 'main';
        }
        if (tweetType === 'reply') continue;

        const existingPost = await Post.findOne({ postId: tweet.id }).lean();
        if (existingPost) continue;

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
            matchedProjects.push(project.name.toUpperCase());
          }
        }
        if (!matchedProjects.length) continue;

        const qualityScore = calculateQualityScore(tweet, followersCount);
        const projectBlabz = parseFloat(calculateBlabzPerProject(qualityScore));
        const totalBlabz = (projectBlabz * matchedProjects.length).toFixed(4);

        const post = new Post({
          SOL_ID: userDoc.SOL_ID || userId,
          DEV_ID: userDoc.DEV_ID || '',
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
          additionalFields: { quote_count: tweet.public_metrics.quote_count }
        });
        await post.save();
        console.log(`[MongoDB] Saved post for ${username}, projects: ${matchedProjects.join(', ')}, postId: ${tweet.id}`);

        matchedProjects.forEach(project => {
          categorizedPosts[project].push({
            SOL_ID: userDoc.SOL_ID || userId,
            DEV_ID: userDoc.DEV_ID || '',
            userId,
            username,
            postId: tweet.id,
            content: tweet.text,
            project: matchedProjects,
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
        });
      }
    }

    const totalPosts = Object.values(categorizedPosts).reduce((sum, posts) => sum + posts.length, 0);
    if (totalPosts === 0) {
      console.log(`[API] No posts found for ${username}, returning empty object`);
      return res.status(200).json({ message: 'No posts or quotes found for this user', posts: {} });
    }

    for (const project in categorizedPosts) {
      const seenPostIds = new Set();
      categorizedPosts[project] = categorizedPosts[project].filter(post => {
        if (seenPostIds.has(post.postId)) return false;
        seenPostIds.add(post.postId);
        return true;
      });
      categorizedPosts[project].sort((a, b) => b.score - a.score);
    }

    await User.findOneAndUpdate({ username }, { $set: { updated_at: new Date() } });
    console.log(`[API] Returning ${totalPosts} posts for ${username}`);
    res.json({ posts: categorizedPosts });
  } catch (err) {
    console.error('[API] Error in GET /posts/:username:', err.message);
    const dbPosts = await Post.find({
      username,
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      tweetType: { $in: ['main', 'quote'] }
    }).lean();
    const dbProjects = await Project.find().lean();
    const categorizedPosts = {};
    dbProjects.forEach(project => {
      categorizedPosts[project.name.toUpperCase()] = [];
    });
    dbPosts.forEach(post => {
      const postData = {
        SOL_ID: post.SOL_ID || '',
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
    console.log(`[API] Returning ${totalPosts} posts from database for ${username} (error fallback)`);
    res.json({ posts: categorizedPosts });
  }
});

router.post('/projects', cacheMiddleware, async (req, res) => {
  try {
    const { name, keywords, description, website } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name required' });
    }
    const validatedKeywords = Array.isArray(keywords)
      ? keywords
      : keywords === null || keywords === undefined || keywords === 'null' || keywords === ''
      ? []
      : [String(keywords)];
    const project = await Project.findOneAndUpdate(
      { name: name.toUpperCase() },
      {
        name: name.toUpperCase(),
        keywords: validatedKeywords,
        description: description || '',
        website: website || '',
        verified: false,
        updated_at: new Date()
      },
      { upsert: true, new: true }
    );
    res.json({ message: `Project ${name.toLowerCase()} added`, project });
  } catch (err) {
    console.error('[API] Error adding project:', err.message);
    res.status(400).json({ error: 'Server error', details: err.message });
  }
});

router.post('/projects/:project/verify', cacheMiddleware, async (req, res) => {
  try {
    const project = await Project.findOneAndUpdate(
      { name: req.params.project.toUpperCase() },
      { $set: { verified: true, updated_at: new Date() } },
      { new: true }
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ message: 'Project verified', project });
  } catch (err) {
    console.error('[API] Error verifying project:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

router.get('/projects/verified', cacheMiddleware, async (req, res) => {
  try {
    const verifiedProjects = await Project.find({ verified: true }).lean();
    res.json({ projects: verifiedProjects });
  } catch (err) {
    console.error('[API] Error fetching verified projects:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;

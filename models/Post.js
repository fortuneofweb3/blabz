const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  postId: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  project: [{ type: String }], // Array of project names (e.g., ["DEVFUN", "SOLANA"])
  projects: [{
    project: { type: String, required: true },
    blabz: { type: Number, required: true }
  }], // Array of { project, blabz } for rewards
  score: { type: Number, required: true },
  blabz: { type: Number, required: true }, // Base Blabz for the post
  likes: { type: Number, default: 0 },
  retweets: { type: Number, default: 0 },
  replies: { type: Number, default: 0 },
  hashtags: [{ type: String }],
  tweetUrl: { type: String, required: true }, // URL to the tweet
  createdAt: { type: Date, required: true },
  additionalFields: { type: Object }
}, { timestamps: true });

module.exports = mongoose.model('Post', postSchema);

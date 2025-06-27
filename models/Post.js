// models/Post.js
const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  SOL_ID: { type: String, required: true },
  DEV_ID: { type: String, required: true },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  postId: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  project: [{ type: String }],
  projects: [{
    project: { type: String },
    blabz: { type: Number }
  }],
  score: { type: Number, required: true },
  blabz: { type: Number, required: true },
  likes: { type: Number, default: 0 },
  retweets: { type: Number, default: 0 },
  replies: { type: Number, default: 0 },
  hashtags: [{ type: String }],
  tweetUrl: { type: String, required: true },
  createdAt: { type: Date, required: true },
  tweetType: { type: String, required: true },
  additionalFields: { type: Object, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('Post', PostSchema);

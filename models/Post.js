const mongoose = require('mongoose');

const PostSchema = new mongoose.Schema({
  SOL_ID: { type: String, required: true },
  DEV_ID: { type: String, default: '' },
  userId: { type: String, required: true },
  username: { type: String, required: true },
  postId: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  project: [{ type: String }], // Array of project names
  projects: [{
    project: { type: String },
    blabz: { type: String }
  }],
  score: { type: Number, required: true },
  blabz: { type: String, required: true },
  likes: { type: Number, default: 0 },
  retweets: { type: Number, default: 0 },
  replies: { type: Number, default: 0 },
  hashtags: [{ type: String }],
  tweetUrl: { type: String, required: true },
  createdAt: { type: Date, required: true },
  tweetType: { type: String, enum: ['main', 'reply', 'quote'], default: 'main' },
  additionalFields: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('Post', PostSchema);

const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  username: { type: String, required: true },
  postId: { type: String, required: true, unique: true },
  content: String,
  project: [String],
  score: Number,
  likes: Number,
  retweets: Number,
  replies: Number,
  hashtags: [String],
  createdAt: Date,
  additionalFields: Object
});

module.exports = mongoose.model('Post', postSchema);

const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: String,
  postId: String,
  content: String,
  project: String,
  score: Number,
  likes: Number,
  retweets: Number,
  hashtags: [String],
  createdAt: Date,
  username: String, // Added for community feed
  additionalFields: Object
});

module.exports = mongoose.model('Post', postSchema);

const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: String, required: true }, // Links to user
  username: { type: String, required: true }, // Stores username for display
  postId: { type: String, required: true, unique: true },
  content: String,
  project: String,
  score: Number,
  likes: Number,
  retweets: Number,
  replies: Number, // Added for comments
  hashtags: [String],
  createdAt: Date,
  additionalFields: Object
});

module.exports = mongoose.model('Post', postSchema);

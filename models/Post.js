const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  postId: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  project: { type: String, required: true },
  score: { type: Number, required: true },
  likes: { type: Number, required: true },
  createdAt: { type: Date, required: true }
});

module.exports = mongoose.model('Post', postSchema);
// models/ProcessedPost.js
const mongoose = require('mongoose');

const ProcessedPostSchema = new mongoose.Schema({
  postId: { type: String, required: true, unique: true }
}, { timestamps: true });

module.exports = mongoose.model('ProcessedPost', ProcessedPostSchema);

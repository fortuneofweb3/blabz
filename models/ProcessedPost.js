const mongoose = require('mongoose');
const processedPostSchema = new mongoose.Schema({
  postId: { type: String, required: true, unique: true },
  processedAt: { type: Date, default: Date.now }
});
module.exports = mongoose.model('ProcessedPost', processedPostSchema);

const mongoose = require('mongoose');
const postSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  postId: { type: String, required: true, unique: true },
  content: { type: String, required: true },
  project: { type: String, required: true },
  score: { type: Number, required: true },
  likes: { type: Number, default: 0 },
  retweets: { type: Number, default: 0 },
  hashtags: [{ type: String }],
  createdAt: { type: Date, required: true },
  additionalFields: { type: Object }
});
module.exports = mongoose.model('Post', postSchema);

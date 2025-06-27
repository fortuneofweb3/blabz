const mongoose = require('mongoose');

const processedPostSchema = new mongoose.Schema({
  tweetId: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: String,
    required: true
  },
  qualityScore: {
    type: Number,
    required: true
  },
  blabzPerProject: {
    type: Number,
    required: true
  },
  project: {
    type: String,
    required: true
  }
}, { timestamps: true });

module.exports = mongoose.model('ProcessedPost', processedPostSchema);

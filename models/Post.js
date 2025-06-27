const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  tweetId: {
    type: String,
    required: true,
    unique: true
  },
  text: {
    type: String,
    required: true
  },
  created_at: {
    type: Date,
    required: true
  },
  public_metrics: {
    like_count: { type: Number, default: 0 },
    retweet_count: { type: Number, default: 0 },
    quote_count: { type: Number, default: 0 },
    reply_count: { type: Number, default: 0 }
  }
}, { timestamps: true });

module.exports = mongoose.model('Post', postSchema);

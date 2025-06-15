const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  SOL_ID: {
    type: String,
    required: true,
    unique: true
  },
  DEV_ID: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: String,
    required: true
  },
  username: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    default: ''
  },
  profile_image_url: {
    type: String,
    default: ''
  },
  followers_count: {
    type: Number,
    default: 0
  },
  following_count: {
    type: Number,
    default: 0
  },
  bio: {
    type: String,
    default: ''
  },
  location: {
    type: String,
    default: ''
  },
  created_at: {
    type: Date
  },
  additionalFields: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('User', userSchema);

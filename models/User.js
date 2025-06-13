const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  profile_image_url: { type: String },
  followers_count: { type: Number, default: 0 },
  following_count: { type: Number, default: 0 },
  bio: { type: String },
  location: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  additionalFields: { type: Object }
});
userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});
module.exports = mongoose.model('User', userSchema);

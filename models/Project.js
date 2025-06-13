const mongoose = require('mongoose');
const projectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, uppercase: true },
  keywords: [{ type: String, required: true }],
  description: { type: String },
  website: { type: String },
  createdAt: { type: Date, default: Date.now },
  additionalProjectFields: { type: Object }
});
module.exports = mongoose.model('Project', projectSchema);

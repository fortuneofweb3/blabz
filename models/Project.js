const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true, uppercase: true },
  keywords: [{ type: String, required: true }],
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Project', projectSchema);

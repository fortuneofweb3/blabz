// models/Project.js
const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  keywords: [{ type: String }],
  description: { type: String },
  website: { type: String },
  attributes: { type: Object, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('Project', ProjectSchema);

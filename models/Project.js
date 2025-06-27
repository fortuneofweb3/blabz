const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  keywords: [{ type: String }],
  description: { type: String, default: '' },
  website: { type: String, default: '' },
  verified: { type: Boolean, default: false },
  additionalProjectFields: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('Project', ProjectSchema);

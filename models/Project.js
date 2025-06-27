const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
  },
  keywords: {
    type: [String],
    default: [],
    set: v => (v === null || v === undefined || v === "null" ? [] : Array.isArray(v) ? v : [String(v)])
  },
  description: {
    type: String,
    default: ''
  },
  website: {
    type: String,
    default: ''
  },
  verified: {
    type: Boolean,
    default: false
  },
  additionalProjectFields: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true
});

projectSchema.pre('save', function(next) {
  if (this.keywords === null || this.keywords === undefined || this.keywords === "null" || !Array.isArray(this.keywords)) {
    this.keywords = [];
  }
  next();
});

module.exports = mongoose.model('Project', projectSchema);

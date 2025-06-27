// index.js
const express = require('express');
const mongoose = require('mongoose');
require('dotenv').config();
const apiRoutes = require('./routes/api');

const app = express();

// Middleware
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('[MongoDB] Connected'))
  .catch(err => console.error('[MongoDB] Error:', err));

// Routes
app.use('/solcontent', apiRoutes);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

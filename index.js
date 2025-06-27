const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '.env') });

if (!process.env.X_BEARER_TOKEN || !process.env.MONGODB_URI || !process.env.HUGGINGFACE_API_KEY) {
  console.error('Error: Missing required environment variables');
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cors());

const connectWithRetry = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      connectTimeoutMS: 30000,
      socketTimeoutMS: 30000,
      maxPoolSize: 10,
      retryWrites: true,
      w: 'majority'
    });
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    console.log('Retrying in 5 seconds...');
    setTimeout(connectWithRetry, 5000);
  }
};
connectWithRetry();

const apiRoutes = require('./routes/api');
app.use('/solcontent', apiRoutes);

app.get('/', (req, res) => res.send('SolContent is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
}).on('error', (err) => {
  console.error('Server error:', err.message);
  process.exit(1);
});

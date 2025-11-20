import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { verifyClaim } from './services/aiService.js';
import { publishAsset } from './services/dkgService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.post('/api/analyze', async (req, res) => {
  try {
    const { claim } = req.body;
    if (!claim) {
      return res.status(400).json({ error: 'Claim is required' });
    }
    const result = await verifyClaim(claim);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/analyze:', error);
    res.status(500).json({ error: 'Failed to analyze claim' });
  }
});

app.post('/api/publish', async (req, res) => {
  try {
    const data = req.body;
    // Basic validation
    if (!data || !data.claim || !data.verdict) {
      return res.status(400).json({ error: 'Invalid payload for publishing' });
    }
    const result = await publishAsset(data);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/publish:', error);
    res.status(500).json({ error: 'Failed to publish asset' });
  }
});

// Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);

  // Log Environment Status
  if (process.env.OPENAI_API_KEY) {
    console.log('OPENAI_API_KEY is set. AI Service will use OpenAI.');
  } else {
    console.log('OPENAI_API_KEY is missing. AI Service will use MOCK mode.');
  }

  if (process.env.DKG_PRIVATE_KEY && process.env.DKG_TESTNET_ENDPOINT) {
    console.log('DKG credentials present. DKG Service will attempt real publish.');
  } else {
    console.log('DKG credentials missing. DKG Service will use SIMULATED mode.');
  }
});

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Import the new services
import { fetchGrokEntry } from './services/xaiService.js';
import { fetchConsensus } from './services/consensusService.js';
import { analyzeDiscrepancy } from './services/analysisService.js';
import { mintCommunityNote } from './services/dkgService.js';

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Load bounties from the JSON file
const bounties = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/bounties.json'), 'utf-8'));

// In-memory database for poison pills
const poisonPills = [];

// --- API Routes ---

// GET /api/bounties
app.get('/api/bounties', (req, res) => {
  res.json(bounties);
});

// POST /api/fetch-grok
app.post('/api/fetch-grok', async (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic is required' });

  try {
    const result = await fetchGrokEntry(topic);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/fetch-consensus
app.post('/api/fetch-consensus', async (req, res) => {
  const { topic, source } = req.body;
  if (!topic || !source) return res.status(400).json({ error: 'Topic and source are required' });

  try {
    const result = await fetchConsensus(topic, source);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/analyze
app.post('/api/analyze', async (req, res) => {
  const { suspectText, consensusText } = req.body;
  if (!suspectText || !consensusText) return res.status(400).json({ error: 'Suspect and consensus text are required' });

  try {
    const result = await analyzeDiscrepancy(suspectText, consensusText);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/publish
app.post('/api/publish', async (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Data is required for publishing' });

  try {
    const result = await mintCommunityNote(data);
    // Add the asset to the poison pills list
    poisonPills.push({ topic: data.topic, assetId: result.ual });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/agent-guard
app.post('/api/agent-guard', (req, res) => {
  const { topic } = req.body;
  if (!topic) return res.status(400).json({ error: 'Topic is required' });

  const blocked = poisonPills.find(pill => pill.topic.toLowerCase() === topic.toLowerCase());

  if (blocked) {
    res.json({ blocked: true, assetId: blocked.assetId });
  } else {
    res.json({ blocked: false });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

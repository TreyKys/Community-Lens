import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import { analyzeText } from './services/aiService.js';
import { publishToDKG } from './services/dkgService.js';
import caseStudies from './data/caseStudies.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get Case Studies (Optional Helper)
app.get('/api/cases', (req, res) => {
  res.json(caseStudies);
});

// Fetch from Wikipedia
app.get('/api/wiki', async (req, res) => {
  const { topic } = req.query;
  if (!topic) {
    return res.status(400).json({ error: 'Topic parameter is required' });
  }

  // Check for local case study override to ensure perfect demo alignment
  const localCase = caseStudies.find(c => c.topic.toLowerCase().includes(topic.toLowerCase()) || c.id === topic);
  if (localCase && process.env.SEARCH_PROVIDER !== 'wikipedia') { // Allow force override if desired, but usually fallback is enough
      // If we have specific 'wikiText' in our mock data, we might prefer returning that
      // if we want to guarantee the comparison works exactly as designed in the demo.
      // However, the prompt asks to fetch real data if possible.
      // Let's try fetching real data first, if it fails or is too short, use local.
  }

  try {
    const response = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'query',
        format: 'json',
        prop: 'extracts',
        exintro: true,
        explaintext: true,
        titles: topic,
        origin: '*'
      }
    });

    const pages = response.data.query.pages;
    const pageId = Object.keys(pages)[0];

    if (pageId === '-1') {
        // Page not found, try to use fallback from case studies if available
        if (localCase) {
            return res.json({ extract: localCase.wikiText, source: 'local_fallback' });
        }
        return res.status(404).json({ error: 'Wikipedia page not found' });
    }

    const extract = pages[pageId].extract;
    res.json({ extract });

  } catch (error) {
    console.error('Wiki fetch error:', error);
    // Fallback
    if (localCase) {
        return res.json({ extract: localCase.wikiText, source: 'local_fallback' });
    }
    res.status(500).json({ error: 'Failed to fetch from Wikipedia' });
  }
});

// Analyze Text
app.post('/api/analyze', async (req, res) => {
  const { grokText, wikiText, topic } = req.body;

  if (!grokText || !wikiText) {
    return res.status(400).json({ error: 'Missing text content' });
  }

  try {
    const analysis = await analyzeText(grokText, wikiText, topic);
    res.json(analysis);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Publish to DKG
app.post('/api/publish', async (req, res) => {
  const { claim, analysis, stakeAmount } = req.body;

  if (!claim || !analysis) {
    return res.status(400).json({ error: 'Missing claim or analysis data' });
  }

  try {
    const result = await publishToDKG(claim, analysis, stakeAmount);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

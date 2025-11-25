import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { fetchGrokipediaEntry } from './services/xaiService.js';
import { compareSources } from './services/openaiService.js';
import { publishToDKG } from './services/dkgService.js';
import caseStudies from './data/caseStudies.js';

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors()); // Enable CORS for all routes (including Netlify frontend)
app.use(express.json());

// Poison Pills Storage (Simple JSON file persistence)
const POISON_PILLS_FILE = path.join(__dirname, 'poison_pills.json');

// Initialize poison pills file if not exists
if (!fs.existsSync(POISON_PILLS_FILE)) {
    fs.writeFileSync(POISON_PILLS_FILE, JSON.stringify([], null, 2));
}

const getPoisonPills = () => {
    try {
        const data = fs.readFileSync(POISON_PILLS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Error reading poison pills:", err);
        return [];
    }
};

const savePoisonPill = (pill) => {
    const pills = getPoisonPills();
    pills.push(pill);
    fs.writeFileSync(POISON_PILLS_FILE, JSON.stringify(pills, null, 2));
};

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/cases: Return seed data
app.get('/api/cases', (req, res) => {
  res.json(caseStudies);
});

// POST /api/fetch-dual: Concurrent Fetch
app.post('/api/fetch-dual', async (req, res) => {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic required" });

    try {
        // 1. Fetch Grokipedia (xAI)
        const grokPromise = fetchGrokipediaEntry(topic);

        // 2. Fetch Wikipedia
        const wikiPromise = axios.get('https://en.wikipedia.org/w/api.php', {
            params: {
                action: 'query',
                format: 'json',
                prop: 'extracts',
                exintro: true,
                explaintext: true,
                titles: topic,
                origin: '*'
            }
        }).then(response => {
            const pages = response.data.query.pages;
            const pageId = Object.keys(pages)[0];
            return pageId === '-1' ? "Wikipedia entry not found." : pages[pageId].extract;
        });

        const [grokText, wikiText] = await Promise.all([grokPromise, wikiPromise]);

        res.json({ grokText, wikiText });

    } catch (error) {
        console.error("Dual Fetch Error:", error);
        res.status(500).json({ error: "Failed to fetch sources." });
    }
});

// POST /api/analyze: Compare Sources (Judge)
app.post('/api/analyze', async (req, res) => {
    const { grokText, wikiText } = req.body;
    if (!grokText || !wikiText) return res.status(400).json({ error: "Missing texts" });

    try {
        const analysis = await compareSources(grokText, wikiText);
        res.json({
            alignmentScore: analysis.score,
            flags: analysis.flags,
            analysis: analysis.analysis
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /api/publish: The Poison Pill
app.post('/api/publish', async (req, res) => {
    const { claim, analysis, stakeAmount } = req.body;
    // claim: { topic, grokText }

    try {
        // 1. Publish to DKG
        const dkgResult = await publishToDKG(claim, analysis, stakeAmount);

        // 2. Save to Poison Pills (The Firewall Ruleset)
        if (dkgResult.status === 'success') {
            const pill = {
                topic: claim.topic,
                assetId: dkgResult.ual,
                score: analysis.alignmentScore,
                timestamp: new Date().toISOString()
            };
            savePoisonPill(pill);
        }

        res.json(dkgResult);
    } catch (error) {
        console.error("Publish Error:", error);
        res.status(500).json({ error: "Failed to publish/mint." });
    }
});

// POST /api/agent-guard: The Real Agent
app.post('/api/agent-guard', async (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Question required" });

    const pills = getPoisonPills();

    // Check if question matches a blocked topic
    // Simple substring match for this demo
    const blockedPill = pills.find(p => question.toLowerCase().includes(p.topic.toLowerCase()));

    if (blockedPill) {
        // BLOCKED
        return res.json({
            blocked: true,
            reason: `Community Lens Asset [${blockedPill.assetId}] flags this topic as misinformation. Score: ${blockedPill.score}/100.`
        });
    }

    // SAFE: Call xAI (Grok)
    try {
        // We reuse fetchGrokipediaEntry or create a new general chat method.
        // fetchGrokipediaEntry is specific to "encyclopedia entry".
        // The prompt says "Call xAI (Grok) to answer the question normally."

        // Let's do a direct call here or reuse the client logic.
        // Importing xAI client would be cleaner, but I'll use a dynamic import or duplicated logic for speed
        // given the constraints, or better yet, export a generic chat function from xaiService.

        // Actually, let's just use fetchGrokipediaEntry logic but modified for "Answer this question".
        // Or I can add a `askGrok` function to `xaiService.js`.
        // For now, I'll assume `fetchGrokipediaEntry` returns an article which is a valid answer,
        // BUT the user might ask a question.

        // I'll quickly add `askGrok` to `xaiService.js` in a moment.
        // For now, I will use a placeholder or assume I will add it.
        // Let's Assume `askGrok` exists.

        const { askGrok } = await import('./services/xaiService.js');
        const answer = await askGrok(question);

        res.json({
            blocked: false,
            answer: answer
        });

    } catch (error) {
        console.error("Agent Guard Error:", error);
        res.status(500).json({ error: "Agent brain failed." });
    }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

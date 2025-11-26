import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';

import { fetchGrokEntry, askGrok } from './services/xaiService.js';
import { fetchConsensus } from './services/consensusService.js';
import { analyzeDiscrepancy } from './services/analysisService.js';
import { mintCommunityNote } from './services/dkgService.js';

// Correctly import JSON
const bounties = JSON.parse(fs.readFileSync('./data/bounties.json', 'utf-8'));

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// HYBRID STORAGE: Initialize poisonPills with Seed Data
let poisonPills = [
    { topic: "Malaria Vaccine R21", status: "BLOCKED", assetId: "did:dkg:otp:2043/0xSeed1" },
    { topic: "Lagos-Abuja Tunnel", status: "BLOCKED", assetId: "did:dkg:otp:2043/0xSeed2" },
    { topic: "Climate Change", status: "BLOCKED", assetId: "did:dkg:otp:2043/0xSeed3" }
];

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET /api/bounties: Return list of bounties
app.get('/api/bounties', (req, res) => {
  res.json(bounties);
});

// POST /api/fetch-grok: Calls xaiService
app.post('/api/fetch-grok', async (req, res) => {
    const { topic } = req.body;
    if (!topic) return res.status(400).json({ error: "Topic is required" });

    try {
        const result = await fetchGrokEntry(topic);
        res.json(result);
    } catch (error) {
        console.error("Fetch Grok Error:", error);
        res.status(500).json({ error: "Failed to fetch from Grokipedia." });
    }
});

// POST /.api/fetch-consensus: Calls consensusService
app.post('/api/fetch-consensus', async (req, res) => {
    const { topic, mode } = req.body; // mode can be 'general' or 'medical'
    if (!topic) return res.status(400).json({ error: "Topic is required" });

    try {
        const consensusText = await fetchConsensus(topic, mode || 'general');
        res.json({ consensusText });
    } catch (error) {
        console.error("Fetch Consensus Error:", error);
        res.status(500).json({ error: "Failed to fetch consensus." });
    }
});

// POST /api/analyze: Calls analysisService
app.post('/api/analyze', async (req, res) => {
    const { suspectText, consensusText, mode } = req.body;
    if (!suspectText || !consensusText) return res.status(400).json({ error: "Both suspect and consensus texts are required" });

    try {
        const analysis = await analyzeDiscrepancy(suspectText, consensusText, mode);
        res.json(analysis);
    } catch (error) {
        console.error("Analysis Error:", error);
        res.status(500).json({ error: "Failed to analyze texts." });
    }
});

// POST /api/publish: Calls dkgService, then adds to poisonPills
app.post('/api/publish', async (req, res) => {
    const { topic, analysis, data } = req.body;
    if (!topic || !analysis || !data) return res.status(400).json({ error: "Missing required data for publishing" });

    try {
        const dkgResult = await mintCommunityNote(data);

        // Add to the active poisonPills array in memory
        const newPill = {
            topic: topic,
            status: "BLOCKED",
            assetId: dkgResult.ual
        };
        poisonPills.push(newPill);

        res.json({ assetId: dkgResult.ual });
    } catch (error) {
        console.error("Publish Error:", error);
        res.status(500).json({ error: "Failed to mint community note." });
    }
});

// POST /api/agent-guard: Checks if topic exists in poisonPills
app.post('/api/agent-guard', async (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: "Question is required" });

    const blockedPill = poisonPills.find(p => question.toLowerCase().includes(p.topic.toLowerCase()));

    if (blockedPill) {
        res.json({
            blocked: true,
            message: `⛔ BLOCKED: Community Note [${blockedPill.assetId}] flags this topic.`
        });
    } else {
        try {
            const answer = await askGrok(question);
            res.json({ blocked: false, message: answer });
        } catch (error) {
            console.error("Agent Guard Error:", error);
            res.status(500).json({ error: "Agent brain failed." });
        }
    }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

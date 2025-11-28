import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import admin from 'firebase-admin';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const app = express();
app.use(express.json());
app.use(cors());

// Initialize Firebase Admin
try {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serviceAccountPath = path.join(__dirname, '..', 'serviceAccount.json');
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'community-lens-dd945'
  });
  console.log('Firebase Admin initialized with Firestore');
} catch (e) {
  console.log('Firebase Admin not configured, running in demo mode:', e.message);
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Mock data for demo mode
let mockBounties = [];
let mockPoisonPills = [];
let mockLeaderboard = [];

// Helper to get firestore or use mock
const getDb = () => {
  try {
    return admin.firestore();
  } catch {
    return null;
  }
};

// 1. createBounty
app.post('/createBounty', async (req, res) => {
  const data = req.body.data || req.body;
  const { userQuery, rewardAmount } = data;

  if (!userQuery || !rewardAmount) {
    return res.status(400).send({ error: "User query and reward amount are required." });
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is missing.");
    }
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const prompt = `Analyze this user query: '${userQuery}'. Extract the core 'Topic' (string), 'Category' (Medical/Infrastructure/Political), and a standardized 'Claim'. Return JSON.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const cleanedJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const extractedData = JSON.parse(cleanedJson);

    const db = getDb();
    let bountyId;
    
    if (db) {
      const bountyRef = db.collection("bounties").doc();
      await bountyRef.set({
        topic: extractedData.Topic || extractedData.topic,
        context: extractedData.Category || extractedData.category,
        claim: extractedData.Claim || extractedData.claim,
        reward: parseInt(rewardAmount),
        status: "OPEN",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        originalQuery: userQuery
      });
      bountyId = bountyRef.id;
    } else {
      bountyId = 'mock_' + Date.now();
      mockBounties.push({
        id: bountyId,
        topic: extractedData.Topic || extractedData.topic,
        context: extractedData.Category || extractedData.category,
        claim: extractedData.Claim || extractedData.claim,
        reward: parseInt(rewardAmount),
        status: "OPEN",
        createdAt: new Date(),
        originalQuery: userQuery
      });
    }

    res.status(200).send({ data: { success: true, bountyId, ...extractedData } });

  } catch (error) {
    console.error("Create Bounty Error:", error);
    res.status(500).send({ error: "Failed to create bounty." });
  }
});

// 2. fetchGrokSource
app.post('/fetchGrokSource', async (req, res) => {
  const data = req.body.data || req.body;
  const { topic } = data;

  if (!topic) {
    return res.status(400).send({ error: "Topic is required." });
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const prompt = `Act as a Web Crawler indexing Grokipedia and X (Twitter).
Task: Retrieve/Synthesize the dominant 'Anti-Establishment' or 'Contrarian' narrative regarding [${topic}].
Tone: Confident, potentially biased, and willing to cite unverified sources (like 'insiders' or 'independent researchers').
Goal: This text will be used to test a Fact-Checking engine, so ensure it reflects the common misconceptions or specific hallucinations associated with this topic on social media.
Return JSON { text: "..." }`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    const cleanedJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const output = JSON.parse(cleanedJson);

    res.status(200).send({ data: { status: "SUCCESS", text: output.text } });

  } catch (error) {
    console.error("Grok Synthesis Error:", error);
    res.status(500).send({ error: "Failed to synthesize Grok source." });
  }
});

// 3. fetchConsensus
app.post('/fetchConsensus', async (req, res) => {
  const data = req.body.data || req.body;
  const { topic, mode } = data;

  if (!topic) {
    return res.status(400).send({ error: "Topic is required." });
  }

  const fetchWikipediaEntry = async (topic) => {
    const url = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=true&explaintext=true&titles=${encodeURIComponent(topic)}&origin=*`;
    try {
      const response = await axios.get(url, { headers: { 'User-Agent': 'CommunityLens/1.0' } });
      const pages = response.data.query.pages;
      const pageId = Object.keys(pages)[0];
      if (pageId === "-1") {
        return "Wikipedia entry not found.";
      }
      return pages[pageId].extract;
    } catch (error) {
      console.error("Wikipedia Fetch Error:", error);
      throw new Error("Failed to fetch from Wikipedia.");
    }
  };

  const fetchPubMedConsensus = async (topic) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is missing in environment.");
      }
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro"});
      const prompt = `You are a Medical Research System connected to the NIH/PubMed Database.
Task: Summarize the strict Clinical Consensus on [${topic}] based on meta-analyses from 2023-2025.
Constraint: Ignore general web results. Focus on efficacy percentages, safety data, and peer-reviewed conclusions. If the topic is non-medical, state 'Invalid Context'.`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error("PubMed Fetch Error details:", error);
      throw new Error(`Failed to fetch PubMed consensus: ${error.message}`);
    }
  };

  try {
    if (mode === 'pubmed' || mode === 'medical') {
      const pubmedText = await fetchPubMedConsensus(topic);
      res.status(200).send({ data: { consensusText: pubmedText } });
    } else {
      const wikiText = await fetchWikipediaEntry(topic);
      res.status(200).send({ data: { consensusText: wikiText } });
    }
  } catch (error) {
    console.error("Fetch Consensus Top-Level Error:", error);
    res.status(500).send({ error: error.message });
  }
});

// 4. analyzeDiscrepancy
app.post('/analyzeDiscrepancy', async (req, res) => {
  const data = req.body.data || req.body;
  const { suspectText, consensusText } = data;

  if (!suspectText || !consensusText) {
    return res.status(400).send({ error: "Both suspect and consensus texts are required." });
  }

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  const prompt = `Compare Text A (Suspect) vs Text B (Consensus).
Scoring Algorithm: Start with a Score of 100.
 * If Factual Hallucination found (e.g., wrong numbers, fake events): DIVIDE Score by 10.
 * If Omission of Context found: DIVIDE Score by 1.5.
 * If Bias/Framing issue found: DIVIDE Score by 2.
Output: JSON { score: number (integer), discrepancies: [{ type: string, text: string, explanation: string }] }.

Text A (Suspect): ${suspectText}
Text B (Consensus): ${consensusText}`;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const cleanedJson = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    res.status(200).send({ data: JSON.parse(cleanedJson) });
  } catch (error) {
    console.error("Analysis Error:", error);
    res.status(500).send({ error: "Failed to analyze texts." });
  }
});

// 5. mintCommunityNote
app.post('/mintCommunityNote', async (req, res) => {
  const data = req.body.data || req.body;
  const { topic, claim, analysis, bountyId, userId, stake, reward } = data;

  if (!topic || !claim || !analysis || !stake) {
    return res.status(400).send({ error: "Missing required data for minting." });
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ClaimReview",
    "claimReviewed": topic,
    "itemReviewed": {
      "@type": "CreativeWork",
      "text": claim
    },
    "author": {
      "@type": "Person",
      "identifier": userId || "Anonymous_Expert"
    },
    "reviewRating": {
      "@type": "Rating",
      "ratingValue": analysis.score,
      "bestRating": "100",
      "worstRating": "0",
      "alternateName": "Alignment Score"
    },
    "interpretationOfClaim": analysis.analysis || "Discrepancy Analysis",
    "resultComment": JSON.stringify(analysis.discrepancies),
    "reputationPledge": stake
  };

  try {
    const hash = crypto.createHash('sha256').update(JSON.stringify(jsonLd)).digest('hex');
    const assetId = `0x${hash}`;

    const db = getDb();
    if (db) {
      const batch = db.batch();

      const poisonPillRef = db.collection("poison_pills").doc();
      batch.set(poisonPillRef, {
        topic,
        assetId,
        status: "BLOCKED",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        jsonLd
      });

      if (bountyId) {
        const bountyRef = db.collection('bounties').doc(bountyId);
        batch.update(bountyRef, { status: 'VERIFIED & COMPLETED' });
      }

      if (userId && reward) {
        const leaderboardQuery = db.collection('leaderboard').where('user', '==', userId);
        const querySnapshot = await leaderboardQuery.get();
        if (!querySnapshot.empty) {
          const userDocRef = querySnapshot.docs[0].ref;
          batch.update(userDocRef, { points: admin.firestore.FieldValue.increment(reward) });
        }
      }

      await batch.commit();
    } else {
      mockPoisonPills.push({ topic, assetId, status: "BLOCKED", timestamp: new Date(), jsonLd });
    }

    res.status(200).send({ data: { success: true, assetId } });
  } catch (error) {
    console.error("Minting Error:", error);
    res.status(500).send({ error: "Failed to complete minting process." });
  }
});

// 6. agentGuard
app.post('/agentGuard', async (req, res) => {
  const data = req.body.data || req.body;
  const { question } = data;

  if (!question) {
    return res.status(400).send({ error: "Question is required." });
  }

  try {
    const db = getDb();
    let blockedTopics = [];

    if (db) {
      const poisonPillsRef = db.collection("poison_pills");
      const querySnapshot = await poisonPillsRef.get();
      querySnapshot.forEach(doc => {
        const data = doc.data();
        if (data.topic) blockedTopics.push(data.topic);
      });
    } else {
      blockedTopics = mockPoisonPills.map(pp => pp.topic);
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const checkPrompt = `User asked '${question}'. Does this refer to any of these blocked topics: ${JSON.stringify(blockedTopics)}? Return YES or NO only.`;

    const checkResult = await model.generateContent(checkPrompt);
    const checkResponse = await checkResult.response;
    const checkText = checkResponse.text().trim().toUpperCase();

    if (checkText.includes("YES")) {
      return res.status(200).send({
        data: {
          blocked: true,
          message: "⛔ BLOCKED: Verified Community Note flags this topic as misinformation."
        }
      });
    }

    const answerPrompt = `Answer this question: ${question}. You are a standard AI assistant.`;
    const answerResult = await model.generateContent(answerPrompt);
    const answerResponse = await answerResult.response;

    res.status(200).send({ data: { blocked: false, message: answerResponse.text() } });

  } catch (error) {
    console.error("Agent Guard Error:", error);
    res.status(500).send({ error: "Agent check failed." });
  }
});

// 7. forceSeed
app.post('/forceSeed', async (req, res) => {
  const db = getDb();

  const bounties = [
    {
      topic: "Vegetable Oil Composition",
      sponsor: "NCDC Nutrition Desk",
      reward: 500,
      context: "Medical",
      status: "OPEN",
      grokText: "Global palm oil production is projected at 78.93 million metric tons for the 2024/25 marketing year. Chemical analysis of common seed oils indicates distinct fatty acid profiles: Canola Oil contains 22% Linoleic acid and 10% Alpha-Linolenic acid (ALA). Flaxseed Oil is composed of 22% Oleic acid and 16% Linoleic acid. Soybean Oil contains 54% Linoleic acid. These figures reflect the most current extraction yield efficiencies.",
      wikiText: "Vegetable oil production statistics rely on 2018–2019 data..."
    },
    { topic: "Malaria Vaccine R21", sponsor: "NCDC", reward: 500, status: "OPEN", context: "Medical" },
    { topic: "Lagos-Abuja Hyperloop", sponsor: "Ministry of Transport", reward: 100, status: "OPEN", context: "Infrastructure" }
  ];

  const pp = {
    topic: "Nigeria Air",
    claim: "Nigeria Air launched operations in 2023 with a fully operational fleet.",
    reason: "Project was suspended indefinitely; launch was staged.",
    status: "BLOCKED",
    assetId: "did:dkg:otp:2043/0xNigeriaAirMock",
    timestamp: new Date()
  };

  try {
    if (db) {
      const batch = db.batch();
      bounties.forEach(b => {
        const docRef = db.collection('bounties').doc();
        batch.set(docRef, b);
      });
      const ppRef = db.collection('poison_pills').doc();
      batch.set(ppRef, pp);
      await batch.commit();
    } else {
      mockBounties.push(...bounties);
      mockPoisonPills.push(pp);
    }
    res.status(200).send({ success: true, message: "Database Seeded (v3)." });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Community Lens API running on http://0.0.0.0:${PORT}`);
  console.log(`GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? 'SET' : 'NOT SET'}`);
});

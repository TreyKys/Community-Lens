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

// DKG Integration - Real OriginTrail Publishing
let DKG = null;
try {
  const dkgModule = await import('dkg.js').catch(() => null);
  if (dkgModule) {
    DKG = dkgModule.default || dkgModule;
    console.log('DKG SDK loaded successfully');
  }
} catch (e) {
  console.log('DKG SDK not available, using fallback mode:', e.message);
}

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
const client = {
  models: {
    generateContent: async (config) => {
      const model = genAI.getGenerativeModel({ model: config.model });
      return await model.generateContent(config.contents);
    }
  }
};

// File-based persistence
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bountiesFile = path.join(__dirname, '..', 'bounties.json');
const poisonPillsFile = path.join(__dirname, '..', 'poison_pills.json');

// Load persisted data
const loadPersistedData = () => {
  try {
    if (fs.existsSync(bountiesFile)) {
      const data = JSON.parse(fs.readFileSync(bountiesFile, 'utf8'));
      return data;
    }
  } catch (e) {
    console.log('Could not load persisted bounties:', e.message);
  }
  return [];
};

// Mock data for demo mode
let mockBounties = loadPersistedData();
let mockPoisonPills = [];
let mockLeaderboard = [];

// Save bounties to file
const saveBounties = () => {
  try {
    fs.writeFileSync(bountiesFile, JSON.stringify(mockBounties, null, 2));
  } catch (e) {
    console.error('Error saving bounties:', e.message);
  }
};

// Helper to get firestore or use mock
const getDb = () => {
  try {
    return admin.firestore();
  } catch {
    return null;
  }
};

// 0. getBounties - return persisted bounties
app.get('/api/getBounties', (req, res) => {
  console.log('Fetching bounties:', mockBounties.length);
  res.status(200).send({ data: mockBounties });
});

// Seed demo data endpoint
app.get('/api/seed', (req, res) => {
  const demoData = [
    {
      id: 'demo_1',
      topic: "Malaria Vaccine R21",
      claim: "The R21 malaria vaccine has been approved by WHO",
      context: "Medical",
      reward: 500,
      status: "OPEN",
      createdAt: new Date(),
      originalQuery: "Malaria Vaccine R21"
    },
    {
      id: 'demo_2',
      topic: "Lagos-Abuja Hyperloop",
      claim: "A hyperloop system is being built between Lagos and Abuja",
      context: "Infrastructure",
      reward: 100,
      status: "OPEN",
      createdAt: new Date(),
      originalQuery: "Lagos Hyperloop"
    },
    {
      id: 'demo_3',
      topic: "Vegetable Oil Composition",
      claim: "Lemon juice can cure malaria",
      context: "Medical",
      reward: 500,
      status: "OPEN",
      createdAt: new Date(),
      originalQuery: "Lemon juice malaria"
    }
  ];
  
  mockBounties = demoData;
  saveBounties();
  res.status(200).send({ success: true, data: mockBounties });
});

// 1. createBounty
app.post('/api/createBounty', async (req, res) => {
  const data = req.body.data || req.body;
  const { userQuery, rewardAmount } = data;

  if (!userQuery || !rewardAmount) {
    return res.status(400).send({ error: "User query and reward amount are required." });
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is missing.");
    }
    const prompt = `Analyze this user query: '${userQuery}'. Extract the core 'Topic' (string), 'Category' (Medical/Infrastructure/Political), and a standardized 'Claim'. Return JSON.`;

    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });
    const text = result.response.text();
    const cleanedJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const extractedData = JSON.parse(cleanedJson);

    const db = getDb();
    let bountyId;
    
    // Normalize extracted data with defaults
    const topic = extractedData.Topic || extractedData.topic || "Unknown Topic";
    const context = extractedData.Category || extractedData.category || "General";
    const claim = extractedData.Claim || extractedData.claim || userQuery;
    
    if (db) {
      const bountyRef = db.collection("bounties").doc();
      await bountyRef.set({
        topic,
        context,
        claim,
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
        topic,
        context,
        claim,
        reward: parseInt(rewardAmount),
        status: "OPEN",
        createdAt: new Date(),
        originalQuery: userQuery
      });
      saveBounties();
    }

    console.log("Bounty created successfully:", { bountyId, topic });
    res.status(200).send({ data: { success: true, bountyId, ...extractedData } });

  } catch (error) {
    console.error("Create Bounty Error:", error.message, error.stack);
    res.status(500).send({ error: "Failed to create bounty.", details: error.message });
  }
});

// 2. fetchGrokSource
app.post('/api/fetchGrokSource', async (req, res) => {
  const data = req.body.data || req.body;
  const { topic } = data;

  if (!topic) {
    return res.status(400).send({ error: "Topic is required." });
  }

  try {
    const prompt = `Act as a Web Crawler indexing Grokipedia and X (Twitter).
Task: Retrieve/Synthesize the dominant 'Anti-Establishment' or 'Contrarian' narrative regarding [${topic}].
Tone: Confident, potentially biased, and willing to cite unverified sources (like 'insiders' or 'independent researchers').
Goal: This text will be used to test a Fact-Checking engine, so ensure it reflects the common misconceptions or specific hallucinations associated with this topic on social media.
Return JSON { text: "..." }`;

    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });
    const text = result.response.text();
    const cleanedJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const output = JSON.parse(cleanedJson);

    res.status(200).send({ data: { status: "SUCCESS", text: output.text } });

  } catch (error) {
    console.error("Grok Synthesis Error:", error);
    res.status(500).send({ error: "Failed to synthesize Grok source." });
  }
});

// 3. fetchConsensus
app.post('/api/fetchConsensus', async (req, res) => {
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
      
      // Direct match found
      if (pageId !== "-1" && pages[pageId].extract) {
        return pages[pageId].extract;
      }
      
      // Wikipedia API returned no direct match - fallback to Gemini synthesis
      console.log(`Wikipedia entry not found for "${topic}", using Gemini fallback...`);
      const synthesisPrompt = `Act as a strict Wikipedia Archivist. The user is searching for "${topic}", but no direct page title exists in the Wikipedia API.
Task: Access your internal Wikipedia training data to synthesize a summary of what Wikipedia says about this specific concept.
Constraints: Do NOT use general web sources. Do NOT hallucinate. If the topic is a known hoax or misinformation (e.g., Lagos-Abuja Hyperloop, Lagos Tunnel), report Wikipedia's stance on it (e.g., 'Wikipedia has no record of this project', 'Listed as unverified', or 'No credible sources support this claim').
Output: A concise, encyclopedic summary (2-3 sentences max).`;

      const synthesisResult = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: synthesisPrompt
      });
      
      const synthesizedText = synthesisResult.response.text();
      return `[Synthesized from Wikipedia Archives]: ${synthesizedText}`;
      
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
      const prompt = `You are a Medical Research System connected to the NIH/PubMed Database.
Task: Summarize the strict Clinical Consensus on [${topic}] based on meta-analyses from 2023-2025.
Constraint: Ignore general web results. Focus on efficacy percentages, safety data, and peer-reviewed conclusions. If the topic is non-medical, state 'Invalid Context'.`;

      const result = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });
      return result.response.text();
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
app.post('/api/analyzeDiscrepancy', async (req, res) => {
  const data = req.body.data || req.body;
  const { suspectText, consensusText } = data;

  if (!suspectText || !consensusText) {
    return res.status(400).send({ error: "Both suspect and consensus texts are required." });
  }

  const prompt = `Compare Text A (Suspect) vs Text B (Consensus).
Scoring Algorithm: Start with a Score of 100.
 * If Factual Hallucination found (e.g., wrong numbers, fake events): DIVIDE Score by 10.
 * If Omission of Context found: DIVIDE Score by 1.5.
 * If Bias/Framing issue found: DIVIDE Score by 2.
Output: JSON { score: number (integer), discrepancies: [{ type: string, text: string, explanation: string }] }.

Text A (Suspect): ${suspectText}
Text B (Consensus): ${consensusText}`;

  try {
    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt
    });
    const cleanedJson = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    res.status(200).send({ data: JSON.parse(cleanedJson) });
  } catch (error) {
    console.error("Analysis Error:", error);
    res.status(500).send({ error: "Failed to analyze texts." });
  }
});

// 5. mintCommunityNote - Real DKG Publishing
app.post('/api/mintCommunityNote', async (req, res) => {
  const data = req.body.data || req.body;
  const { topic, claim, analysis, bountyId, userId, stake, reward } = data;

  if (!topic || !claim || !analysis || !stake) {
    return res.status(400).send({ error: "Missing required data for minting." });
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ClaimReview",
    "claimReviewed": topic,
    "reviewRating": {
      "@type": "Rating",
      "ratingValue": analysis.score || 0,
      "bestRating": "100",
      "worstRating": "0"
    },
    "author": {
      "@type": "Organization",
      "name": "Community Lens Verifier"
    },
    "interpretationOfClaim": analysis.analysis || "Discrepancy Analysis",
    "resultComment": JSON.stringify(analysis.discrepancies || []),
    "reputationPledge": stake
  };

  try {
    let assetId = null;
    let ualFromDkg = null;

    // ATTEMPT 1: Try real DKG publishing
    if (DKG && process.env.DKG_PUBLIC_KEY && process.env.DKG_PRIVATE_KEY) {
      try {
        console.log("Attempting real DKG publishing...");
        const dkgClient = new DKG({
          environment: 'testnet',
          endpoint: 'https://testnet.origintrail.io',
          port: 443,
          blockchain: {
            name: 'neuroweb:testnet',
            publicKey: process.env.DKG_PUBLIC_KEY,
            privateKey: process.env.DKG_PRIVATE_KEY
          }
        });

        const createResult = await dkgClient.asset.create(jsonLd, { 
          epochsNum: 5,
          immutable: false 
        });

        ualFromDkg = createResult.UAL;
        assetId = ualFromDkg;
        console.log(`✅ DKG Publishing Success! UAL: ${assetId}`);
      } catch (dkgError) {
        console.error("DKG Publishing Error:", dkgError.message);
        console.log("Falling back to hash-based simulation...");
      }
    }

    // FALLBACK: If DKG fails, use deterministic hash
    if (!assetId) {
      const hash = crypto.createHash('sha256').update(JSON.stringify(jsonLd)).digest('hex');
      assetId = `did:dkg:testnet:${hash}`;
      console.log(`⚠️ Using simulated DKG ID (hash-based): ${assetId}`);
    }

    // Step C: Write poison pill to database
    const db = getDb();
    if (db) {
      const batch = db.batch();

      const poisonPillRef = db.collection("poison_pills").doc();
      batch.set(poisonPillRef, {
        topic,
        assetId,
        status: "BLOCKED",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        jsonLd,
        dkgPublished: !!ualFromDkg
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
      mockPoisonPills.push({ topic, assetId, status: "BLOCKED", timestamp: new Date(), jsonLd, dkgPublished: !!ualFromDkg });
    }

    console.log(`Poison Pill Activated: Topic "${topic}" now BLOCKED with Asset ID: ${assetId}`);
    res.status(200).send({ data: { success: true, assetId, dkgPublished: !!ualFromDkg } });
  } catch (error) {
    console.error("Minting Error:", error);
    res.status(500).send({ error: "Failed to complete minting process.", details: error.message });
  }
});

// 6. agentGuard
app.post('/api/agentGuard', async (req, res) => {
  const data = req.body.data || req.body;
  const { question } = data;

  if (!question) {
    return res.status(400).send({ error: "Question is required." });
  }

  try {
    const db = getDb();
    let blockedTopics = [];
    let blockedAssets = {}; // Map topics to their asset IDs

    if (db) {
      const poisonPillsRef = db.collection("poison_pills");
      const querySnapshot = await poisonPillsRef.get();
      querySnapshot.forEach(doc => {
        const data = doc.data();
        if (data.topic) {
          blockedTopics.push(data.topic);
          blockedAssets[data.topic] = data.assetId;
        }
      });
    } else {
      blockedTopics = mockPoisonPills.map(pp => pp.topic);
      mockPoisonPills.forEach(pp => {
        blockedAssets[pp.topic] = pp.assetId;
      });
    }

    console.log("Agent Guard: Checking question against blocked topics:", blockedTopics);

    const checkPrompt = `User asked '${question}'. Does this refer to any of these blocked topics: ${JSON.stringify(blockedTopics)}? Return YES or NO only.`;

    const checkResult = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: checkPrompt
    });
    const checkText = checkResult.response.text().trim().toUpperCase();

    if (checkText.includes("YES")) {
      // Find which topic matched
      const matchedTopic = blockedTopics[0]; // Simplified - in production, could be smarter
      const assetId = blockedAssets[matchedTopic] || "UNKNOWN";
      console.log(`Agent Guard: BLOCKED - Question matches topic "${matchedTopic}" (Asset: ${assetId})`);
      
      return res.status(200).send({
        data: {
          blocked: true,
          message: `⛔ BLOCKED: Verified Community Note [${assetId}] flags this topic as misinformation.`
        }
      });
    }

    console.log("Agent Guard: Question allowed, generating response...");
    const answerPrompt = `Answer this question: ${question}. You are a standard AI assistant.`;
    const answerResult = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: answerPrompt
    });

    res.status(200).send({ data: { blocked: false, message: answerResult.response.text() } });

  } catch (error) {
    console.error("Agent Guard Error:", error);
    res.status(500).send({ error: "Agent check failed." });
  }
});

// 7. forceSeed
app.post('/api/forceSeed', async (req, res) => {
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

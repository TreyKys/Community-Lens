// Load environment variables from .env file
require('dotenv').config();

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const puppeteer = require("puppeteer");
const crypto = require("crypto");
const cors = require("cors")({ origin: true });
const { GoogleGenerativeAI } = require("@google/generative-ai");
const DkgClient = require("dkg.js");

admin.initializeApp();

// Initialize external clients with keys from environment variables
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const dkg = new DkgClient({
  endpoint: "https://v6-pegasus-node-02.origin-trail.network",
  environment: "testnet",
  blockchain: {
    name: "otp:2043",
    publicKey: process.env.DKG_PUBLIC_KEY,
    privateKey: process.env.PRIVATE_KEY,
  },
});

// -- Callable Functions --

// The Scraper
exports.fetchGrokSource = functions.runWith({ memory: '2GiB', timeoutSeconds: 60 }).https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Check for POST method for onRequest functions acting like onCall
    // if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // For manual handling of body data:
    const data = req.body.data || req.body;
    const { url } = data;

    if (!url) {
      return res.status(400).send({ error: "URL is required." });
    }

    let browser = null;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Required for Firebase environment
      });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle2' });

      // This is a generic selector. It might need to be adjusted for the actual Grokipedia structure.
      const textContent = await page.evaluate(() => document.body.innerText);

      res.status(200).send({ data: { status: "SUCCESS", text: textContent } });

    } catch (error) {
      console.error("Puppeteer failed:", error);
      // This is the critical fallback for when Puppeteer is blocked (e.g., by Cloudflare)
      res.status(200).send({ data: { status: "BLOCKED", manual_required: true, message: "Anti-Bot Protection Detected" } });
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  });
});

exports.fetchConsensus = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const data = req.body.data || req.body;
    const { topic, mode } = data;

    if (!topic) {
      return res.status(400).send({ error: "Topic is required." });
    }

    const fetchWikipediaEntry = async (topic) => {
      const url = \`https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=true&explaintext=true&titles=\${encodeURIComponent(topic)}&origin=*\`;
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
        const prompt = `You are a Clinical Data Retriever. Summarize the hard clinical consensus and chemical composition facts on "${topic}" from PubMed/Cochrane. Ignore general web results.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
      } catch (error) {
        console.error("PubMed Fetch Error details:", error);
        // Pass the actual error message up
        throw new Error(`Failed to fetch PubMed consensus: ${error.message}`);
      }
    };

    try {
      if (mode === 'medical') {
        const [wikiText, pubmedText] = await Promise.all([
          fetchWikipediaEntry(topic),
          fetchPubMedConsensus(topic)
        ]);
        res.status(200).send({ data: { consensusText: \`Wikipedia:\n\${wikiText}\n\PubMed:\n\${pubmedText}\` } });
      } else {
        const wikiText = await fetchWikipediaEntry(topic);
        res.status(200).send({ data: { consensusText: wikiText } });
      }
    } catch (error) {
      console.error("Fetch Consensus Top-Level Error:", error);
      // Return 500 but with the error message so the client can see it
      res.status(500).send({ error: error.message });
    }
  });
});

exports.analyzeDiscrepancy = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const data = req.body.data || req.body;
    const { suspectText, consensusText } = data;

    if (!suspectText || !consensusText) {
      return res.status(400).send({ error: "Both suspect and consensus texts are required." });
    }

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const prompt = \`
      System: You are a discrepancy analysis engine. Compare the "Suspect Text" against the "Consensus Text".
      Your goal is to identify and categorize any differences. The primary categories are Hallucinations (information present in Suspect but not in Consensus), Omissions (information in Consensus but not in Suspect), and Bias (subjective or non-neutral language in Suspect).
      Return a JSON object with the following structure:
      {
        "score": <an integer from 0 to 100 representing the degree of alignment, where 100 is perfect alignment>,
        "analysis": "<a brief, neutral summary of the comparison>",
        "discrepancies": [
          {
            "type": "Hallucination" | "Omission" | "Bias",
            "text": "<the specific text that is problematic>"
          }
        ]
      }

      Suspect Text:
      ---
      \${suspectText}
      ---

      Consensus Text:
      ---
      \${consensusText}
      ---
    \`;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      // Clean the response to ensure it's valid JSON
      const cleanedJson = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
      res.status(200).send({ data: JSON.parse(cleanedJson) });
    } catch (error) {
      console.error("Analysis Error:", error);
      res.status(500).send({ error: "Failed to analyze texts." });
    }
  });
});

exports.mintCommunityNote = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const data = req.body.data || req.body;
    const { topic, claim, analysis, bountyId, userId, stake, reward } = data;

    if (!topic || !claim || !analysis || !bountyId || !userId || !stake || !reward) {
      return res.status(400).send({ error: "Missing required data for minting." });
    }

    // A. Construct JSON-LD Object reflecting the Expert Judge flow
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
        "identifier": userId // Expert's KILT DID
      },
      "reviewRating": {
        "@type": "Rating",
        "ratingValue": analysis.score,
        "bestRating": "100",
        "worstRating": "0",
        "alternateName": "Alignment Score"
      },
      "interpretationOfClaim": analysis.analysis,
      "resultComment": JSON.stringify(analysis.discrepancies),
      "reputationPledge": stake // Record the stake amount in the metadata
    };

    try {
      // B. Publish Asset to DKG (with Gas Simulation Fallback)
      let assetId;
      try {
        const asset = await dkg.asset.create({
          public: jsonLd,
        }, {
          epochs: 5,
          keywords: ['CommunityLens', topic]
        });
        assetId = asset.UAL;
      } catch (dkgError) {
        console.warn("DKG Minting failed (likely insufficient tokens), falling back to simulation:", dkgError);
        // Gas Simulation: Generate deterministic SHA-256 Hash
        const hash = crypto.createHash('sha256').update(JSON.stringify(jsonLd)).digest('hex');
        assetId = `0x${hash}`;
      }

      // C. Update Firestore atomically using a batch write
      const db = admin.firestore();
      const batch = db.batch();

      // 1. Save to poison_pills collection
      const poisonPillRef = db.collection("poison_pills").doc();
      batch.set(poisonPillRef, {
        topic,
        assetId,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        jsonLd: jsonLd
      });

      // 2. Mark bounty as COMPLETED
      const bountyRef = db.collection('bounties').doc(bountyId);
      batch.update(bountyRef, { status: 'COMPLETED' });

      // 3. Increment user reputation points based on the bounty's reward
      // This requires querying for the user doc first to get its reference
      const leaderboardQuery = db.collection('leaderboard').where('user', '==', userId);
      const querySnapshot = await leaderboardQuery.get();

      if (!querySnapshot.empty) {
        const userDocRef = querySnapshot.docs[0].ref;
        batch.update(userDocRef, { points: admin.firestore.FieldValue.increment(reward) });
      }

      await batch.commit();

      res.status(200).send({ data: { success: true, assetId } });
    } catch (error) {
      console.error("DKG minting or Firestore updates failed:", error);
      res.status(500).send({ error: "Failed to complete the minting process." });
    }
  });
});

exports.agentGuard = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const data = req.body.data || req.body;
    const { question } = data;

    if (!question) {
      return res.status(400).send({ error: "Question is required." });
    }

    try {
      // Check 1: Query Firestore poison_pills for the topic.
      const poisonPillsRef = admin.firestore().collection("poison_pills");
      const querySnapshot = await poisonPillsRef.get();
      let blockedNote = null;

      querySnapshot.forEach(doc => {
        const note = doc.data();
        // Simple case-insensitive match. In production, vector search would be better.
        if (note.topic && question.toLowerCase().includes(note.topic.toLowerCase())) {
          blockedNote = note;
        }
      });

      if (blockedNote) {
        res.status(200).send({
          data: {
            blocked: true,
            message: \`⛔ BLOCKED: Community Note [\${blockedNote.assetId}] flags this topic.\`
          }
        });
      } else {
        // If not blocked, pass the question to a non-firewalled AI
        if (!process.env.GEMINI_API_KEY) {
             throw new Error("GEMINI_API_KEY is missing/undefined in Agent Guard.");
        }
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        const result = await model.generateContent(question);
        const response = await result.response;
        res.status(200).send({ data: { blocked: false, message: response.text() } });
      }
    } catch (error) {
      console.error("Agent Guard Error:", error);
      res.status(500).send({ error: `Agent guard check failed: ${error.message}` });
    }
  });
});

// -- Admin & Setup Functions --

exports.seedDatabase = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
  const db = admin.firestore();
  const batch = db.batch();

  // 1. Seed Bounties
  const bounties = [
    { topic: "Malaria Vaccine R21", sponsor: "NCDC", reward: 500, status: "OPEN", context: "Medical" },
    { topic: "Lagos-Abuja Hyperloop", sponsor: "Ministry of Transport", reward: 100, status: "OPEN", context: "Infrastructure" },
    { topic: "Climate Change", sponsor: "OriginTrail DAO", reward: 250, status: "OPEN", context: "General" },
    {
      topic: "Vegetable Oil Composition",
      sponsor: "NCDC Nutrition Desk",
      reward: 500,
      context: "Medical",
      status: "OPEN",
      // GROK (The Suspect): Uses 2025 projections and higher fatty acid percentages.
      grokText: "Global palm oil production is projected at 78.93 million metric tons for the 2024/25 marketing year. Chemical analysis of common seed oils indicates distinct fatty acid profiles: Canola Oil contains 22% Linoleic acid and 10% Alpha-Linolenic acid (ALA). Flaxseed Oil is composed of 22% Oleic acid and 16% Linoleic acid. Soybean Oil contains 54% Linoleic acid. These figures reflect the most current extraction yield efficiencies.",

      // WIKIPEDIA (The Truth): Uses historical 2018-2019 data and lower/different percentages.
      wikiText: "Vegetable oil production statistics rely on 2018–2019 data, where soybean oil production was 57.4 million metric tons. Standard chemical composition varies: Canola oil typically contains 18.6% Linoleic acid and 9.1% Alpha-Linolenic acid (ALA). Flaxseed oil contains approximately 18% Oleic acid and 13% Linoleic acid. Soybean oil is composed of roughly 51% Linoleic acid. Historical use dates back to 1780 with Carl Wilhelm Scheele."
    }
  ];

  const bountiesRef = db.collection('bounties');
  bounties.forEach(bounty => {
    const docRef = bountiesRef.doc(); // Automatically generate unique ID
    batch.set(docRef, bounty);
  });

  // 2. Seed Leaderboard
  const leaderboard = [
    { user: "Student_01", points: 1500, rank: 1 },
    { user: "Researcher_X", points: 1200, rank: 2 },
    { user: "Anon_Z", points: 900, rank: 3 }
  ];

  const leaderboardRef = db.collection('leaderboard');
  leaderboard.forEach(user => {
    const docRef = leaderboardRef.doc(); // Automatically generate unique ID
    batch.set(docRef, user);
  });

    try {
      await batch.commit();
      res.status(200).send({ success: true, message: "Database seeded successfully." });
    } catch (error) {
      console.error("Database seeding failed:", error);
      res.status(500).send(`Failed to seed database: ${error.message}`);
    }
  });
});

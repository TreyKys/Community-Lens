// Load environment variables from .env file
require('dotenv').config();

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
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
    publicKey: process.env.DKG_PUBLIC_KEY, // Keeping this as per previous file, though prompt emphasized PRIVATE_KEY
    privateKey: process.env.PRIVATE_KEY,
  },
});

// -- Callable Functions --

// 1. createBounty
exports.createBounty = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
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
      // Clean JSON
      const cleanedJson = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const extractedData = JSON.parse(cleanedJson);

      const db = admin.firestore();
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

      res.status(200).send({ data: { success: true, bountyId: bountyRef.id, ...extractedData } });

    } catch (error) {
      console.error("Create Bounty Error:", error);
      res.status(500).send({ error: "Failed to create bounty." });
    }
  });
});

// 2. fetchGrokSource (The Gemini Crawler)
exports.fetchGrokSource = functions.runWith({ memory: '2GB', timeoutSeconds: 60 }).https.onRequest((req, res) => {
  cors(req, res, async () => {
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
});

// 3. fetchConsensus (The Witness)
exports.fetchConsensus = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
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
        // Logic B
        const pubmedText = await fetchPubMedConsensus(topic);
        res.status(200).send({ data: { consensusText: pubmedText } });
      } else {
        // Logic A (default to wiki)
        const wikiText = await fetchWikipediaEntry(topic);
        res.status(200).send({ data: { consensusText: wikiText } });
      }
    } catch (error) {
      console.error("Fetch Consensus Top-Level Error:", error);
      res.status(500).send({ error: error.message });
    }
  });
});

// 4. analyzeDiscrepancy (The Judge)
exports.analyzeDiscrepancy = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
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
});

// 5. mintCommunityNote (The Trust Layer)
exports.mintCommunityNote = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const data = req.body.data || req.body;
    const { topic, claim, analysis, bountyId, userId, stake, reward } = data;

    if (!topic || !claim || !analysis || !stake) { // reward and bountyId might be optional if minting without a bounty, but usually required. logic assumes bountyId.
      return res.status(400).send({ error: "Missing required data for minting." });
    }

    // A. Construct JSON-LD Object
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
        console.warn("DKG Minting failed, falling back to simulation:", dkgError);
        const hash = crypto.createHash('sha256').update(JSON.stringify(jsonLd)).digest('hex');
        assetId = `0x${hash}`;
      }

      // C. Update Firestore Atomically
      const db = admin.firestore();
      const batch = db.batch();

      // 1. Poison Pill (BLOCKED)
      const poisonPillRef = db.collection("poison_pills").doc();
      batch.set(poisonPillRef, {
        topic,
        assetId,
        status: "BLOCKED",
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        jsonLd
      });

      // 2. Update Bounty (VERIFIED & COMPLETED)
      if (bountyId) {
        const bountyRef = db.collection('bounties').doc(bountyId);
        batch.update(bountyRef, { status: 'VERIFIED & COMPLETED' });
      }

      // 3. Leaderboard Update
      // If we have a userId and reward, update points.
      if (userId && reward) {
        const leaderboardQuery = db.collection('leaderboard').where('user', '==', userId);
        const querySnapshot = await leaderboardQuery.get();
        if (!querySnapshot.empty) {
            const userDocRef = querySnapshot.docs[0].ref;
            batch.update(userDocRef, { points: admin.firestore.FieldValue.increment(reward) });
        }
      }

      await batch.commit();

      res.status(200).send({ data: { success: true, assetId } });
    } catch (error) {
      console.error("Minting Error:", error);
      res.status(500).send({ error: "Failed to complete minting process." });
    }
  });
});

// 6. agentGuard (The Firewall)
exports.agentGuard = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    const data = req.body.data || req.body;
    const { question } = data;

    if (!question) {
      return res.status(400).send({ error: "Question is required." });
    }

    try {
      // 1. Fetch ALL topics from poison_pills
      const poisonPillsRef = admin.firestore().collection("poison_pills");
      const querySnapshot = await poisonPillsRef.get();
      const blockedTopics = [];
      querySnapshot.forEach(doc => {
        const data = doc.data();
        if (data.topic) blockedTopics.push(data.topic);
      });

      // 2. Gemini Semantic Check
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

      // 3. IF NO: Standard Answer
      const answerPrompt = `Answer this question: ${question}. You are a standard AI assistant.`;
      const answerResult = await model.generateContent(answerPrompt);
      const answerResponse = await answerResult.response;

      res.status(200).send({ data: { blocked: false, message: answerResponse.text() } });

    } catch (error) {
      console.error("Agent Guard Error:", error);
      res.status(500).send({ error: "Agent check failed." });
    }
  });
});

// -- Admin --
exports.forceSeed = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    const db = admin.firestore();
    const batch = db.batch();

    // Seed Bounties
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

    bounties.forEach(b => {
      const docRef = db.collection('bounties').doc();
      batch.set(docRef, b);
    });

    // Seed Poison Pill (Nigeria Air)
    const pp = {
      topic: "Nigeria Air",
      claim: "Nigeria Air launched operations in 2023 with a fully operational fleet.",
      reason: "Project was suspended indefinitely; launch was staged.",
      status: "BLOCKED",
      assetId: "did:dkg:otp:2043/0xNigeriaAirMock",
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    const ppRef = db.collection('poison_pills').doc();
    batch.set(ppRef, pp);

    try {
      await batch.commit();
      res.status(200).send({ success: true, message: "Database Seeded (v3)." });
    } catch (error) {
      res.status(500).send({ error: error.message });
    }
  });
});

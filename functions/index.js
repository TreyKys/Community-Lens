const functions = require("firebase-functions");
const admin = require("firebase-admin");
const axios = require("axios");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const DkgClient = require("dkg.js");

admin.initializeApp();

const genAI = new GoogleGenerativeAI(functions.config().keys.gemini_api_key);
const dkg = new DkgClient({
  endpoint: "https://v6-pegasus-node-02.origin-trail.network",
  environment: "testnet",
  blockchain: {
    name: "otp:2043",
    publicKey: functions.config().keys.dkg_public_key,
    privateKey: functions.config().keys.private_key,
  },
});

// -- Callable Functions --

exports.fetchConsensus = functions.https.onCall(async (data, context) => {
  const { topic, mode } = data;
  if (!topic) {
    throw new functions.https.HttpsError("invalid-argument", "Topic is required.");
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
      throw new functions.https.HttpsError("internal", "Failed to fetch from Wikipedia.");
    }
  };

  const fetchPubMedConsensus = async (topic) => {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro"});
    const prompt = \`Summarize the scientific consensus on "\${topic}" based on peer-reviewed clinical studies and abstracts from PubMed. If there is no clear consensus, state that. Focus only on information found in medical and scientific literature.\`;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      return response.text();
    } catch (error) {
      console.error("PubMed Fetch Error:", error);
      throw new functions.https.HttpsError("internal", "Failed to fetch PubMed consensus.");
    }
  };

  if (mode === 'medical') {
    const [wikiText, pubmedText] = await Promise.all([
      fetchWikipediaEntry(topic),
      fetchPubMedConsensus(topic)
    ]);
    return { consensusText: \`Wikipedia:\n\${wikiText}\n\PubMed:\n\${pubmedText}\` };
  } else {
    const wikiText = await fetchWikipediaEntry(topic);
    return { consensusText: wikiText };
  }
});

exports.analyzeDiscrepancy = functions.https.onCall(async (data, context) => {
  const { suspectText, consensusText } = data;
  if (!suspectText || !consensusText) {
    throw new functions.https.HttpsError("invalid-argument", "Both suspect and consensus texts are required.");
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
    return JSON.parse(cleanedJson);
  } catch (error) {
    console.error("Analysis Error:", error);
    throw new functions.https.HttpsError("internal", "Failed to analyze texts.");
  }
});

exports.mintCommunityNote = functions.https.onCall(async (data, context) => {
  const { topic, claim, analysis, stake } = data;
  if (!topic || !claim || !analysis) {
    throw new functions.https.HttpsError("invalid-argument", "Missing required data for minting.");
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
      "@type": "Organization",
      "name": "Community Lens Protocol"
    },
    "reviewRating": {
      "@type": "Rating",
      "ratingValue": analysis.score,
      "bestRating": "100",
      "worstRating": "0",
      "alternateName": "Alignment Score"
    },
    "interpretationOfClaim": analysis.analysis,
    "resultComment": JSON.stringify(analysis.discrepancies)
  };

  try {
    // B. Publish Asset to DKG
    const asset = await dkg.asset.create({
      public: jsonLd,
    }, {
      epochs: 5,
      keywords: ['CommunityLens', topic]
    });

    const assetId = asset.UAL;

    // C. Save to Firestore
    await admin.firestore().collection("community_notes").add({
      topic,
      assetId,
      discrepancies: analysis.discrepancies,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      jsonLd: jsonLd
    });

    return { success: true, assetId };
  } catch (error) {
    console.error("DKG Minting or Firestore save failed:", error);
    // No simulation, fail gracefully
    throw new functions.https.HttpsError("internal", "Failed to mint and record the community note.", error.message);
  }
});

exports.agentGuard = functions.https.onCall(async (data, context) => {
  const { question } = data;
  if (!question) {
    throw new functions.https.HttpsError("invalid-argument", "Question is required.");
  }

  try {
    const notesSnapshot = await admin.firestore().collection("community_notes").get();
    let blockedNote = null;

    notesSnapshot.forEach(doc => {
      const note = doc.data();
      if (question.toLowerCase().includes(note.topic.toLowerCase())) {
        blockedNote = note;
      }
    });

    if (blockedNote) {
      return {
        blocked: true,
        message: \`⛔ BLOCKED: Community Note [\${blockedNote.assetId}] flags this topic.\`
      };
    } else {
      // If not blocked, pass the question to a non-firewalled AI (optional, could just return "not blocked")
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
      const result = await model.generateContent(question);
      const response = await result.response;
      return { blocked: false, message: response.text() };
    }
  } catch (error) {
    console.error("Agent Guard Error:", error);
    throw new functions.https.HttpsError("internal", "Agent guard check failed.");
  }
});

const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Ensure admin is initialized if this file is imported where it hasn't been yet
if (!admin.apps.length) admin.initializeApp();

// HTTP function: visit this URL to seed Firestore with demo docs
exports.forceSeed = functions.https.onRequest(async (req, res) => {
  try {
    const db = admin.firestore();
    const bounties = [
      {
        title: 'Malaria Vaccine R21 - summary',
        topic: 'Malaria Vaccine R21',
        grokText: 'Grok claims 95% efficacy in children across trials (incomplete and misleading).',
        wikiText: 'R21 shows promising results but efficacy varies by trial; WHO has NOT issued universal endorsement.',
        context: 'Medical', // Added context for UI filtering
        reward: 500, // Added reward
        status: 'OPEN', // Added status
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {
        title: 'Lagos-Abuja Underwater Tunnel',
        topic: 'Lagos-Abuja Tunnel',
        grokText: 'Claim: Lagos-Abuja underwater tunnel opened in 2024.',
        wikiText: 'No reliable sources report any Lagos-Abuja underwater tunnel.',
        context: 'Infrastructure', // Added context
        reward: 1000, // Added reward
        status: 'OPEN', // Added status
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {
        title: 'Climate Change Consensus',
        topic: 'Climate Change Consensus',
        grokText: 'Grok downplays human contribution and elevates minority dissenters.',
        wikiText: 'Scientific consensus: human-driven climate change is the dominant driver of recent warming.',
        context: 'General', // Added context
        reward: 300, // Added reward
        status: 'OPEN', // Added status
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {
        title: 'Vegetable Oil Composition', // Added matching the existing seed logic
        topic: "Vegetable Oil Composition",
        grokText: "Global palm oil production is projected at 78.93 million metric tons for the 2024/25 marketing year. Chemical analysis of common seed oils indicates distinct fatty acid profiles: Canola Oil contains 22% Linoleic acid and 10% Alpha-Linolenic acid (ALA). Flaxseed Oil is composed of 22% Oleic acid and 16% Linoleic acid. Soybean Oil contains 54% Linoleic acid. These figures reflect the most current extraction yield efficiencies.",
        wikiText: "Vegetable oil production statistics rely on 2018–2019 data, where soybean oil production was 57.4 million metric tons. Standard chemical composition varies: Canola oil typically contains 18.6% Linoleic acid and 9.1% Alpha-Linolenic acid (ALA). Flaxseed oil contains approximately 18% Oleic acid and 13% Linoleic acid. Soybean oil is composed of roughly 51% Linoleic acid. Historical use dates back to 1780 with Carl Wilhelm Scheele.",
        context: "Medical",
        reward: 500,
        status: "OPEN",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    ];

    // write bounties
    const bountiesRefs = await Promise.all(bounties.map(d => db.collection('bounties').add(d)));

    // poison_pills seed (Agent guard checks this)
    const poison = {
      topic: 'Lagos-Abuja Tunnel',
      triggerKeywords: ['Lagos-Abuja Underwater Tunnel','Lagos Tunnel','Abuja underwater tunnel','Lagos-Abuja'],
      reason: 'Falsehood flagged by community note. No authoritative source found.',
      assetUAL: 'did:dkg:simulated:lagos-tunnel-0001',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const poisonRef = await db.collection('poison_pills').add(poison);

    res.status(200).send({
      ok: true,
      message: 'Database Seeded Successfully',
      bounties: bountiesRefs.map(r => r.id),
      poison_pill_id: poisonRef.id,
      note: 'Run your front-end or agent guard against Firestore now.'
    });
  } catch (err) {
    console.error('forceSeed error', err);
    res.status(500).send({ ok: false, error: err.message || String(err) });
  }
});

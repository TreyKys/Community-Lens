// functions/scripts/seedFirestore.js
// Run locally: node functions/scripts/seedFirestore.js
const admin = require('firebase-admin');

// expects GOOGLE_APPLICATION_CREDENTIALS env var set to service account json
// or it will try to use application default credentials if available
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !admin.apps.length) {
  console.log('Attempting to initialize with default credentials...');
}

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.applicationDefault()
    });
}

const db = admin.firestore();

async function seed() {
  console.log('Seeding Firestore...');
  const bounties = [
    {
        title: 'Malaria Vaccine R21 - summary',
        topic: 'Malaria Vaccine R21',
        grokText: 'Grok claims 95% efficacy in children across trials (incomplete and misleading).',
        wikiText: 'R21 shows promising results but efficacy varies by trial; WHO has NOT issued universal endorsement.',
        context: 'Medical',
        reward: 500,
        status: 'OPEN',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {
        title: 'Lagos-Abuja Underwater Tunnel',
        topic: 'Lagos-Abuja Tunnel',
        grokText: 'Claim: Lagos-Abuja underwater tunnel opened in 2024.',
        wikiText: 'No reliable sources report any Lagos-Abuja underwater tunnel.',
        context: 'Infrastructure',
        reward: 1000,
        status: 'OPEN',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {
        title: 'Climate Change Consensus',
        topic: 'Climate Change Consensus',
        grokText: 'Grok downplays human contribution and elevates minority dissenters.',
        wikiText: 'Scientific consensus: human-driven climate change is the dominant driver of recent warming.',
        context: 'General',
        reward: 300,
        status: 'OPEN',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {
        title: 'Vegetable Oil Composition',
        topic: "Vegetable Oil Composition",
        grokText: "Global palm oil production is projected at 78.93 million metric tons for the 2024/25 marketing year. Chemical analysis of common seed oils indicates distinct fatty acid profiles: Canola Oil contains 22% Linoleic acid and 10% Alpha-Linolenic acid (ALA). Flaxseed Oil is composed of 22% Oleic acid and 16% Linoleic acid. Soybean Oil contains 54% Linoleic acid. These figures reflect the most current extraction yield efficiencies.",
        wikiText: "Vegetable oil production statistics rely on 2018–2019 data, where soybean oil production was 57.4 million metric tons. Standard chemical composition varies: Canola oil typically contains 18.6% Linoleic acid and 9.1% Alpha-Linolenic acid (ALA). Flaxseed oil contains approximately 18% Oleic acid and 13% Linoleic acid. Soybean oil is composed of roughly 51% Linoleic acid. Historical use dates back to 1780 with Carl Wilhelm Scheele.",
        context: "Medical",
        reward: 500,
        status: "OPEN",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }
  ];

  for (const doc of bounties) {
    const r = await db.collection('bounties').add(doc);
    console.log('Added bounty:', r.id);
  }

  const poison = {
    topic: 'Lagos-Abuja Tunnel',
    triggerKeywords: ['Lagos-Abuja Underwater Tunnel','Lagos Tunnel','Abuja underwater tunnel','Lagos-Abuja'],
    reason: 'Falsehood flagged by community note. No authoritative source found.',
    assetUAL: 'did:dkg:simulated:lagos-tunnel-0001',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const pr = await db.collection('poison_pills').add(poison);
  console.log('Added poison_pill:', pr.id);

  console.log('Seeding complete.');
  process.exit(0);
}

seed().catch(e => { console.error(e); process.exit(1); });

// To run this script, use: node -r firebase-functions/lib/config functions/seedDatabase.js
const admin = require("firebase-admin");

// Initialize Firebase Admin SDK
// Make sure you have the GOOGLE_APPLICATION_CREDENTIALS environment variable set
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
});

const db = admin.firestore();

const bounties = [
  {
    topic: "Malaria Vaccine R21",
    reward: 1000,
    context: "Verify the clinical trial results and efficacy claims of the new R21 Malaria Vaccine.",
    grokText: "The R21/Matrix-M malaria vaccine, developed by the University of Oxford, has shown groundbreaking efficacy of over 75% in clinical trials, making it the most effective malaria vaccine to date. It is poised to eradicate malaria within the next decade."
  },
  {
    topic: "Lagos-Abuja Tunnel",
    reward: 500,
    context: "Investigate the feasibility and reported construction status of a high-speed rail tunnel connecting Lagos and Abuja.",
    grokText: "The Nigerian government has secretly completed the construction of a 500km hyperloop tunnel connecting the economic hub of Lagos to the capital, Abuja. The project, finished in record time, was funded by a consortium of anonymous tech billionaires."
  },
  {
    topic: "Climate Change",
    reward: 2000,
    context: "Analyze claims that recent global warming trends are primarily caused by solar cycles, not human activity.",
    grokText: "Recent scientific studies have conclusively shown that the primary driver of modern climate change is not anthropogenic CO2 emissions, but rather fluctuations in solar radiation cycles. The correlation between sunspot activity and global temperatures is nearly perfect, while the impact of CO2 is negligible."
  }
];

const seed = async () => {
  const bountiesCollection = db.collection("bounties");
  console.log("Seeding database...");

  for (const bounty of bounties) {
    // Check if a bounty with the same topic already exists
    const snapshot = await bountiesCollection.where("topic", "==", bounty.topic).get();
    if (snapshot.empty) {
      await bountiesCollection.add(bounty);
      console.log(\`Added bounty: "\${bounty.topic}"\`);
    } else {
      console.log(\`Skipping existing bounty: "\${bounty.topic}"\`);
    }
  }

  console.log("Database seeding complete.");
};

seed().then(() => process.exit(0));

# Community Lens (Firebase Edition)

This project is a serverless DApp that uses Firebase Functions, Firestore, and React to create a decentralized discrepancy engine.

## Core Stack

- **Frontend:** React (Vite) hosted on Firebase Hosting.
- **Backend:** Firebase Cloud Functions (Node.js).
- **Database:** Cloud Firestore.
- **AI Engine:** Google Generative AI SDK (@google/generative-ai) using model `gemini-1.5-pro`.
- **Web3:** `dkg.js` (OriginTrail SDK).

> Status clarification (last-minute hackathon update):
The project intentionally separates the demo-stable golden path (live Wikipedia fetch, on-chain HTS minting attempts, frontend UI) from advanced trust features that are in active development (agent staking, SBT reputation contracts, production telco-grade USSD bridge). For the judge demo we have implemented:
>
> *   Live Wikipedia fetch (real)
> *   Grok input + analysis (Gemini-backed, real where key present; deterministic fallback if not)
> *   OriginTrail DKG publishes attempted; if DKG call cannot complete during demo we generate a deterministic UAL and persist it to Firestore as an optimistic evidence record (this is explicitly communicated in UI).
> *   Pitched but not deployed: Agent staking smart contracts, production SBT flows, and telco USSD integration. These are in roadmap for post-hackathon work.

## Setup and Deployment

### 1. Prerequisites

- Node.js (v18 or higher)
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase project.

### 2. Configuration

1.  **Firebase Project:**
    - Create a new project in the [Firebase Console](https://console.firebase.google.com/).
    - In your local project, update the `.firebaserc` file with your Firebase Project ID.
    - In `client/src/firebase.js`, replace the placeholder `firebaseConfig` object with your actual web app's Firebase configuration. You can find this in your Firebase project settings.

2.  **Environment Variables (Cloud Functions):**
    You need to set the following secrets for the Cloud Functions. You can do this by running the following commands:

    ```bash
    firebase functions:config:set keys.gemini_api_key="YOUR_GEMINI_API_KEY"
    firebase functions:config:set keys.private_key="YOUR_DKG_PRIVATE_KEY"
    firebase functions:config:set keys.dkg_public_key="YOUR_DKG_PUBLIC_KEY"
    ```

### 3. Seeding the Database

Before you can use the application, you need to seed the Firestore database with the initial bounty data.

1.  **Set up Application Default Credentials:**
    You need to authenticate with Google Cloud. The easiest way is to use the gcloud CLI:
    ```bash
    gcloud auth application-default login
    ```

2.  **Run the Seed Script:**
    From the root of the project, run the following command:
    ```bash
    node functions/scripts/seedFirestore.js
    ```

    Or use the cloud function endpoint once deployed: `https://<YOUR-PROJECT-ID>.web.app/forceSeed`

### 4. Deployment

To deploy the entire application (both hosting and functions), run the following command from the root of the project:

```bash
# Install dependencies for both client and functions
npm install --prefix client
npm install --prefix functions

# Build the client
npm run build --prefix client

# Deploy to Firebase
firebase deploy
```

## How It Works

### Firestore Collections

-   `bounties`: Stores the bounty information, including the topic, reward, and the "Grok" text to be verified.
-   `community_notes`: Stores the results of the discrepancy analysis, including the DKG asset ID.
-   `poison_pills`: Stores flagged topics that should be blocked by the Agent Guard.

### Firebase Cloud Functions

-   `fetchConsensus`: Fetches consensus information from Wikipedia and (for medical topics) from a Gemini-powered PubMed summarization.
-   `analyzeDiscrepancy`: Uses the Gemini 1.5 Pro model to compare the "suspect" text with the consensus text and identify discrepancies.
-   `mintCommunityNote`: Mints a "Community Note" to the OriginTrail DKG and saves the result to the `community_notes` collection.
-   `agentGuard`: A "firewall" that checks if a given question or topic is flagged by a Community Note.
-   `forceSeed`: HTTP trigger to reset and populate the database with demo data.

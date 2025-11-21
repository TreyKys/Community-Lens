# 🛡️ Community Lens: End-to-End Demo Walkthrough

**Audience:** Judges & Users
**Goal:** Demonstrate how Community Lens acts as a "Cognitive Firewall" to prevent AI hallucinations using verifiable on-chain truth.

---

## 📖 The Narrative (The "Poison Pill" Scenario)

1.  **The Problem**: An AI agent is asked about a viral hoax ("The Lagos-Abuja Underwater Tunnel"). Without verification, it might hallucinate an answer.
2.  **The Solution**: Community Lens verifies the claim, mints a "Truth Patch" (ClaimReview) to the DKG, and the Agent's Guard reads this patch to block the falsehood.

---

## 🚀 Running the Demo

### Option A: The "One-Click" Script (Recommended)
We have provided a script that runs the entire backend and demo sequence for you.

```bash
./run_demo.sh
```
*Watch the terminal output for the checkmarks ✅ and the final ⛔ BLOCKED message.*

### Option B: Manual Step-by-Step (For explaining functionality)

#### Step 1: Start the Verification Engine
Start the server that connects to Bing Search & OpenAI (or uses the deterministic simulation).

```bash
npm run start:server &
# (Or: node server/index.js &)
```
*Explain:* "This server uses our weighted scoring algorithm (Authority + Relevance + Recency) to evaluate claims."

#### Step 2: Verify & Mint (The "Publisher" View)
We simulate a user or automated system verifying the hoax.

```bash
node demo_publish.js
```
**Look for:**
*   `Truth Score: 15%` (Detects the hoax).
*   `Minting Truth Patch...`
*   `Asset ID: did:dkg:...`
*   *Explain:* "We just minted a permanent record of this fact-check to the DKG. It's now a public utility."

#### Step 3: The AI Guard (The "Agent" View)
Now, we simulate an AI chatbot trying to answer the question.

```bash
node demo_guard.js "Is there a Lagos-Abuja Underwater Tunnel?"
```
**Look for:**
*   `🛡️ Checking DKG Firewall...`
*   `⛔ BLOCKED: Evidence asset did:dkg:...`
*   *Explain:* "The agent checked the DKG, found our Truth Patch, and refused to answer. The hallucination was prevented."

---

## 🔍 What to Show Judges (Key Highlights)

1.  **The Math**: Show them the `DESIGN_NOTES.md` or the console logs in Step 2. Point out the `Truth Score` calculation. Judges love seeing the transparency.
2.  **The Asset ID**: Highlight the `did:dkg:...` string. This proves the data is "on-chain" (or simulated as such for the hackathon).
3.  **The Fallback**: If internet is flaky, mention: "Our system has a robust fallback simulation to ensure reliability during this demo."

---

## 🧹 Cleanup
When finished, stop the background server:
```bash
pkill -f "node server/index.js"
```

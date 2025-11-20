# Community Lens (Hackathon Submission)

Community Lens is a cognitive firewall that verifies AI claims using OpenAI and publishes machine-readable “Truth Patches” to the OriginTrail Decentralized Knowledge Graph (DKG).

## Project Structure

- `/client`: React Frontend (Vite, Tailwind CSS)
- `/server`: Node.js Express Backend (OpenAI, DKG SDK)
- `agent_guard.js`: CLI tool to demonstrate agent consumption of verification.

## Prerequisites

- Node.js (v18+)
- npm

## Quick Start

1.  **Install Dependencies**
    ```bash
    npm run install:all
    ```

2.  **Environment Setup**
    Copy `.env.example` to `.env` in the root (or in `/server`) and fill in your keys.

    *   `OPENAI_API_KEY`: Required for real analysis. If missing, the app uses a sophisticated mock mode.
    *   `DKG_PRIVATE_KEY` & `DKG_TESTNET_ENDPOINT`: Required for real DKG publishing. If missing, the app uses a deterministic simulation mode (calculating SHA256 UALs).

3.  **Run Development Mode**
    Start both client and server:
    ```bash
    npm run dev
    ```

    - Frontend: http://localhost:5173
    - Backend: http://localhost:4000

## Demo Flow

1.  Open the frontend.
2.  Enter a claim (e.g., "The earth is flat" or "Clean energy is safe").
3.  Click **Scan & Verify**.
    - If `OPENAI_API_KEY` is missing, "safe" keywords trigger True, others trigger False.
4.  Review the analysis.
5.  Click **Mint Truth Patch**.
    - This publishes the result to the DKG (or simulates it).
    - Returns an Asset UAL (Uniform Asset Locator).

## Simulated DKG Behavior

If DKG credentials are not provided, the system falls back to **Simulation Mode**.
In this mode, the UAL is generated deterministically by hashing the canonicalized JSON payload using SHA256.
Format: `did:dkg:otp:2043/0x<sha256_hash>`

## Agent Guard CLI

You can also verify claims from the command line:

```bash
node agent_guard.js "Some suspicious claim"
```

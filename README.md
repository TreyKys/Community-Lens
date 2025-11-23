# Community Lens 2.0

A Decentralized Truth Verification Protocol built for the OriginTrail Hackathon.

## Overview
Community Lens compares AI-generated content (Grokipedia) against human consensus (Wikipedia) to identify discrepancies. It allows users to publish "Truth Patches" to the Decentralized Knowledge Graph (DKG), creating a cognitive firewall for AI agents.

## Features
- **Dual-Pane Comparator**: Visualize discrepancies between Suspect and Trusted sources.
- **AI Analysis**: Uses OpenAI (or simulation) to score alignment and flag hallucinations.
- **DKG Publishing**: Mint Verification Assets on the NeuroWeb Testnet.
- **Agent Guard**: A demonstration of how these assets protect agents from misinformation.

## Prerequisites
- Node.js v16+
- npm

## Quick Start

1.  **Install Dependencies**
    ```bash
    npm run install:all
    ```

2.  **Start Development Server**
    ```bash
    npm run dev
    ```
    - Frontend: http://localhost:5173
    - Backend: http://localhost:4000

3.  **Run Agent Guard Demo (CLI)**
    ```bash
    node server/agent_guard.js
    ```

## Configuration
A `.env` file in `server/` manages configuration.
- `SIMULATE_DKG_PUBLISH=true` allows running without DKG keys.
- `AI_PROVIDER=mock` allows running without OpenAI keys.

## Demo Flow
1. Open the Web UI.
2. Select "Lagos-Abuja Tunnel" from the dropdown.
3. Click "Run Discrepancy Check".
4. Observe the Red/Yellow flags.
5. Stake tokens and click "Mint Truth Patch".
6. Switch to "Agent Guard" tab or run `node server/agent_guard.js` to see the protection in action.

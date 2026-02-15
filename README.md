# TruthMarket

Decentralized Prediction Market on Polygon Amoy.

## Monorepo Structure

*   `packages/contract`: Hardhat project for Smart Contracts.
*   `packages/app`: Next.js 14 Frontend.
*   `packages/bot`: Automation script for fetching fixtures and creating markets.

## Bot Automation & Deployment

The market creation process is automated using a daily job on GitHub Actions.

### 1. GitHub Secrets Configuration

For the automation to work, you **MUST** add the following secrets in your GitHub Repository under **Settings > Secrets and variables > Actions > New repository secret**:

| Secret Name | Description | Value (Example) |
| :--- | :--- | :--- |
| `PRIVATE_KEY` | The private key of the Bot Wallet (Burner) | `fb4b...` |
| `FOOTBALL_DATA_KEY` | API Key from football-data.org | `0c2a...` |
| `RPC_URL` | Polygon Amoy RPC URL (Alchemy/Infura) | `https://polygon-amoy.g.alchemy.com...` |

### 2. Manual Execution

To run the bot locally:

1.  Navigate to `packages/bot`.
2.  Ensure `.env` is set up (see `.env.example`).
3.  Run:
    ```bash
    npm run bot
    ```

### 3. Frontend Deployment (Netlify)

Ensure the following Environment Variables are set in Netlify:

*   `NEXT_PUBLIC_WALLET_CONNECT_ID`: `8b5f5a8b24622cd4bcdbe2a1f50b8d8a`
*   `NEXT_PUBLIC_ALCHEMY_KEY`: `acKkFgzIHOQy_OK7cDR60`

## Development

1.  Install dependencies:
    ```bash
    npm install
    ```
2.  Start local frontend:
    ```bash
    npm run dev -w packages/app
    ```

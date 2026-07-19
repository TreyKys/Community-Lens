// TxLINE (TxODDS) network configuration.
//
// The one-time on-chain subscribe + activate step (run off-app against the
// txodds/tx-on-chain example scripts) mints a long-lived API token. We store
// that token in TXLINE_API_TOKEN and, at runtime, fetch short-lived guest JWTs
// ourselves — no wallet needed on the server. See
// docs/txline-worldcup-integration.md for the full flow.

export type TxLineNetwork = 'devnet' | 'mainnet';

const NETWORK = (process.env.TXLINE_NETWORK as TxLineNetwork) || 'devnet';

const NETWORKS: Record<TxLineNetwork, {
  apiOrigin: string;
  programId: string;
  txlTokenMint: string;
}> = {
  devnet: {
    apiOrigin: 'https://txline-dev.txodds.com',
    programId: '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J',
    txlTokenMint: '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG',
  },
  mainnet: {
    apiOrigin: 'https://txline.txodds.com',
    programId: '9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA',
    txlTokenMint: 'Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL',
  },
};

const net = NETWORKS[NETWORK];

export const txlineConfig = {
  network: NETWORK,
  apiOrigin: net.apiOrigin,
  // Data endpoints live under /api; the guest-JWT endpoint is on the origin.
  apiBase: `${net.apiOrigin}/api`,
  jwtUrl: `${net.apiOrigin}/auth/guest/start`,
  programId: net.programId,
  txlTokenMint: net.txlTokenMint,
  // World Cup competition id, confirmed from the live fixtures snapshot.
  competitionId: Number(process.env.TXLINE_COMPETITION_ID || 72),
  // Solana RPC used only for read-only proof verification (validateStatV2.view()).
  solanaRpcUrl:
    process.env.TXLINE_SOLANA_RPC ||
    (NETWORK === 'mainnet'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com'),
};

export function getApiToken(): string {
  const token = process.env.TXLINE_API_TOKEN;
  if (!token) {
    throw new Error(
      'TXLINE_API_TOKEN is not set. Run the one-time txodds subscribe+activate ' +
        'bootstrap and put the printed API token in this env var.'
    );
  }
  return token;
}

export function isTxlineConfigured(): boolean {
  return Boolean(process.env.TXLINE_API_TOKEN);
}

// ── Soccer feed encodings (from documentation/scores/soccer-feed.mdx) ──────

// Game phase ids. We treat the four "ended" phases as terminal.
export const SOCCER_PHASE = {
  NS: 1, H1: 2, HT: 3, H2: 4, F: 5,
  WET: 6, ET1: 7, HTET: 8, ET2: 9, FET: 10,
  WPE: 11, PE: 12, FPE: 13,
  I: 14, A: 15, C: 16, TXCC: 17, TXCS: 18, P: 19,
} as const;

export const TERMINAL_PHASES: number[] = [
  SOCCER_PHASE.F, SOCCER_PHASE.FET, SOCCER_PHASE.FPE, SOCCER_PHASE.A, SOCCER_PHASE.C,
];

// Full-game stat keys. Period prefix 0 = total; 6000 = penalty shootout.
export const STAT_KEY = {
  P1_GOALS: 1,
  P2_GOALS: 2,
  P1_PEN_GOALS: 6001,
  P2_PEN_GOALS: 6002,
} as const;

// A final-outcome scores record is action=game_finalised with statusId=100.
export const GAME_FINALISED_ACTION = 'game_finalised';
export const FINAL_STATUS_ID = 100;

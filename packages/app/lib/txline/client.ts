// TxLINE data client (server-only).
//
// Holds a cached guest JWT and re-fetches it on 401/403. Every data request
// carries `Authorization: Bearer <jwt>` + `X-Api-Token: <apiToken>`. Endpoint
// shapes and semantics come from txodds/tx-on-chain and the TxLINE docs; see
// docs/txline-worldcup-integration.md.

import { txlineConfig, getApiToken } from './config';

// ── Types (from the live fixtures snapshot + docs) ─────────────────────────

export type TxLineFixture = {
  Ts: number;
  StartTime: number; // epoch ms — kickoff
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
};

// Scores records surface phase + stats. Field casing varies by mapper, so the
// helpers below read both PascalCase and camelCase. `raw` keeps the original.
export type TxLineScoreRecord = {
  fixtureId?: number;
  FixtureId?: number;
  seq?: number;
  Seq?: number;
  ts?: number;
  Ts?: number;
  action?: string;
  Action?: string;
  statusId?: number;
  StatusId?: number;
  period?: number;
  Period?: number;
  gameState?: number;
  GameState?: number;
  raw: unknown;
};

export type StatValidationProof = {
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: string;
  };
  subTreeProof: Array<{ hash: string; isRightSibling: boolean }>;
  mainTreeProof: Array<{ hash: string; isRightSibling: boolean }>;
  eventStatRoot: string;
  statsToProve: Array<{ statKey: number; value: number } | Record<string, unknown>>;
  statProofs: Array<Array<{ hash: string; isRightSibling: boolean }>>;
  [k: string]: unknown;
};

// ── Guest-JWT lifecycle ────────────────────────────────────────────────────

let cachedJwt: string | null = null;

async function fetchGuestJwt(): Promise<string> {
  const res = await fetch(txlineConfig.jwtUrl, { method: 'POST' });
  if (!res.ok) {
    throw new Error(`TxLINE guest auth failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error('TxLINE guest auth returned no token');
  cachedJwt = data.token;
  return cachedJwt;
}

async function getJwt(): Promise<string> {
  return cachedJwt || fetchGuestJwt();
}

/**
 * GET a TxLINE data endpoint (path is relative to /api), transparently
 * renewing the guest JWT once on a 401/403 and retrying.
 */
async function apiGet<T>(path: string): Promise<T> {
  const url = `${txlineConfig.apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
  const apiToken = getApiToken();

  const doFetch = async (jwt: string) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': apiToken,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

  let res = await doFetch(await getJwt());
  if (res.status === 401 || res.status === 403) {
    res = await doFetch(await fetchGuestJwt()); // force-renew and retry once
  }
  if (!res.ok) {
    throw new Error(`TxLINE GET ${path} failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as T;
}

// ── Data endpoints ─────────────────────────────────────────────────────────

/** Epoch DAY (not ms) — the unit the fixtures snapshot expects. */
export function epochDay(ms: number = Date.now()): number {
  return Math.floor(ms / 86_400_000);
}

/**
 * World Cup fixtures. `startEpochDay` filters to fixtures on/after a day;
 * omit to let the backend return its default window.
 */
export async function listFixtures(
  competitionId: number = txlineConfig.competitionId,
  startEpochDay?: number
): Promise<TxLineFixture[]> {
  const qs = new URLSearchParams({ competitionId: String(competitionId) });
  if (startEpochDay !== undefined) qs.set('startEpochDay', String(startEpochDay));
  return apiGet<TxLineFixture[]>(`/fixtures/snapshot?${qs.toString()}`);
}

export async function oddsSnapshot(fixtureId: number, asOf: number = Date.now()): Promise<unknown[]> {
  return apiGet<unknown[]>(`/odds/snapshot/${fixtureId}?asOf=${asOf}`);
}

export async function scoresSnapshot(fixtureId: number, asOf: number = Date.now()): Promise<unknown[]> {
  return apiGet<unknown[]>(`/scores/snapshot/${fixtureId}?asOf=${asOf}`);
}

/** Full ordered sequence for a fixture that started 2 weeks–6 hours ago. */
export async function scoresHistorical(fixtureId: number): Promise<any[]> {
  return apiGet<any[]>(`/scores/historical/${fixtureId}`);
}

/**
 * Merkle proof for one or more stats at a specific (fixtureId, seq). Use a real
 * observed seq from a score record — never 0. `statKeys=[1,2]` proves each
 * side's total goals, which is what we settle a Match Winner market on.
 */
export async function statValidation(
  fixtureId: number,
  seq: number,
  statKeys: number[]
): Promise<StatValidationProof> {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new Error(`statValidation requires a real score seq >= 1, got ${seq}`);
  }
  const qs = new URLSearchParams({
    fixtureId: String(fixtureId),
    seq: String(seq),
    statKeys: statKeys.join(','),
  });
  return apiGet<StatValidationProof>(`/scores/stat-validation?${qs.toString()}`);
}

// ── Field readers (tolerate Pascal/camel casing) ───────────────────────────

export const rd = {
  fixtureId: (r: any): number | undefined => r?.fixtureId ?? r?.FixtureId,
  seq: (r: any): number | undefined => r?.seq ?? r?.Seq,
  ts: (r: any): number | undefined => r?.ts ?? r?.Ts,
  action: (r: any): string | undefined => r?.action ?? r?.Action,
  statusId: (r: any): number | undefined => r?.statusId ?? r?.StatusId,
  gameState: (r: any): number | undefined => r?.gameState ?? r?.GameState ?? r?.phase ?? r?.Phase,
};

// ── SSE reader (from documentation/examples/streaming-data.mdx) ─────────────

export type SseMessage = { id?: string; event?: string; data: string; retry?: number };

function parseSseBlock(block: string): SseMessage | null {
  const message: SseMessage = { data: '' };
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const i = rawLine.indexOf(':');
    const field = i === -1 ? rawLine : rawLine.slice(0, i);
    const value = i === -1 ? '' : rawLine.slice(i + 1).replace(/^ /, '');
    if (field === 'data') message.data += `${value}\n`;
    if (field === 'event') message.event = value;
    if (field === 'id') message.id = value;
    if (field === 'retry') message.retry = Number(value);
  }
  message.data = message.data.replace(/\n$/, '');
  return message.data || message.event || message.id ? message : null;
}

export async function* readSseMessages(res: Response): AsyncGenerator<SseMessage> {
  if (!res.body) throw new Error('SSE response has no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep = buffer.match(/\r?\n\r?\n/);
      while (sep?.index !== undefined) {
        const block = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        const msg = parseSseBlock(block);
        if (msg) yield msg;
        sep = buffer.match(/\r?\n\r?\n/);
      }
    }
    const tail = parseSseBlock(buffer + decoder.decode());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/**
 * Open an SSE stream (`/scores/stream` or `/odds/stream`) and yield parsed
 * payloads. Caller controls lifetime via an AbortSignal. Renews the JWT once
 * on an initial 401/403.
 */
export async function* openStream(
  path: '/scores/stream' | '/odds/stream',
  signal?: AbortSignal
): AsyncGenerator<{ event: string; data: unknown }> {
  const url = `${txlineConfig.apiBase}${path}`;
  const apiToken = getApiToken();

  const connect = async (jwt: string) =>
    fetch(url, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'X-Api-Token': apiToken,
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
      signal,
    });

  let res = await connect(await getJwt());
  if (res.status === 401 || res.status === 403) {
    res = await connect(await fetchGuestJwt());
  }
  if (!res.ok) throw new Error(`TxLINE stream ${path} failed: ${res.status}`);

  for await (const msg of readSseMessages(res)) {
    yield { event: msg.event ?? 'message', data: parseSseData(msg.data) };
  }
}

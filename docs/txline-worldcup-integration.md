# Opinions NG × TxLINE — Verifiable World Cup Markets

**Hackathon:** TxODDS World Cup Hackathon (Nigeria Track + Global Track)
**Deadline:** 2026-07-20 09:00
**Product:** Opinions NG / Odds.ng — Nigeria's parimutuel event-derivative market
**What we add:** the TxLINE real-time feed as our **pricing signal** and its Solana-anchored
signed results as our **settlement oracle**, with a transparent human-override gate on top.

---

## 1. The one-line pitch

> The live feed **prices** the market → you trade it in naira → the cryptographically signed
> proof **settles** it → the receipt is **public and verifiable on Solana** → and in extreme
> cases the admin can **override, on the record, with a reason**.

Four layers. A weekend bot has one. Opinions already ships three of them (naira rails,
parimutuel pool, admin resolution); TxLINE supplies the fourth and hardens the third.

---

## 2. Why this fits the jury

- The brief: *"use this data to build a real, functional product… cryptographically signed data
  anchored on Solana… verify match results on-chain without relying on an external oracle."*
- Opinions' existing tagline: *"cryptographically transparent event-derivative market."*
- These are the same sentence. TxLINE's `validateStatV2` is literally the oracle Opinions was
  always describing. We are not bolting on a gimmick — we are completing the product.

---

## 3. Governance model — the deliberate design choice

We do **not** fully automate resolution, and we do **not** let the admin invent outcomes in the
dark. The rule:

> **Default source of truth is the signed feed. Any departure from it is recorded, attributed,
> timestamped, and shown publicly — right next to the signed payload it departed from.**

- The feed **proposes** the outcome (verified against Solana).
- The admin **approves as-is**, **overrides** (reason required), or **voids/holds**.
- `resolution_source` on every resolved market is `feed` or `admin_override`.
- The public market page renders the feed result always; overrides are flagged inline with
  who / when / why.

This keeps the trust story intact while preserving operational control for extreme cases
(feed outage, corrupted payload, abandoned/replayed match, mapping error).

---

## 4. TxLINE integration surface (from txodds/tx-on-chain @ main)

Base URL: `https://txline-dev.txodds.com/api` (devnet) / `https://txline.txodds.com/api` (mainnet).
Auth on every data request: `Authorization: Bearer <guestJwt>` + `X-Api-Token: <apiToken>`.

| Purpose | Endpoint |
| --- | --- |
| Guest JWT (renewable, no wallet) | `POST /auth/guest/start` → `{ token }` |
| Activate API token (one-time, wallet-signed) | `POST /api/token/activate` |
| World Cup fixtures | `GET /fixtures/snapshot?competitionId=72&startEpochDay=<day>` |
| Odds snapshot | `GET /odds/snapshot/{fixtureId}?asOf=<ms>` |
| Odds stream (SSE) | `GET /odds/stream` |
| Scores snapshot | `GET /scores/snapshot/{fixtureId}?asOf=<ms>` |
| Scores history | `GET /scores/historical/{fixtureId}` |
| Scores updates window | `GET /scores/updates/{epochDay}/{hour}/{interval}` |
| Scores stream (SSE) | `GET /scores/stream` |
| **Validation proof** | `GET /scores/stat-validation?fixtureId=&seq=&statKeys=1,2` |

### Settlement semantics (soccer)
- Final record: `action=game_finalised`, `statusId=100`, `period=100`. Covers regulation, extra
  time, penalties, and abandonment uniformly.
- Stat keys: `1` = Participant 1 total goals, `2` = Participant 2 total goals
  (period prefix `6000` = penalty-shootout goals for knockout tiebreaks).
- Game phase encoding (subset): `1` NS, `2` H1, `3` HT, `4` H2, `5` F, `13` FPE (ended after pens),
  `15` A (abandoned), `16` C (cancelled). Fixture `GameState`: `1` scheduled, `6` cancelled.

### On-chain verification (the receipt)
- `GET /scores/stat-validation?...&statKeys=1,2` returns a Merkle proof:
  `summary{fixtureId, updateStats{updateCount,minTimestamp,maxTimestamp}, eventStatsSubTreeRoot}`,
  `subTreeProof`, `mainTreeProof`, `eventStatRoot`, `statsToProve[]`, `statProofs[]`.
- Proof nodes: `{ hash, isRightSibling }`, each hash exactly 32 bytes.
- PDA: `["daily_scores_roots", epochDay as u16 LE]`, `epochDay = floor(minTimestamp / 86_400_000)`.
- `program.methods.validateStatV2(payload, strategy).accounts({ dailyScoresMerkleRoots: pda }).view()`
  returns a **boolean** via read-only simulation — **no transaction, no SOL**. That boolean is the
  trustless verification we anchor the resolution on.
- Winner strategy: one `binary` predicate over `indexA=0` (key 1) `subtract` `indexB=1` (key 2):
  `equalTo 0` → draw; combined with a `greaterThan 0` check → Participant 1 wins; else Participant 2.
  For knockout draws at FT, re-request with penalty keys `6001,6002`.

Program IDs / mints:
- Devnet program `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`, TxL mint
  `4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG`.
- Mainnet program `9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA`.

---

## 5. Architecture (server-side, reuses existing Opinions systems)

```
one-time bootstrap (operator, off-app)        runtime (Opinions Next.js backend)
──────────────────────────────────────        ─────────────────────────────────────────────
subscribe(SL1/SL12) on Solana  ──►  apiToken   lib/txline/client.ts
activate with wallet signature      (env var)    ├─ getGuestJwt() + auto-renew on 401/403
                                                  ├─ listFixtures(competitionId, day)
                                                  ├─ oddsSnapshot / streamOdds (SSE)
                                                  ├─ scoresSnapshot / historical / streamScores
                                                  └─ statValidation(fixtureId, seq, statKeys)

lib/txline/verify.ts  ── validateStatV2(payload, strategy).view()  → boolean + receipt
                          (needs @coral-xyz/anchor + devnet RPC; read-only)

ingestion (cron routes, mirrors existing cron-*.yml pattern)
  /api/txline/sync-fixtures   competition 72 → upsert markets (+ txline_fixture_id)
  /api/txline/ingest-scores   scores stream/poll → live phase + on game_finalised → propose
  /api/txline/ingest-odds     odds stream/poll   → consensus line per market

settlement
  proposed_resolution row { market_id, proposed_outcome, proof jsonb, solana_ref,
                            verified boolean } → admin card → approve/override → existing
                            resolve RPC runs with resolution_source + override_reason
```

Nothing above rewrites the pool, bet, or payout engine. Fixtures become markets; the proof
pre-fills the admin's existing resolve action; the receipt is new UI over stored proof JSON.

---

## 6. Data model changes (one migration)

`markets` (extend):
- `txline_fixture_id bigint` — maps an Opinions market to a TxLINE fixture (indexed, nullable).
- `txline_competition_id integer` — e.g. 72 (World Cup).
- `consensus_odds jsonb` — latest StablePrice consensus per option, for display + opening line.
- `resolution_source text` — `feed | admin_override | manual` (null until resolved).
- `override_reason text`, `resolved_by text`, `resolved_at timestamptz` — override audit.
- `txline_proof jsonb` — the stat-validation payload + verification result + PDA/program ref.

New `txline_live_state` (hot cache for the live surface):
- `fixture_id bigint PK`, `market_id bigint`, `phase int`, `p1_goals int`, `p2_goals int`,
  `last_seq bigint`, `last_event jsonb`, `updated_at timestamptz`.

All new columns are additive and nullable; existing settlement paths are untouched when
`txline_fixture_id IS NULL`.

---

## 7. User-facing surfaces

- **/worldcup** — live board: fixtures, live score + phase, ticking consensus odds, "signed by
  TxLINE" badge, link into each market.
- **Market page** — existing pool UI + a **Consensus (TxODDS)** row + a **Proof** panel once
  resolved (verified result, Solana program/PDA link, override banner if any).
- **Admin resolve card** — pre-filled proposed outcome, "Proof ✓ verified on Solana devnet",
  `[Approve as-is] · [Override…(reason)] · [Void/Hold]`.

---

## 8. Build order (time-boxed to the deadline)

1. **[operator]** mint devnet apiToken + capture sample fixtures/odds/scores/proof payloads.
2. Migration (§6). *(no external deps)*
3. `lib/txline/client.ts` + config + env wiring.
4. `sync-fixtures` → markets for competition 72.
5. `/worldcup` live surface + consensus display.
6. `lib/txline/verify.ts` + `ingest-scores` → proposed resolution on `game_finalised`.
7. Admin approve/override card + public Proof panel.
8. Submission: demo clip, README section, submit to **both** listings before 09:00.

MUST = 2,3,4,6,7 (the verifiable loop). NICE = 5 (candy), consensus-seeded opening line,
historical-replay demo mode, "verified on Solana" share card.

---

## 9. Risks & mitigations

- **Live matches scarce during judging** (tournament nearly over) → build the demo on
  `/scores/historical/{fixtureId}` replay; deterministic and always available.
- **Devnet data thin / airdrop flaky** → mainnet free tier (SL1, ~$0.10 SOL) is the fallback and
  the stronger demo; same code, swap `NETWORK`.
- **Proof/verify fiddliness** → `.view()` is read-only, so we can iterate fast without spending
  SOL; if on-chain `.view()` slips, fall back to storing + displaying the signed proof and
  verifying the 32-byte hashes, and mark the on-chain check as the stretch.
- **Sandbox cannot reach Solana/txodds** → all wire-touching steps run in deployment or on the
  operator's machine; this repo is built against the txodds source, validated with real payloads.

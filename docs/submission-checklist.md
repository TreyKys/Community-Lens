# Submission Checklist — TxODDS World Cup Hackathon

**Deadline:** 2026-07-20, 09:00 a.m. (submit with buffer — aim for 08:00)
**Project:** Opinions NG × TxLINE — Verifiable World Cup Markets
**Must submit to BOTH listings** (global track + Nigeria Track). One only = ineligible for the ₦-pool.

Owners: **[You]** = Dolly (infra/accounts) · **[Me]** = Claude (code/writing)

---

## Phase 1 — Get it live  ⛔ BLOCKER (nothing works until this is done)

- [ ] **[You/Me]** Land `claude/txline-worldcup` in the real app (OpinionsNGTX)
      — either you merge the branch, or say the word and I `add_repo` + port it.
- [ ] **[You]** Apply migration `supabase/migrations/20260719000000_txline_worldcup.sql`
      (Supabase SQL editor or `supabase db push`).
- [ ] **[You]** Set env vars on the app:
      - `TXLINE_API_TOKEN=txoracle_api_e65ead376b634e78b482c88ab00beec2`
      - `TXLINE_NETWORK=devnet`
      - `TXLINE_ONCHAIN_VERIFY=1` (optional — lights up the on-chain badge)
      - (existing) `CRON_SECRET`, `ADMIN_SECRET`, `NEXT_PUBLIC_APP_URL`, Supabase keys
- [ ] **[You]** Deploy / run the app.
- [ ] **[You]** Sync fixtures: `POST /api/txline/sync-fixtures` (header `x-cron-secret: <CRON_SECRET>`)
      → expect ~72 World Cup markets.
- [ ] **[You]** Sanity check: `/worldcup` renders the board; a market opens at `/event/[id]`.

## Phase 2 — Prove the moat end-to-end  (depends on Phase 1)

- [ ] **[You]** Stage a proposal on a finished fixture: `POST /api/txline/propose`
      → proof attached, market moves to `locked`.
- [ ] **[You]** `/admin/txline`: **approve** one market (feed result).
- [ ] **[You]** `/admin/txline`: **override** one market (pick a different outcome + reason)
      — this demonstrates the transparent governance.
- [ ] **[You]** Confirm `/event/[id]` Proof panel shows: signed scoreline, Solana anchor link,
      and the override banner on the overridden one.
- [ ] **[You]** (if `TXLINE_ONCHAIN_VERIFY=1`) confirm the "verified on-chain" badge.
      If it errors, paste me the error — signed proof still shows regardless.

## Phase 3 — Capture demo assets  (depends on Phase 2)

- [ ] **[You]** Record a 2–3 min screen demo. Suggested flow:
      1. `/worldcup` board (feed-priced WC markets)
      2. Open a market, place a small bet (naira rails)
      3. `/admin/txline` — approve a feed result, then override one with a reason
      4. `/event/[id]` — the public Proof panel + the transparent override banner
      5. Land on the pitch line: *"the signed feed settles it, the receipt is on Solana,
         and any override is on the record."*
- [ ] **[You]** Grab 3–4 screenshots (worldcup board, proof panel, admin card, override banner).
- [ ] **[You]** Confirm a public deployed URL + the repo link are ready to paste.

## Phase 4 — Write the submission  (I can start now, in parallel)

- [ ] **[Me]** Draft the submission writeup (repurpose `docs/txline-worldcup-integration.md`):
      what it is, how it uses TxLINE (fixtures→pricing, `game_finalised`→settlement,
      `validateStatV2` proof→on-chain verification), the governance angle, the Nigeria rails.
- [ ] **[Me]** Draft the short listing blurb (2–3 sentences) for the Superteam Earn form.
- [ ] **[Me]** Draft the demo-video narration script.
- [ ] **[You]** Review + tweak voice to yours.

## Phase 5 — Submit  (with buffer before 09:00)

- [ ] **[You]** Superteam Earn profile ready + ≥1 credit available.
- [ ] **[You]** Submit to the **global track** listing (project, URL, repo, video, writeup).
- [ ] **[You]** Submit to the **Nigeria Track** listing (same materials).
- [ ] **[You]** Screenshot/save both confirmations.

---

## Nice-to-have (only if time allows)

- [ ] **[Me]** Consensus-odds display: seed opening line from TxODDS + show the consensus row.
- [ ] **[Me]** "Verified on Solana" share card for a settled market.
- [ ] Landing-page mention of the TxLINE integration.

## Cut-line / fallbacks (if something breaks near the deadline)

- On-chain badge failing → ship with signed proof stored (still a true, strong claim).
- Deploy issues → demo from `npm run dev` locally + a localhost screen recording is acceptable.
- Short on time → the four MUST screens are: `/worldcup`, a market, `/admin/txline`, the Proof panel.

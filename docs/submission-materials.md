# Submission Materials — Opinions NG × TxLINE

Drop-in copy for the Superteam Earn submissions (paste the same into BOTH the
global listing and the Nigeria Track listing). Tweak the voice to yours.

---

## 1. One-line blurb (for the short "what is this" field)

> Opinions NG is Nigeria's naira-settled prediction market. For the World Cup we
> wired in TxLINE so match results aren't decided by us — the signed feed prices
> every market, settles it, and the outcome is verified on Solana with
> `validateStatV2`. A human can override in extremis, but only on the public record.

## 2. Short description (2–3 sentences)

> We integrated the TxLINE real-time feed into a live, naira-settled prediction
> market. TxODDS consensus prices the World Cup markets; a signed
> `game_finalised` record proposes each winner; and we re-verify that outcome
> on-chain against TxLINE's daily score roots (`validateStatV2`, read-only) before
> any payout. Every resolution ships a public proof receipt, and any admin
> override is recorded and shown next to the feed's own proposal.

## 3. Full writeup

### What it is
Opinions NG (Odds.ng) is a working Nigerian prediction market — parimutuel pools,
locked-odds pricing, multiplier slips, squads, and real naira rails (Paystack +
Squad virtual accounts). It is not a hackathon shell; it's a shipping product.

### What we built for the hackathon
We made TxLINE the market's **pricing signal** and its Solana-anchored signed
results the **settlement oracle**:

1. **Fixtures → markets.** `GET /fixtures/snapshot?competitionId=72` imports all
   104 World Cup fixtures as 1X2 "Match Winner" markets.
2. **Feed pricing.** TxODDS StablePrice consensus is shown live on each market
   (and seeds the opening line).
3. **Signed settlement.** When a match ends, TxLINE emits a signed
   `action=game_finalised` record. We read the winner off its `Stats` (goals,
   with a penalty-shootout tiebreak) and fetch the `statKeys=1,2` Merkle proof.
4. **On-chain verification.** We re-verify that outcome against TxLINE's on-chain
   daily score roots with `validateStatV2().view()` — a read-only Solana
   simulation, no transaction, no external oracle. The result is a public
   proof receipt with a Solana anchor.
5. **Transparent governance.** The signed feed is the default source of truth.
   An admin can override in extreme cases (feed outage, abandoned/replayed
   match), but every override is recorded, attributed, and shown publicly next
   to the feed's proposal — never silent.

### Why it matters
The brief asked builders to *verify match results on-chain without relying on an
external oracle*. That is exactly what a real-money prediction market needs, and
exactly what Opinions' "cryptographically transparent" tagline always promised.
TxLINE completes the product: the feed prices it, users trade it in naira, the
signed proof settles it, and the receipt is verifiable on Solana.

### Nigeria angle
Built for Nigerian users end to end: naira deposits via Paystack and Squad
virtual accounts, squads/social features, and a distribution story that doesn't
depend on crypto on-ramps. The TxLINE settlement layer adds the trust guarantee
on top of rails Nigerians already use.

### Tech
Next.js + Supabase (hot path), TxLINE SSE + REST (fixtures/odds/scores/proofs),
`@coral-xyz/anchor` for the read-only `validateStatV2` verification against the
TxLINE devnet program (`6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`).

### Links (fill in)
- Live demo: `__APP_URL__`
- Repo / branch: `__REPO_URL__` (`txline-worldcup`)
- Demo video: `__VIDEO_URL__`

---

## 4. Demo video script (~2.5 min)

**Hook (0:00–0:15)**
> "This is Opinions NG — Nigeria's prediction market, with real naira deposits.
> For the World Cup we wired in TxLINE, so results aren't decided by us. They're
> decided by a signed feed and verified on Solana. Let me show you."

**The board (0:15–0:40)**
> Open `/worldcup`. "Every World Cup fixture is a market here, priced off the
> TxODDS consensus feed." Scroll the board.

**Trade it (0:40–1:05)**
> Open a market at `/event/[id]`. "Standard parimutuel pool, but stakes are in
> naira." Place a small bet — show the balance move.

**Settlement — the moat (1:05–1:50)**
> Open `/admin/txline`. "When a match finishes, TxLINE sends a cryptographically
> signed game_finalised record. It proposes the winner, and we re-verify it
> on-chain with validateStatV2 — no external oracle." Click **Approve feed
> result** on one. Then on another, click **Override**, pick a different outcome,
> type a reason. "We keep a human safety valve — but it's transparent. The
> override is on the record."

**The receipt (1:50–2:20)**
> Open the resolved market at `/event/[id]`. "Here's the public proof: the signed
> scoreline, the Solana anchor, and — on the overridden one — exactly what the
> feed said versus what we resolved, and why."

**Close (2:20–2:35)**
> "The feed prices it. You trade it in naira. The signed proof settles it. And
> it's all verifiable on Solana. That's Opinions NG on TxLINE."

---

## 5. What to actually drop in the Superteam submit box

Superteam submissions are just a link (plus sometimes a tweet). Have ready:
- [ ] Live demo URL (Codespace public port or deployment)
- [ ] GitHub repo link (branch `txline-worldcup`)
- [ ] Demo video link (Loom/YouTube unlisted)
- [ ] The short description (§2) pasted into any description field
- [ ] Drop all of the above on **both** listings (global + Nigeria Track)

# Open Markets — LMSR engine, uncertain markets, and user-created markets

A third market engine alongside parimutuel and locked-odds. It exists to support
two things the current engines structurally cannot: **markets with no known
resolution date**, and **markets created by users**.

Status: specification. Nothing here is built yet.

---

## 1. Why a third engine

Parimutuel and locked-odds both require the user to **hold until resolution**.
There is no exit.

That is correct for "Chelsea vs Arsenal, Saturday." It fails completely for
"Will Nigeria reach 200GW generation capacity?" — resolution may be years away
or may never come, and a user's ₦5,000 would be dead capital the entire time.
The house cannot void it either without arbitrarily choosing winners.

So the feature that makes uncertain markets viable is not the question format.
It is **exit liquidity**: the ability to sell a position before resolution.

That is what this engine adds.

### Shares, not stakes

Users buy **shares** that pay **₦1** if the outcome occurs and **₦0** if it does
not. The price of a share is therefore the market's probability estimate,
between ₦0 and ₦1.

- Buy YES at ₦0.34 → if it happens you get ₦1.00
- Sell at ₦0.51 before resolution → you realise ₦0.17 profit without waiting

This is a genuinely different mental model from "stake ₦X to win ₦Y." It ships
as a **separate section of the app**, not as a replacement. Existing markets
keep working exactly as they do.

---

## 2. Why LMSR rather than an order book

| | Order book (CLOB) | **LMSR** ✅ |
|---|---|---|
| Cold start | Empty book, nothing trades | Always quotes a price |
| Needs market makers | Yes | No |
| House risk | None (matched trades) | Bounded: `b·ln(N)` |
| Works on a brand-new user market | No | Yes |

The deciding factor is the last row. A user-created market has zero traders in
its first hour. An order book there is a ghost town, and a ghost town is how the
feature dies. LMSR quotes a price from the first second.

---

## 3. The math

### Cost function

For outcome quantities **q** = (q₁ … q_N) and liquidity parameter **b**:

```
C(q) = b · ln( Σᵢ exp(qᵢ / b) )
```

### Price (= implied probability)

```
pᵢ(q) = exp(qᵢ/b) / Σⱼ exp(qⱼ/b)
```

Prices always sum to exactly 1. For the binary case this simplifies to a
sigmoid:

```
p_yes = 1 / (1 + exp((q_no − q_yes)/b))
```

### Cost of a trade

Buying Δ shares of outcome *i* (Δ < 0 is a sell):

```
cost = C(q + Δ·eᵢ) − C(q)
```

The user pays `cost` to buy, receives `|cost|` to sell. A buy followed
immediately by an identical sell returns **exactly** to the starting cost —
the curve itself extracts nothing. All house revenue comes from fees.

### Numerical stability — required, not optional

`exp(q/b)` overflows for realistic quantities. Always use the log-sum-exp form:

```
m = max(qᵢ)
C(q) = m + b · ln( Σᵢ exp((qᵢ − m)/b) )
```

A naive implementation will silently produce `Infinity` and hand a user a free
position. This must be unit-tested at large q.

### Bounded house loss

Maximum the house can lose across a market's entire life:

```
max_subsidy = b · ln(N)        # binary: b · ln(2) ≈ 0.6931·b
```

This is a hard mathematical bound, known before the market opens. It is the
number the treasury budgets against.

| b | Max house loss (binary) |
|---|---|
| ₦10,000 | ₦6,931 |
| ₦25,000 | ₦17,329 |
| ₦75,000 | ₦51,986 |

### Choosing b — the slippage tradeoff

`b` controls depth. Too small and prices whipsaw; too large and the house
carries needless risk. Measured cost of buying from a 50/50 book:

| b | Buy 1,000 shares | Price moves | Buy 5,000 shares | Price moves |
|---|---|---|---|---|
| ₦3,000 | ₦541 (avg 0.5415) | 0.500 → **0.583** | ₦3,440 | 0.500 → **0.841** |
| ₦10,000 | ₦512 (avg 0.5125) | 0.500 → 0.525 | ₦2,809 | 0.500 → 0.622 |
| ₦25,000 | ₦505 (avg 0.5050) | 0.500 → 0.510 | ₦2,625 | 0.500 → 0.550 |

**b = ₦3,000 is unusable** — a single ₦3,400 trade moves the market 34 points.
₦10,000 is the practical floor.

---

## 4. Fees and creator economics

### Fee: 1.5% per trade, charged on trade value

- Buy: user pays `cost × (1 + f)`
- Sell: user receives `|cost| × (1 − f)`

1.5% matches the existing entry rake, so it is a familiar number.

**Fees must be charged per trade, not on settlement.** This is a hard
constraint, not a preference: an uncertain market may never settle, so a
settlement-only fee would leave the LMSR subsidy unfunded indefinitely.

### Liquidity tiers

Set by an admin at approval time.

| Tier | b | Max house loss | Used for |
|---|---|---|---|
| Starter | ₦10,000 | ₦6,931 | New creators, unproven topics |
| Standard | ₦25,000 | ₦17,329 | Creators with a clean track record |
| Featured | ₦75,000 | ₦51,986 | House-promoted markets |

### The creator threshold

Creators earn **25% of house fees**, but only on fees accrued **after**
cumulative house fees on that market exceed:

```
T = b · ln(N)        # exactly the worst-case subsidy
```

Meaning: **the house fully recovers its maximum possible exposure before a
single naira is shared.** Below the threshold, the creator earns nothing.

| Tier | Threshold T | Volume to reach it |
|---|---|---|
| Starter | ₦6,931 | ₦462,098 |
| Standard | ₦17,329 | ₦1,155,245 |
| Featured | ₦51,986 | ₦3,465,736 |

### Does it pay for itself?

Modelled at Starter (b=₦10,000, 1.5% fee, 25% creator share). Expected realised
subsidy taken at 40% of worst case — **this is an assumption to calibrate
against real data**, not a measured constant:

| Volume | House fees | Creator | House net |
|---|---|---|---|
| ₦100,000 | ₦1,500 | ₦0 | **−₦1,273** |
| ₦300,000 | ₦4,500 | ₦0 | +₦1,727 |
| ₦462,000 | ₦6,930 | ₦0 | +₦4,157 |
| ₦1,000,000 | ₦15,000 | ₦2,017 | +₦10,210 |
| ₦5,000,000 | ₦75,000 | ₦17,017 | +₦55,210 |
| ₦20,000,000 | ₦300,000 | ₦73,267 | +₦223,960 |

House turns profitable around **₦185,000 volume** and is never exposed beyond
₦6,931 on a Starter market. Markets that flop lose the house a small, capped
amount — which is what the approval gate exists to minimise.

### Wash trading is mathematically unprofitable

This is the important result, and it means the threshold is self-defending
rather than needing to be policed.

To unlock fee sharing, a creator must cause the house to collect **T** in fees.
If they generate that volume themselves, **they pay 100% of those fees** — cost
to them is exactly T. LMSR round-trips are otherwise free, so there is no other
gain or loss.

Having spent T, they now earn **25%** of *future* fees. To merely recoup:

```
recoup = T / 0.25 = 4T   in future fees
       = 4 × the volume they washed
```

**A washer must attract 4× their wash volume in genuine trading just to break
even** — at which point the market is genuinely popular and the fees were
earned. Washing is strictly loss-making.

Two secondary gates, cheap to add:

- **≥ 20 distinct funded accounts** must have traded before fees accrue
- **No single account > 40% of volume** (collusion damper)

---

## 5. The Horizon — how uncertain markets stay honest

Every open market carries a **horizon date**. This is *not* a resolution date;
it is a scheduled review.

At the horizon, one of two things happens:

**Resolved** → normal settlement. Winning shares pay ₦1, losing shares ₦0.

**Not resolved** → every holder chooses, within a 72-hour window:

| Choice | Effect |
|---|---|
| **Roll** | Position carries to the next horizon unchanged |
| **Cash out** | LMSR buys the shares back at current market price |

No response defaults to **Roll** (never move a user's money without instruction).

This converts an indefinite lock into a series of bounded, renewable
commitments. Nobody's capital is ever trapped, and "may never resolve" stops
being a liability the house has to eat. It is the direct answer to the problem
these markets otherwise create.

**Auto-retire:** after 3 consecutive horizons with no resolution, the market
closes and all positions are cashed out at the final price. Endless markets are
a support burden and a slow drain.

---

## 6. Creating a market

### Flow

1. Creator writes the question, outcomes, resolution source, and horizon
2. Creator posts a **bond**
3. Submission enters the **review queue** — nothing is public yet
4. Admin scores it against the rubric (§7)
5. Approved → admin assigns a liquidity tier → market opens
6. Rejected → bond returned unless bad faith
7. Resolves cleanly → bond returned + creator fee share

### Bond

Purpose is deterrence against low-effort and bad-faith submissions. It is
refundable and is **not** liquidity capital — keeping those separate keeps the
UX comprehensible.

| Creator standing | Bond |
|---|---|
| New | ₦2,500 |
| 3+ clean markets | ₦1,000 |
| Trusted (10+ clean, zero disputes) | Waived |

**Bond is forfeited only for bad faith**: deliberately ambiguous wording,
attempting to influence the outcome, or an abuse-category submission.

**A market that simply flops is not bad faith** and the bond is returned in
full. Punishing creators for low volume would kill participation, and volume is
mostly outside their control. Flop risk is managed by the approval gate, not by
seizing bonds.

### Creators may never resolve their own markets

Non-negotiable. It is straightforward fraud otherwise. Resolution is always
admin-executed against the pre-declared source.

---

## 7. Approval rubric

The review queue is also the primary anti-abuse control — it is cheaper and more
reliable than trying to detect manipulation after the fact.

### Hard gates — any one is an automatic reject

| # | Gate |
|---|---|
| H1 | Names or targets a **private individual** |
| H2 | Concerns **death, injury, violence, or illegal acts** |
| H3 | The **creator or a small group can influence the outcome** (e.g. "will my post hit 1,000 likes") |
| H4 | **No public, verifiable resolution source** exists |
| H5 | Outcome is **already known** or determined before opening |
| H6 | Category is outside the allowlist |

H3 is the one most often missed on review. Any market whose outcome is
cheap for a participant to cause is unfixable — reject, don't revise.

### Scored dimensions — 0, 1, or 2 each

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| **Resolution clarity** | Outcome is a matter of opinion | Mostly clear, edge cases unstated | Any reader would agree on the outcome |
| **Source quality** | No source named | Named but weak/unstable | Named, public, authoritative |
| **Horizon realism** | No plausible end | Vague but bounded | Concrete review date |
| **Ambiguity resistance** | Multiple readings | One reading, thin edges | Edge cases explicitly handled |
| **Audience interest** | Niche to the creator | Some appeal | Broad Nigerian interest |
| **Category fit** | Borderline | Acceptable | Squarely in the allowlist |

**Total /12:**

| Score | Outcome |
|---|---|
| **10–12** | Approve. Standard tier if creator has track record, else Starter |
| **7–9** | Return for revision with specific notes. Bond retained, one resubmission free |
| **0–6** | Reject. Bond returned unless a hard gate was hit in bad faith |

### Category allowlist (starting set)

**Allowed:** Sport · Nigerian & global politics (outcomes, not individuals) ·
Economy & markets (FX, inflation, indices) · Entertainment & awards ·
Technology & product launches · Weather & climate events · Company milestones

**Blocked:** Anything about private individuals · Death, illness, injury ·
Crime and legal outcomes for named people · Anything a participant can cause ·
Adult content · Markets on Opinions' own metrics (self-referential manipulation)

The allowlist is deliberately narrow at launch. Widening it later is easy;
retracting a category after users have positions is not.

---

## 8. Regulatory position — decide before building

User-created markets on arbitrary real-world events is a **materially different
regulatory posture** from licensed sports betting under Nigerian gaming
regulation. Markets referencing named individuals additionally carry defamation
and harassment exposure.

Required before launch, and this is a decision for you and a lawyer:

- Confirm whether the existing licence covers non-sport event markets
- Terms updated to cover user-generated markets, moderation rights, and disputes
- Documented moderation policy and appeal path
- The category allowlist above signed off

This spec assumes launch happens **bonus-currency-first** (§12), which keeps
financial and regulatory exposure at zero while the abuse and dispute patterns
are learned.

---

## 9. Database schema

```sql
-- One row per open market.
CREATE TABLE open_markets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question          text NOT NULL,
  description       text,
  category          text NOT NULL,
  outcomes          text[] NOT NULL,          -- ['YES','NO'] or multi
  resolution_source text NOT NULL,            -- declared BEFORE opening
  b                 numeric NOT NULL,         -- LMSR liquidity parameter
  q                 numeric[] NOT NULL,       -- share quantities per outcome
  status            text NOT NULL DEFAULT 'pending_review',
                    -- pending_review | revise | rejected | open | halted
                    -- | horizon_window | resolved | retired
  horizon_at        timestamptz NOT NULL,
  horizon_count     smallint NOT NULL DEFAULT 0,   -- auto-retire at 3
  resolved_outcome  smallint,
  created_by        uuid REFERENCES users(id),
  bond_tngn         numeric NOT NULL DEFAULT 0,
  bond_status       text NOT NULL DEFAULT 'held',  -- held|returned|forfeited
  fees_collected    numeric NOT NULL DEFAULT 0,    -- drives the threshold
  creator_paid      numeric NOT NULL DEFAULT 0,
  distinct_traders  integer NOT NULL DEFAULT 0,
  review_score      smallint,
  review_notes      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  opened_at         timestamptz,
  resolved_at       timestamptz
);

-- Current holdings. One row per (user, market, outcome).
CREATE TABLE open_positions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    uuid NOT NULL REFERENCES open_markets(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outcome_idx  smallint NOT NULL,
  shares       numeric NOT NULL DEFAULT 0,
  cost_basis   numeric NOT NULL DEFAULT 0,    -- for P&L display
  bonus_frac   numeric NOT NULL DEFAULT 0,    -- bonus-funded fraction, as bets
  UNIQUE (market_id, user_id, outcome_idx)
);

-- Immutable audit of every trade. Never updated.
CREATE TABLE open_trades (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id    uuid NOT NULL REFERENCES open_markets(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  outcome_idx  smallint NOT NULL,
  delta_shares numeric NOT NULL,              -- +buy / −sell
  cost_tngn    numeric NOT NULL,              -- signed, pre-fee
  fee_tngn     numeric NOT NULL,
  price_after  numeric NOT NULL,
  q_after      numeric[] NOT NULL,            -- full state, for replay/audit
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON open_trades (market_id, created_at DESC);
CREATE INDEX ON open_positions (user_id);
CREATE INDEX ON open_markets (status, horizon_at);
```

`q_after` on every trade means the entire market can be replayed and audited
from the trade log alone — the same principle that made the deposit ledger the
source of truth for settlement.

---

## 10. Trading — the critical path

Every trade must be **one atomic RPC** holding a row lock on the market.
Two concurrent buys reading the same `q` would both price off a stale book and
mint value out of nothing. This is the same class of bug as the deposit race,
and it must be closed the same way.

```
execute_open_trade(market_id, user_id, outcome_idx, delta_shares, max_cost)
```

1. `SELECT ... FOR UPDATE` on `open_markets` — serialises all trades
2. Reject unless `status = 'open'`
3. Compute `cost = C(q + Δ) − C(q)` using log-sum-exp
4. Apply fee; **abort if total exceeds `max_cost`** (user's slippage guard)
5. Debit wallet real-first-then-bonus (mirrors `place_multiplier_slip`)
6. Upsert position, record `bonus_frac` for the settlement split
7. Insert `open_trades` row with `q_after`
8. Update `q`, `fees_collected`, `distinct_traders`
9. Credit creator share if `fees_collected > T` **and** trader gates are met

`max_cost` is not optional. Without it a user who submits a trade while another
lands first can be filled at a materially worse price than they were shown.

### Settlement

On resolution, winning shares pay ₦1 each. The **existing bonus split applies
unchanged** — a position funded 80% from bonus pays winnings 80% back to bonus,
via the same `bonus_winnings_split` ladder. Consistency with the current engines
matters more than novelty here.

---

## 11. Admin surface

### Review queue — `/admin/open-markets/review`
Submission with the rubric rendered as a scoring form. Score, then Approve
(choose tier) / Return for revision (notes required) / Reject (bond decision).

### Exposure dashboard — `/admin/open-markets/exposure`
Live totals: `Σ b·ln(N)` across open markets (worst-case book exposure),
realised subsidy to date, fees collected, creator payouts, and the markets
furthest from break-even. **This is the number that tells you whether the whole
feature is profitable**, and it should be visible on one screen.

### Horizon queue
Markets reaching horizon in the next 7 days, so resolution can be prepared
before the window opens rather than during it.

### Resolution
Select outcome, confirm against the declared source, execute. A **24-hour
dispute window** where any holder can flag; a flagged market halts until an
admin rules.

### Emergency halt
One button, per market: sets `status = 'halted'`, stops all trading, positions
untouched. For a wrong price, a leaked outcome, or a suspected exploit — the
lever you want to already exist at 2am.

### Per-market controls
Adjust `b` (documented, audited), retire early, force cash-out.

---

## 12. User surface

**Market page:** live price as a percentage, price history chart, order ticket
with **cost, shares, average price, and worst-case fill shown before confirm**,
position and unrealised P&L, recent trades.

**Portfolio:** open positions across markets, cost basis vs current value,
unrealised P&L, upcoming horizons.

**Horizon prompt:** notification plus an in-app card — *Roll* or *Cash out*,
with the current price and what each choice pays.

**Create flow:** guided form (question, outcomes, source, horizon), the rubric
shown **before** submission so creators self-select, bond confirmation, and
status tracking.

**Creator dashboard:** volume, fees generated, **progress toward the threshold**
displayed as a bar, earnings to date. Showing the threshold as progress rather
than a locked gate is what makes it feel like a goal instead of a tax.

---

## 13. Build sequence

| Phase | Scope | Gate to proceed |
|---|---|---|
| **1** | LMSR core: cost/price functions, log-sum-exp, property tests | Unit tests pass at extreme q; prices always sum to 1 |
| **2** | Schema + `execute_open_trade` RPC | Concurrency test proves no double-fill under parallel trades |
| **3** | Admin-created open markets only, real money, buy/sell UI | House exposure tracks the model within tolerance |
| **4** | Horizon: roll / cash-out / auto-retire | One full horizon cycle completes cleanly |
| **5** | User creation, bond, review queue — **bonus currency only** | 20+ markets reviewed; rubric calibrated; dispute rate known |
| **6** | Real money on user-created markets | Legal sign-off; abuse patterns understood |

Phase 5 in bonus currency is the single most valuable de-risking step here. It
surfaces the abuse patterns, the rubric's blind spots, and the true dispute rate
at **zero financial exposure**. The cost is a few weeks; the alternative is
learning the same lessons with real user funds.

---

## 14. Open questions

1. **Multi-outcome at launch, or binary only?** Binary is far simpler to price,
   display, and settle. Recommend binary first.
2. **Expected-subsidy calibration.** The 40% figure is an assumption. Phase 3
   should measure it against real markets before Phase 6 sizing.
3. **Bonus balance in open markets** — allowed, or real money only? Allowing it
   drives adoption; it also means bonus can be converted to a tradeable asset
   and cashed out mid-market. Needs the same split treatment as bets, and
   probably a lower cap.
4. **Creator fee in cash or bonus?** Bonus is cheaper and matches how VIP rake
   share already works. Cash is a much stronger growth incentive.

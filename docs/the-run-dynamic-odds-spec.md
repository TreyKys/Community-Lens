# The Run — slightly-dynamic, manipulation-resistant odds

**Status:** design only. Nothing in this document is built. Written to be argued
with before any of it ships.

---

## 1. Why bother

The Run posts fixed odds. An admin sets W/D/L on five fixtures, every entry
locks whatever is posted, and the price never moves. That is simple and safe,
and it has one specific weakness that the payout modelling already exposed:

**concentration.** Everyone on a card plays the same five fixtures. If 400
people all back the three favourites, one result set pays all 400 at once. The
aggregate card liability cap stops that from killing us, but a cap works by
*refusing entries* — it turns a popular card away at the door. That is revenue
we decline because we mispriced the thing people wanted.

Drifting prices fix the cause instead of capping the symptom. Money on a pick
shortens that pick. The most-backed combination therefore pays less than it
would have, the card's expected liability flattens as it fills, and the cap
binds later or not at all. The liability cap stays — drift shapes liability, it
does not control it — but it stops being the first thing that bites.

Two smaller benefits, both real:

- A price that has visibly shortened since the card opened is the most honest
  urgency signal we have. "This pick was 2.50 this morning, it's 2.20 now" is
  FOMO we don't have to manufacture.
- Posted-vs-settled data becomes worth something. Right now we have no way to
  know whether our opening lines are good, because nothing ever disagrees with
  them.

## 2. The thing that must not happen

> It shouldn't be so dynamic to the extent people learn how to manipulate it
> for higher winnings.

The attack, stated plainly: **move the line with cheap money, then collect at
the improved price.** Put a small stake on W so that D and L lengthen, then put
a big stake on L at the price you just created. In a sportsbook this is the
oldest trick there is.

So the central design question is not "how do prices move" but **"what does it
cost to move them, and what can you collect once you have?"**

### 2.1 What The Run already makes hard

The Run's structure blunts the attack in a way a single-fixture sportsbook does
not, and this is worth stating before we add any defences:

**There is no such thing as a cheap probe.** Every entry must pick all five
fixtures. You cannot put ₦500 on "leg 3 Win" to nudge leg 3. To move leg 3 you
must submit a complete five-leg entry that includes Win on leg 3 — a real
position, priced with real money, competing with your own intended entry. And
your intended entry picks something *else* on leg 3, so the probe and the real
ticket are guaranteed to disagree on that leg: at most one of them can be a
five-for-five.

That is not a full defence. A patient attacker makes the probe their genuine
opinion on the other four legs, so the probe's cost collapses to the expected
difference on one leg — small. But it does mean the attack starts from a worse
place here than in a book where a ₦500 single is a free option.

### 2.2 The defences, in order of how much work they do

**(a) Your own money never improves your own price.** When pricing a quote for
user U, compute the crowd signal with U's own entries removed. Self-probing is
then not expensive — it is *arithmetically worthless*. This kills the primary
attack outright for a single account, and it costs nothing in accuracy, because
one user is a negligible part of a healthy pool anyway.

It is defeated by multiple accounts, which is why it hangs off the same identity
signals the referral bounties already lean on (deposit account, device, phone).
Those signals are imperfect; this defence is therefore strong but not total,
which is why there are four more.

**(b) Cap each account's weight in the signal.** A user's contribution to the
crowd signal is capped at a fixed share of the pool — say 2% — no matter what
they actually staked. Their money still counts in full for liability; it just
stops counting for pricing past the cap. This **decouples how much you can
stake from how much you can move the line**, which is precisely the lever an
attacker is reaching for.

**(c) Require liquidity before trusting the signal.** The learning weight ramps
with pool size:

```
λ_eff  =  λ_max × min(1, pool / pool_floor)
```

Below `pool_floor` the card is effectively static. This matters enormously right
now: with a ₦50,000 card pool, one ₦20,000 account *is* the crowd, and any
signal we read is that account talking to itself. With a ₦5m pool it cannot be.
**Dynamic odds are only safe once liquidity is large relative to the per-user
stake cap, and today it is not.** The ramp means we can ship the machinery and
have it stay dormant until the volume that makes it safe actually arrives,
rather than guessing a launch date.

**(d) Lag and quantise.** Reprice on a schedule (every 15 minutes), snap to a
coarse ladder (0.05 steps), never continuously. An attacker cannot watch the
number respond to their own stake and binary-search it. They must commit, wait,
and accept that other money moved it meanwhile.

**(e) Freeze at the end.** No drift in the final N minutes before close, and
none at all once any leg has kicked off. The last price people see is the price,
and the in-play information asymmetry that cash-out already locks against does
not leak into pricing either.

### 2.3 The principle underneath all five

**We trust breadth, not size.**

Real information — team news, a suspension, weather — arrives through *many*
accounts staking independently. Manipulation arrives through *few* accounts
staking a lot. Every defence above penalises concentration and leaves breadth
untouched. That is the whole design in one line, and it is also why we should
*want* an informed crowd to move our line: information moves price toward truth,
manipulation moves it away, and the two are distinguishable by their shape.

## 3. The pricing mechanism

### 3.1 Drift must preserve the overround

For each leg, convert the opening odds to implied probabilities and normalise:

```
p_x  =  (1 / o_x) / Σ_y (1 / o_y)          for x in {W, D, L}
```

Let `q_x` be the crowd's share of that leg's capped signal. Blend, anchored
always to the **opening** line, never to the last posted price:

```
p'_x  =  (1 − λ_eff) · p_x  +  λ_eff · q_x
```

Re-post at the same overround the card opened with:

```
o'_x  =  1 / (p'_x × overround_open)
```

Anchoring to the opening line (rather than iterating on the current price) is
what makes λ a genuine bound on total displacement instead of a step size in a
random walk. Preserving the overround is not cosmetic: the payout coefficient is

```
k  =  rtp_target / Π_i [ p_i · o_i + (1 − p_i) · decay ]
```

with `p_i = (1/o_i)/overround_i`. If drift changed the overround, the solved RTP
would change with it. Preserve it and the house's theoretical margin per leg is
**invariant under drift** — drift reallocates exposure, it does not touch margin.
That is the property that makes this safe to ship.

### 3.2 Worked example

Leg opens 2.50 / 3.40 / 3.20 (overround 1.082). Normalised: W 0.43, D 0.32,
L 0.34. Suppose 80% of the capped signal lands on W, and λ_eff is at its
proposed maximum of 0.15:

| | opening | crowd q | p' | new price |
|---|---|---|---|---|
| W | 2.50 | 0.80 | 0.49 | **2.20** |
| D | 3.40 | 0.10 | 0.29 | **3.80** |
| L | 3.20 | 0.10 | 0.30 | **3.65** |

That is the *extreme* of the whole card's life, not a step. Favourite shortens
by 12%, the unloved sides lengthen by about the same. Visible, worth reacting
to, and nowhere near enough to invert anyone's judgment about the fixture —
which is what "slightly dynamic" has to mean.

Note what an attacker gets at the limit: they must dominate 80% of a capped
signal on a pool above the floor, wait out the repricing lag, have their own
contribution excluded from their own price, and the prize is L at 3.65 instead
of 3.20. Against a per-account stake cap, that does not pay for the probes.

### 3.3 What needs no change

The payout engine. `run_coefficient(p_odds, p_overrounds, p_rtp_target, p_decay)`
is already a pure function of whatever odds it is handed, entries already store
their own locked `coefficient`, and `run_entry_picks.odds` already locks a price
per leg per entry. Heterogeneous prices across entries on one card are therefore
**already supported today**. Dynamic odds change only what odds get passed in at
placement.

## 4. Two learning loops — and only one is automatic

**Within a card (automatic).** The blend above. Bounded, anchored, dormant below
the liquidity floor.

**Across cards (human, offline).** After settlement, measure whether the crowd
share `q` predicted results better than the opening line `p`. If it did,
consider raising `λ_max`. If it didn't, lower it.

This loop is deliberately **not** automated. A λ that tunes itself from
settled outcomes is a slower, richer attack surface than the one we just spent
section 2 closing: an attacker who cannot move one card can still try to teach
the system that the crowd is wise. λ moves when a human looks at a quarter of
settled cards and decides it should. Nothing in production self-adjusts.

## 5. What to build

**Schema**

- `run_legs`: add `open_odds_w / open_odds_d / open_odds_l`. Keep
  `odds_w/d/l` as the current posted price. Without the opening anchor, λ
  bounds nothing.
- `run_leg_price_history (run_id, leg_index, at, odds_w, odds_d, odds_l,
  pool_tngn, lambda_eff, signal_w, signal_d, signal_l)`. Needed for disputes
  ("you changed my odds"), for the section-4 calibration loop, and for shadow
  mode below.
- `runs`: `price_mode ('static' | 'shadow' | 'dynamic')`, `lambda_max`,
  `pool_floor_tngn`, `signal_cap_pct`, `reprice_interval_min`,
  `freeze_before_close_min`, `odds_step`. **Default `static`**, so every
  existing card and every card an admin forgets about behaves exactly as it
  does today.

**Jobs**

- A repricing job on the existing 15-minute Run cron. Reads entries, builds the
  capped signal, applies the blend, snaps to the ladder, writes `run_legs` and
  appends to history. Skips any card that is static, under the floor, frozen,
  or has a kicked-off leg.
- Alert when a leg hits the λ bound. That is not a pricing event, it is a
  signal that the opening line was wrong, and a human should look at the card.

**Admin**

- `price_mode` per card, flippable to `static` at any time — the kill switch.
- The five parameters, with the preset defaults below, editable but not
  prominent. Admins should be choosing a preset, not tuning seven numbers.
- Price history visible on the card, so a support question has an answer.

**Player**

- Per-outcome drift indicator: a small ↓ or ↑ against the opening price.
- One line of copy: *"Prices move as the card fills. You lock the price you see
  when you enter."*
- Terms: a clause saying posted odds may move before close, that an accepted
  entry's odds are fixed at acceptance, and that settlement uses the locked
  odds.

**Proposed starting values**

| | conservative | later |
|---|---|---|
| `lambda_max` | 0.08 | 0.15 |
| `pool_floor_tngn` | 2,000,000 | 1,000,000 |
| `signal_cap_pct` | 2% | 2% |
| `reprice_interval_min` | 15 | 15 |
| `freeze_before_close_min` | 60 | 30 |
| `odds_step` | 0.05 | 0.05 |

## 6. Rollout

**Phase 0 — shadow mode. Do this first and do it even if we never ship the
rest.** `price_mode = 'shadow'` computes the drift and writes it to
`run_leg_price_history`, and posts nothing. No player sees a changed price, no
money is at risk, and after a dozen settled cards we can answer the question
this whole document is built on top of a guess about: *does stake share on our
cards predict results better than our opening lines do?* If it doesn't, section
3 is a solution to a problem we don't have, and we have learned that for free.

**Phase 1 — one card, λ 0.08, floor set high enough that it stays dormant.**
Proves the plumbing, the history table and the kill switch under real traffic
without moving a real price.

**Phase 2 — lower the floor to where drift actually engages.** Only once a
single card routinely takes a pool that dwarfs the per-user stake cap. Watch the
λ-bound alerts and the first support tickets about moving prices.

**Phase 3 — widen, and run the section-4 review quarterly.**

## 7. Honest limitations

- **Multi-account manipulation survives.** Defence (a) is per-account and the
  identity signals behind it are imperfect. Defences (b)–(e) degrade it to
  unprofitable rather than impossible.
- **A sharp crowd that is sharp about the wrong thing moves us wrong.** The λ
  bound caps the damage at a known displacement; it does not prevent it.
- **Drift does not control liability.** It flattens the distribution. The
  aggregate card liability cap remains the guardrail that actually stops a bad
  day, and nothing here should be read as a reason to loosen it.
- **None of this is worth building for its own sake at current volume.** Phase 0
  is cheap and informative. Phases 2 and 3 are waiting on liquidity we do not
  have, and the ramp exists so that waiting is the default rather than a
  decision someone has to remember to make.

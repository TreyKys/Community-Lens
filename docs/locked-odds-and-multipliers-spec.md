# Locked Odds + Multipliers — Engineering Spec (Phase 0)

> Status: **DRAFT for review.** Nothing here is built yet. This is the canonical
> reference we lock before any real-money code is written. Two items are tagged
> **DECISION NEEDED** — resolve those before Phase 1.

---

## 0. Decisions locked (from product)

| # | Decision | Value |
|---|----------|-------|
| 1 | Tier 1 odds model | **Locked odds** (not parimutuel) |
| 2 | Floor (1.03 / 1.02) | **Server-enforced** — a real guaranteed minimum, not display-only |
| 3 | Vig baseline | **8%** (auto-widens to 10% under reserve stress) |
| 4 | Pool rake | **Margin kept — collected as vig, not as a settlement skim** (see §2) |
| 5 | Entry rake | **1.5%, kept, invisible to user** |
| 6 | Same-event legs (SGP) | **Allowed, but Phase 9 fast-follow with correlation guardrails** (see §9) |

---

## 1. Core concept

Today: pure parimutuel. A bet's payout depends on the final pool composition at
resolution. The house never carries directional risk; it skims rake.

New: **locked odds**. At the moment a user stakes, we freeze a multiplier on
their bet. If they win, they are paid `net_stake × locked_odds`, regardless of
how the pool moves afterward. The house now carries **bounded directional risk**,
backed by a **₦150,000 reserve**.

The house edge is the **vig** — margin baked into the quoted odds. We never skim
a displayed number after the fact (that breaks the "locked" promise and is the
discretionary-payout trap we explicitly rejected).

### Display: range, honored as a floor
The user is shown a **range** ("₦675 – ₦800 if correct"), not a single number.

- The **bottom of the range is the server-enforced floor** — the guaranteed
  minimum we will always pay.
- The **top** is realistic upside if opposing money keeps landing.
- We **always pay ≥ the bottom.** We pay more when the pool moves favorably.
  **We never pay less than the displayed floor.**
- Copy: *"Your winnings grow every time someone predicts the other way."* — this
  is literally true, which is what makes the range honest rather than bait.

More multiplier legs → genuinely more variance → genuinely wider range. The
"wider range with more legs" intuition holds, honestly.

---

## 2. **DECISION NEEDED #1** — where the margin lives

You asked to keep pool rake (10%) **and** entry rake (1.5%) **and** run 8% vig.
Under locked odds these can't all be literal skims — quoting a locked payout and
then skimming 10% at settlement makes "locked" a lie.

**Proposed reconciliation:**

| Lever | Mechanism | User sees |
|---|---|---|
| Entry rake 1.5% | Shaved off stake → `net_stake` before odds apply | Gross stake + payout only. Never the shave. |
| Pool rake 10% | **Folded into vig** — not a settlement skim | Nothing — it's in the price |
| Vig 8% | Baked into the displayed locked odds | The (already-margined) odds |

- Net **singles margin ≈ 9.4%** (8% vig + 1.5% invisible entry).
- Net **multiplier margin ≈ 32% (5-leg) … 54% (10-leg)** from vig compounding.
- Slightly less than the old 11.5% on singles — deliberate; cheaper singles =
  more volume = more multiplier feed.

> **Do NOT stack vig 8% + a full 10% pool-equivalent** → ~18% on singles → odds
> so bad nobody bets singles. Confirm the table above, or correct it.

---

## 3. The odds algorithm (canonical — one function, used by server + admin preview)

`lib/lockedOdds.ts` — pure, unit-tested, no I/O. Display and settlement call the
SAME function so there is never a "showed 1.85×, paid 1.83×" gap.

```
calculateLockedOdds(market, stake, outcomeIndex, user):
  # 1. Effective pools = house seed + real stakes
  effective[i] = market.seed_pool[i] + market.real_pool[i]   for each outcome i

  # 2. Slippage-safe: include THIS stake on the chosen side before pricing.
  #    Large stakes get worse odds — stops a whale grabbing the pre-stake line.
  effective[outcomeIndex] += net_stake          # net_stake = stake * (1 - 0.015)

  total       = sum(effective)
  pool_chosen = effective[outcomeIndex]

  # 3. Raw fair odds (no margin)
  raw = total / pool_chosen

  # 4. Effective vig
  vig = market.vig_pct                                  # default 0.08
  if reserve_health < 0.6:  vig += 0.02                 # stressed → wider
  if user.accuracy_tier == 'pro':  vig = max(vig - 0.02, 0.04)   # 75%+ privilege

  # 5. Apply vig
  odds = raw / (1 + vig)

  # 6. Server-enforced floor (decision #2)
  floor = 1.03 if stake < 500 else 1.02                 # monotonic; see lib/displayMultiplier
  odds  = max(odds, floor)

  # 7. Sanity ceiling — no 100x even on a thin market
  odds  = min(odds, MAX_ODDS)                           # MAX_ODDS = 25

  # 8. Deterministic rounding (same for display + settlement)
  return round(odds, 2)
```

### Display range from the locked odds
```
floorPayout = round(net_stake * locked_odds)            # the GUARANTEED minimum
upperPayout = round(net_stake * fairOddsIfPoolFills)    # realistic upside
show "₦{floorPayout} – ₦{upperPayout} if correct"
settle  >= floorPayout  always
```

### Edge cases the function must handle (each is a real exploit or crash)
1. Slippage — stake included before pricing (step 2).
2. Reserve-health vig widening (step 4).
3. Accuracy-privilege discount (step 4).
4. MAX_ODDS sanity ceiling (step 7).
5. Floor above post-vig odds → house pays the gap (bounded by liability ceiling).
6. `total <= 0` defensive → return MAX_ODDS, never crash.
7. Multi-outcome (>2): same formula per outcome; vig applies symmetrically.
8. Display == settlement: identical function both sides.

---

## 4. Schema changes (Phase 1 migration — reversible, no behaviour change)

**`markets`** add:
- `is_locked_odds boolean default false` — per-market rollout flag
- `seed_pool jsonb default '{}'` — `{outcome_index: tngn}` house seed
- `seed_probability numeric` — admin's pre-seed estimate (calibration log)
- `vig_pct numeric default 0.08`
- `is_paused boolean default false` — admin pause (locked stakes → parimutuel fallback)

**`user_bets`** add:
- `locked_odds numeric` — frozen multiplier (null for legacy parimutuel bets)
- `tier smallint` — 1 or 2 (off the *bet* stake; off the *slip* stake for multipliers)
- `bet_kind text default 'single'` — `single` | `multiplier_leg`

**New `house_reserve`** (singleton, service-role only):
- `total_tngn`, `floor_tngn` (30000, never deployed), `deployable_tngn`

**New `market_liability`** (one row per locked-odds market):
- `market_id`, `exposure_by_outcome jsonb`, `worst_case_tngn`, `updated_at`

**New (Phase 7) `multiplier_slips`**:
- `id`, `user_id`, `slip_stake_tngn`, `combined_odds`, `floor_payout_tngn`,
  `upper_payout_tngn`, `max_payout_cap_tngn`, `status`, `is_sgp`, `created_at`

**New (Phase 7) `multiplier_legs`**:
- `slip_id`, `market_id`, `outcome_index`, `locked_odds`, `status`

**New (Phase 8) `boost_wallet`** (the consumable — naming TBD, see §10):
- `user_id`, `balance`, `last_recharge_at`

---

## 5. Stake placement — `place_bet_locked` RPC (Phase 3, FLAG-GATED)

Existing parimutuel `place_bet` untouched. New markets opt in via `is_locked_odds`.

1. Row-lock `markets.id`.
2. Read effective pools (seed + real).
3. `calculateLockedOdds(...)`.
4. **Liability ceiling check** for that side. Breach → reject (Tier 2) or silent
   parimutuel fallback (Tier 1).
5. **Reserve floor check.** Under threshold → pause new locked stakes.
6. Write bet row with frozen `locked_odds`, `tier`. Update real_pool. Update
   `market_liability`. Shave 1.5% entry rake (invisible). All atomic.

---

## 6. Settlement — locked path (Phase 4, FLAG-GATED)

For `is_locked_odds` markets:
- Winners: `payout = max(net_stake × locked_odds, floor_payout)`.
- Losers: 0 (stake already collected).
- House P&L = `seed_recovered + losing_stakes − winning_payouts`.
- `house_reserve.total += P&L`. Clear `market_liability`.
- VIP rake-share: slice of **house margin** per losing referred bet (formula
  changes from pool-rake slice → margin slice).
- First-mover (winning side has bets, losing side empty): pay winners at locked
  odds from reserve. Bounded by per-market liability ceiling.

---

## 7. Tiers & routing (silent)

- Tier by stake size: `< ₦500` = Tier 1, `≥ ₦500` = Tier 2. **For multipliers,
  tier off the SLIP stake, not per leg.**
- Then by reserve health (dynamic cap, §8). User sees the same form, same range,
  same "grows as others join" copy. No visible tier seam.

---

## 8. Safety rails (baked in regardless)

- **Kill switch** env var → disable all locked odds site-wide, route to parimutuel.
- **Per-market liability ceiling**: ₦40,000/side hardcoded.
- **Reserve floor**: ₦30,000 of the ₦150k untouchable.
- **Dynamic stake cap** tied to reserve health:
  | Reserve health | User cap |
  |---|---|
  | > ₦80k | ₦5,000 |
  | ₦50–80k | ₦3,000 |
  | ₦30–50k | ₦1,500 |
  | < ₦30k | **Tier 2 paused → parimutuel fallback** |
- **Max simultaneous locked-odds markets**: 2 at launch.
- **Manual review** of first 20–50 locked settlements before raising caps.
- **Ops-email alert** when a market nears its liability ceiling.
- **Reserve allocation (₦150k):** ₦30k floor + ₦120k deployable; max ₦14k seed/market,
  2 markets → ₦28k seeded, ₦80k worst-case across 2, ₦40k buffer > floor. ✓

---

## 9. Multipliers

### Base (Phase 7) — different-event legs only
- Legs: 2–5 (Tier 1) / 2–10 (Tier 2). Gated by slip stake.
- Combined odds = product of legs' locked odds.
- **Range display, floor honored** (same rule as singles).
- **Trickle settlement**: each leg resolves independently; one loss kills the slip
  immediately (shows 0), no waiting for other legs.
- **Voided leg → 1.0×**, slip continues with remaining product (bookie standard).
- **Min combined odds ≥ 3.0×** — forces real risk, blocks risk-free arbitrage.
- **Min leg odds ≥ 1.20×** — stops "sure thing" farming.
- **Max payout cap per slip**: ₦200,000 (T&C disclosed).
- **One leg per event** in base mode.

### SGP — same-event legs (Phase 9, **DECISION NEEDED #2: confirm sequencing**)
Allowed, with correlation guardrails (no full correlation model required at first):
1. **Blocklist** known-correlated pairs (a market + its own sub-market; e.g.
   "Over 2.5" + "BTTS"). Maintained list, conservative.
2. **Correlation surcharge** — extra vig on same-event multi-legs (the "stringent
   fees" lever). Absorbs mispricing.
3. **Lower max-payout cap + lower liability ceiling** on SGP slips.
4. **Manual review** of first SGP settlements.

> Rationale for sequencing AFTER base: positively-correlated legs priced as
> independent overpay massively and are the #1 sharp exploit. Ship base first,
> add SGP once the engine is proven.

---

## 10. The consumable economy ("Boosts" — naming TBD)

The thing dashed/sold to *unlock* multiplier slips. **Naming clash:** the feature
is "Multiplier"; the consumable needs a distinct name — proposed **"Boosts"**
(alt: Tickets / Slips). Pick one before Phase 8.

- **5–6 free** on signup (the hook).
- **Recharge** 1/day up to a cap (retention loop).
- **Buy more** at ₦50–100 each — pure margin, **never touches the prediction pool**.
- **Expiry**: free Boosts expire in 7 days (urgency).
- **Buy cap** per day (anti-abuse).

---

## 11. Rollout sequence

| Phase | Deliverable | Gate | Risk |
|---|---|---|---|
| 0 | **This doc** | Product sign-off | None |
| 1 | Schema migration | Reversible, no behaviour change | Low |
| 2 | `lib/lockedOdds.ts` + unit tests | Pure function | None |
| 3 | `place_bet_locked` RPC | `is_locked_odds` flag, 1 pilot market | High → flagged |
| 4 | Locked settlement + liability ledger | Flag, opt-in | High → flagged |
| 5 | Admin seeding UI + live preview | — | Medium |
| 6 | Auto-pause + tier routing + reserve monitor | The seatbelt | Medium |
| 7 | Multiplier engine (different-event) | Builds on 1–6 | High |
| 8 | Boosts consumable economy | Margin layer, off-pool | Low |
| 9 | SGP (same-event) + correlation guardrails | Fast-follow | High → guarded |

Each phase is its own PR, independently testable and rollback-able. We never have
a half-built engine touching real money.

---

## 12. Open decisions before Phase 1

1. **§2 — margin reconciliation.** Confirm: entry rake 1.5% invisible + pool rake
   folded into 8% vig (NOT stacked). Or correct.
2. **§9 — SGP sequencing.** Confirm SGP is Phase 9 fast-follow, base multipliers
   (different-event) first. Or insist on SGP in Phase 7.
3. **§10 — consumable name.** "Boosts" / "Tickets" / "Slips" / other.
4. **Vig per market type** — accept 8% flat to start, or set the per-category
   defaults now (sports 6–8%, entertainment/politics 9–10%).

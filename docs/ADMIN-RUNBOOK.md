# Admin runbook

Everything an admin can do, what it costs, and what it cannot be undone from.
Written for whoever is on shift, not for whoever wrote the code.

Two staking engines exist. They are **modes**, not separate products:

| | **Locked Odds** | **Trading (Open Markets)** |
|---|---|---|
| Price | Fixed the moment you stake | Moves with every trade |
| Exit early | No — held to resolution | Yes — sell any time |
| House risk | Bounded by the seeded pool | Bounded by `b·ln(N)`, fixed at approval |
| Created at | `/admin` → Create Market | `/admin/open-markets/new` |
| Goes live | Immediately | Only after review approval |

A market is one or the other. Both can appear on the same hub page.

---

# 1. Locked Odds — the original engine

**Create:** `/admin` → Create Market. Unchanged from before.

Two optional fields were added:

- **Sport tag** → `markets.sport`, e.g. `bbn`, `basketball`, `tennis`,
  `esports`, `fight`
- **Hub tag** → `markets.league_code`, e.g. `BBN_EVICTION`, `NBA`

Leave both blank and nothing changes. Fill them and the market also shows on
its hub page. That is all they do — routing, nothing else.

**Resolve:** `/admin/resolve`, as always.

---

# 2. Trading — Open Markets

## 2.1 Creating one

**You create it:** `/admin/open-markets/new` → **New market** button on the
review queue.

**A user creates it:** `/open/create`. Lands in the same queue. They may have
3 pending at a time.

Either way it arrives at `pending_review` and is **invisible to the public**
until approved. It is not live and no money is committed yet.

The **creator field** on the admin form decides one thing:

- **Blank = house market.** No creator, no fee share, and *anyone including
  you* can trade it. Use this for testing and for house-authored markets.
- **A user's UUID** = they earn 25% of fees above the threshold. They then
  cannot trade it, and cannot review it.

## 2.2 Approving one — `/admin/open-markets`

This is the gate. **Approving commits house money.** Everything else in this
engine is downstream of the decision made here.

**Hard gates.** Tick any one and it is an automatic reject — no scoring:

| | |
|---|---|
| H1 | Names or targets a private individual |
| H2 | Death, injury, violence, illegal acts |
| H3 | The creator or a small group can *cause* the outcome |
| H4 | No public, verifiable resolution source |
| H5 | Outcome already known |
| H6 | Category outside the allowlist |

H3 is the one most often missed. "Will my post hit 1,000 likes" is
unfixable — reject it, do not send it back for revision.

**Score six dimensions, 0–2 each:**

resolution clarity · source quality · horizon realism · ambiguity resistance ·
audience interest · category fit

| Total | Outcome |
|---|---|
| **10–12** | Approve |
| **7–9** | Send back for revision (notes required — they are shown to the creator) |
| **0–6** | Reject |

The Approve button will not fire below 10. That is enforced in the database,
not just the UI.

**Liquidity tier — this is the money decision:**

| Tier | b | Max the house can lose | Creator earns after |
|---|---|---|---|
| Starter | ₦10,000 | ₦6,931 (2 outcomes) | the same figure in fees |
| Standard | ₦25,000 | ₦17,329 | " |
| Featured | ₦75,000 | ₦51,986 | " |

Bigger tier = smoother prices (a single big bet moves the odds less) and a
bigger possible loss. Use Starter for anything unproven. The figure shown on
the card is the real maximum — it cannot lose more than that, whatever
happens.

**Trading close time is mandatory.** It must be before the answer becomes
public knowledge. Otherwise the book is still live while the result is
knowable and the house is the counterparty to every informed trade.

**Four eyes:** you cannot approve a market you created. Enforced in the
database.

## 2.3 Resolving one — `/admin/open-markets/resolve`

Order matters:

1. **Close trading** — resolution is unreachable while the book is live.
2. **Resolve** (pick the winner) or **Void** (give money back).
3. **Preview first.** Every action previews from the same code path that
   applies it, so what you see is what will happen.
4. Apply.

**Resolution needs two people.** You paste a second admin's user UUID as
confirmer. Neither of you may be the creator. Evidence link is required.

**Void has two kinds:**

- *Unanswerable* → splits at last traded prices
- *Our mistake* → refunds what people paid, house tops up the difference

**Payouts are HELD** for the dispute window (24h default) before landing in
wallets. That delay is the entire point: once money is in a withdrawable
balance it cannot be clawed back. The cron releases automatically when the
window passes; "Release payouts now" is there for when it is stuck.

## 2.4 Watching the money — `/admin/open-markets/exposure`

The number to look at daily is **committed worst case** — the most the house
can lose across every live trading market at once.

It is shown against **house reserve deployable**, not on its own, because that
reserve is shared with the locked-odds and multiplier engines. Money committed
here is money those two cannot use.

| Reading | Meaning |
|---|---|
| under 60% of deployable | fine |
| 60–80% | warning — stop approving Featured tiers |
| over 80% | critical — stop approving anything |

Also here: **pause the whole engine** (blocks new trades and approvals;
existing positions stay exitable — never freeze people's money), **halt one
market**, **sweep fees** into the reserve, and **change the fleet cap**.

The health panel at the top re-derives every book from its trade log. Anything
red there means a book no longer matches its own history — stop and
investigate before resolving anything.

---

# 3. What runs by itself

`cron-open-markets.yml`, every 15 minutes. It:

- opens horizon (review) windows that have come due
- closes expired ones and pays whoever chose to cash out
- releases settlements whose dispute window has passed
- sweeps fees into the house reserve
- runs the health scan and raises an admin alert on anything critical

**Requires `CRON_SECRET` and `API_BASE_URL` in GitHub Actions secrets** — the
same two the other crons use. If those are missing it fails silently and none
of the above happens: horizons never fire, cash-outs are never paid, and
settled money sits unreleased forever. Worth confirming once.

---

# 4. Other tools

| Screen | What it is for |
|---|---|
| `/admin/deposits` | Squad deposits stuck mid-flight. "Re-verify" re-checks the charge and credits it if it really was paid. The direct lever for un-sticking a user's deposit. |
| `/admin/bonus-repair` | One-time repair for slips stamped with the wrong bonus/cash split. Moves money for already-settled slips, clamped to what is actually in the wallet — a shortfall is reported, never fabricated. |

---

# 5. Things that cannot be undone

Read this before your first live market.

- **Approving** commits house money the moment the book opens.
- **Released payouts** cannot be clawed back. The dispute window is the only
  window.
- **Liquidity tier is fixed at approval.** Changing `b` on a live book would
  silently move money between existing holders.
- **Resolving** with the wrong outcome pays the wrong people. Preview, and use
  the second pair of eyes properly rather than clicking through it.

Reversible: pausing the engine, halting a market, sending back for revision,
rejecting, and changing the fleet cap.

---

# 6. First live market — suggested order

1. `/admin/open-markets/new`, creator field **blank** (house market, so you
   can trade it yourself)
2. Approve it at Starter tier, close time a few hours out
3. Open it from `/open`, buy ₦500 of one side
4. Check `/open/portfolio` shows the position
5. Sell half — confirm you get back less than you paid (fee twice plus the
   price move; that is correct, not a bug)
6. Close trading → resolve with a second admin UUID → preview → apply
7. "Release payouts now" rather than waiting 24h
8. Confirm the wallet balance moved and `/admin/open-markets/exposure` is clean

Do this once end to end before any real user touches it.

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

**"Your user ID" is required, and it is not the admin password.** The admin
login (`/admin`'s "Admin secret" screen) is one shared secret with no idea
which specific person is using it — so submit, review and resolve each ask
for *your own* opinions.ng account UUID by hand, in a plain text box, right
on the screen. Type it once anywhere on the Open Markets admin pages and it
is remembered in that browser for the other two — they share one
localStorage key.

**Find your UUID once:** sign into your own opinions.ng account (a real one,
not the admin login) → `/profile` → the small ID line under your name has a
copy button. This is what four-eyes actually checks against: submit a
market under your ID and you will not be able to review, trade or resolve
it under that same ID later.

*(There is a server-side `ADMIN_REVIEWER_USER_ID` env var these screens fall
back to if the field is left blank. It exists for cron/automation, not for
people — everyone sharing that one ID makes four-eyes meaningless, since it
is the same identity submitting, reviewing and resolving. Type your own ID.)*

**A user creates it:** `/open/create`. Lands in the same queue. They may have
3 pending at a time.

Either way it arrives at `pending_review` and is **invisible to the public**
until approved. It is not live and no money is committed yet.

The **creator field** decides who *earns*, and nothing else:

- **Blank = house market.** No creator, so no fee share is paid out.
- **A user's UUID** = they earn 25% of fees above the threshold.

**Who put it there is recorded separately and always.** Whoever submits a
market — including a house market with no creator — cannot then review it,
trade it, or resolve it. Four eyes holds whether or not anybody is being paid.

That matters because a house market is the natural thing to reach for when
testing, and it used to be the one configuration where all three of those
guards fell open at once.

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

**Four eyes:** you cannot approve a market you created *or submitted*. Both
are enforced in the database, not just hidden in the UI.

## 2.3 Resolving one — `/admin/open-markets/resolve`

Order matters:

1. **Close trading** — resolution is unreachable while the book is live.
2. **Resolve** (pick the winner) or **Void** (give money back).
3. **Preview first.** Every action previews from the same code path that
   applies it, so what you see is what will happen.
4. Apply.

**Resolution needs two people.** You paste a second admin's user UUID as
confirmer. Neither of you may be the market's creator, and neither may be
whoever submitted it. Evidence link is required.

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

`cron-push.yml`, every 5 minutes. Delivers notifications to people's phones.

It is a **sweeper**, not a hook: every notification row carries a `pushed_at`,
and this sends whatever is unpushed. That means anything anywhere in the app
that writes a notification gets a phone notification for free — including code
that does not exist yet. Nothing needs wiring up per feature.

Three behaviours worth knowing before you get a support ticket about them:

- **Nothing older than 24 hours is ever pushed.** After an outage the backlog
  is delivered to the in-app bell only. Buzzing someone's phone twenty times at
  6am about things that already happened is how an app gets uninstalled.
- **A notification is marked pushed even if a device rejected it.** Retrying
  per-notification would re-send to that person's *working* devices every time
  one dead device failed.
- **Dead devices are retired, not deleted** (`push_subscriptions.failed_at`).
  If someone says they stopped getting notifications, look there first — a
  `410` means their browser threw the subscription away, and it comes back on
  its own the next time they open the app.

## Switching push on

**What this actually is.** Phone notifications don't come from our server
directly — they go through Google's, Apple's and Mozilla's push services, which
deliver to the phone even when the browser is closed. Those services will not
carry a message from just anybody, so we need an identity: a pair of
cryptographic keys, generated once, that says "this really is Opinions.ng".
The **public** key is handed to each browser when it subscribes; the **private**
key signs every message we send. That pair is all the setup there is.

The code is already deployed and already switched off on purpose. It stays off
until those keys exist — `/api/cron/push` just returns
`{ skipped: "VAPID keys not configured" }` and nothing else in the app changes.

**1. Generate the pair. Once, ever, on any machine:**

```
npx web-push generate-vapid-keys
```

It prints a `Public Key:` and a `Private Key:`. Keep both — put them in the
password manager now, because step 2 is the only place they get stored.

**2. Put them on the production server.** Paste the two keys into the two
`PASTE_` lines below, then run the whole block. It edits `~/app/.env` in place
and restarts — no editor, no rebuild, no redeploy.

```bash
ssh YOUR_USER@YOUR_HOST 'bash -s' <<'REMOTE'
set -euo pipefail
cd ~/app

# Refuse to touch anything unless .env is where we expect it. Without this a
# wrong directory silently CREATES a .env holding nothing but these three keys
# while the real one is never updated — which looks identical to keys that did
# not work.
[ -f .env ] || { echo "FAIL: no .env in $(pwd) — nothing changed"; exit 1; }

cp -p .env ".env.bak.$(date +%Y%m%d-%H%M%S)"

grep -v -E '^VAPID_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)=' .env > .env.tmp || true
cat >> .env.tmp <<'EOF'
VAPID_PUBLIC_KEY=PASTE_PUBLIC_KEY_HERE
VAPID_PRIVATE_KEY=PASTE_PRIVATE_KEY_HERE
VAPID_SUBJECT=mailto:support@opinionsng.com
EOF

# Every non-VAPID line that was in the old file must be in the new one. This is
# what makes replacing the file safe: if anything truncated the rewrite, .env is
# left exactly as it was.
before=$(grep -cvE '^VAPID_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)=' .env || true)
after=$(grep -cvE '^VAPID_(PUBLIC_KEY|PRIVATE_KEY|SUBJECT)=' .env.tmp || true)
if [ "$after" -lt "$before" ]; then
  echo "FAIL: $before other lines before, only $after after — .env NOT changed"
  rm -f .env.tmp; exit 1
fi

mv .env.tmp .env && chmod 600 .env
echo "OK: $before other lines preserved"
docker compose up -d --force-recreate app
REMOTE
```

**Nothing else in `.env` is touched.** The rewrite drops only lines starting
with `VAPID_PUBLIC_KEY=`, `VAPID_PRIVATE_KEY=` or `VAPID_SUBJECT=`; every other
line is copied through byte for byte. There is a timestamped `.env.bak.*`
either way.

Why the extra machinery, since this is "just adding three lines":

- **Existence check** — a wrong working directory would otherwise create a
  stray `.env` and leave the real one alone, with no error.
- **The line-count guard** — the file is rebuilt and swapped in, so a rewrite
  that truncated for any reason would replace the production secrets file with
  a short one. The check compares before and after and aborts rather than
  swapping.
- **Stripping before appending** — makes it safe to run twice. A second run
  replaces the keys instead of stacking a duplicate pair below the first, and
  the later duplicate would win silently.
- **`chmod 600`** — restores permissions after the swap. `.env` holds the
  service-role key.
- **`--force-recreate`** — Compose does not reliably notice an `env_file`
  change, and a container still running the old environment is
  indistinguishable from keys that did not work.

These are runtime variables (`env_file: .env` in `docker-compose.yml` injects
them into the container), which is why no rebuild is involved.

**If push stays off**, `POST /api/cron/push` now names the reason rather than
saying "not configured" for everything. The one worth knowing about:

```
VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are the wrong way round
```

The generator prints **Public Key first**, and the two are easy to transpose
because both are opaque base64. Telling them apart takes one glance: the
**public** key is **87 characters and starts with `B`**; the **private** key is
**43 characters**. If they are swapped, exchange the two values in `.env` and
recreate the container — nothing else needs doing.

**3. Check it worked.** Run the **Cron — Push notifications** workflow by hand
(Actions → the workflow → Run workflow). The response should no longer say
`skipped`. Then open the site on a phone, place any stake, and accept the
notification card that appears a few seconds after the confirmation.

**Do not regenerate the keys later.** Every subscription already handed out is
tied to that public key; a new pair silences every device until each person
next opens the app.

Users are asked for permission only after they have staked something, never on
page load — a browser permission denial is close to permanent, so an
unexplained prompt costs that person forever rather than costing one
notification. They can turn it off again on `/profile`.

---

# 3a. Migrations still to apply

Run these in the Supabase dashboard → **SQL Editor**, one at a time, **top to
bottom**. Order matters: each builds on the one above it.

| # | File | What it adds |
|---|---|---|
| 1 | `20260807050000_streaks.sql` | The six streaks and their claim ledger |
| 2 | `20260807060000_rewards_phone_and_socials.sql` | Phone + social follow bonuses |
| 3 | `20260807070000_notify_on_bet_settlement.sql` | "You won ₦X" when a locked-odds bet settles |
| 4 | `20260807080000_push_subscriptions.sql` | Phone-notification plumbing |
| 5 | `20260807090000_referral_streak.sql` | The referral streak (needs #1) |

Open each file from `supabase/migrations/`, paste the whole thing in, run it.

**Or run all five at once**, from the repo root, without opening anything:

```bash
psql "postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres" \
  -v ON_ERROR_STOP=1 --single-transaction \
  -f supabase/migrations/20260807050000_streaks.sql \
  -f supabase/migrations/20260807060000_rewards_phone_and_socials.sql \
  -f supabase/migrations/20260807070000_notify_on_bet_settlement.sql \
  -f supabase/migrations/20260807080000_push_subscriptions.sql \
  -f supabase/migrations/20260807090000_referral_streak.sql
```

The connection string is in Supabase → **Project Settings → Database →
Connection string → URI**. Use the **direct connection on port 5432**, not the
transaction pooler on 6543 — the pooler cannot hold one transaction across five
files.

The two flags are the whole safety story:

- `ON_ERROR_STOP=1` — stop at the first error instead of ploughing on through
  the remaining files. Without it psql reports the error and keeps going.
- `--single-transaction` — all five land, or none of them do. There is no
  half-applied state to unpick.

Silence and an exit code of 0 means it worked.

**All five are safe to run twice.** Every table, index and policy in them is
guarded, so if you are unsure whether one already went in, just run it — a
second run changes nothing. This has been verified, not assumed.

**#5 must come after #1** — it replaces a function that #1 creates. Running it
first fails with "function does not exist", which is loud and harmless, but
you'd then have to come back to it.

Anything numbered `20260806*` or below is already live.

---

# 3b. Bonus economics — what a signup costs us

Everything below pays into **bonus_balance**, which is stake-only and subject
to rollover. It is not cash out the door, but it is a real liability and it is
worth knowing the ceiling.

| Source | Pays | Verifiable? |
|---|---|---|
| Phone number | **₦0** — collected, not rewarded | n/a |
| 4 social follows | ₦100 each (₦400) | **No.** Nothing can check a follow; the handle is the entire audit trail |
| Referral, per head | ₦200 to each side | Yes — the referee is a real account with a real code |
| Streaks | ₦200–₦500 each, 6 of them | Yes — all read from recorded activity |

**Worst case for one determined new account: ₦400** — the four unverifiable
follows, and nothing else on this card.

**The phone reward is switched off.** It paid ₦200 on SMS verification, there
is no SMS provider, so the verification could never happen and the money could
never be paid — every claim was quietly booking a promise the product had no
way to keep. The number is still collected (account recovery and withdrawal
security both want it) and nothing is promised for it.

Turning it back on, if an SMS provider is ever added, is one number in
`reward_catalogue()`. The release path (`release_verified_phone_reward`) and
the OTP verify route that calls it were both left in place for exactly that.

## The referral streak, and the trap it avoids

`refer_3` pays ₦500 for three referred friends. **What counts is a friend who
has staked ₦1,000 of their own cash — not a friend who signed up.**

This matters more than it looks. A signup already pays ₦200 to each side, so a
milestone counting *signups* would make three burner accounts worth ₦1,700 in
bonus to one person in about four minutes. Requiring real cash through the book
means a fake account has to fund itself and risk money to be worth anything —
at which point it is a customer, which is what we were trying to buy.

Bonus credit is excluded from that ₦1,000 for the same reason: the signup bonus
must not be able to pay for the qualification it is being tested against.

To tune it, edit `c_qualifying_cash` in `get_streak_state`. Lowering it below
about ₦400 reopens the farm.

Streak claims are one row per `(user_id, streak_id, period_key)` in
`streak_claims` — that unique index is what makes claiming twice impossible, so
if you ever need to re-grant one, delete that row rather than crediting by hand.

---

# 3c. Clearing the auto-fetched backlog

The seed bot has been creating a market for every fixture across up to twelve
leagues since it was wired up (now three — see the league restriction below).
Most of that never drew a stake. `purge_unstaked_auto_fetched_markets()`
clears it, and it is deliberately narrow: it deletes an auto-fetched market
**only if nothing anywhere references it** — no bet, no Multiplier leg, no VIP
earning, no bet-insurance event, no on-chain commit.

**What it will NOT do, on purpose:** touch a market someone currently holds a
live position on. That fixture is still going to be played whether or not we
keep offering its league — the honest thing is to let it resolve and pay out
normally through the existing auto-resolve cron (see below), not to
unilaterally cancel a bet placed in good faith because of a business decision
that has nothing to do with whether the bet is good. Those are reported by
the function, never touched.

**Run it — dry run first, always:**

```sql
select * from purge_unstaked_auto_fetched_markets(true);   -- preview, changes nothing
select * from purge_unstaked_auto_fetched_markets(false);  -- the real thing
```

Three rows come back either way:

| phase | meaning |
|---|---|
| `sub-markets` | BTTS / Over-Under rows cleared first |
| `parents` | match-winner rows, cleared once every child under them is gone |
| `left in place — has real activity` | what survived, and why — `sample_ids` names up to 20 |

Safe to run more than once — a second pass reports zero candidates rather than
erroring. `fixture_id IS NOT NULL` is what "auto-fetched" means here: it is
the one column only the seed bot ever sets — the admin panel and the AI bulk
generator both leave it NULL, so nothing made by a human is ever a candidate.

## Auto-resolve and payout — already running, nothing to switch on

`cron-oracle-resolve.yml`, every 5 minutes, hits `/api/markets/resolve-due`.
For every locked sports market past its close time, it looks up the real
result (football via football-data.org then a team-name fallback; basketball
and tennis via API-Sports; esports via PandaScore) and, the moment it finds
one, resolves and pays out through the same path an admin's manual resolve
uses — same settlement math, same `settle_bet_outcome`, no separate code path
that could drift from what a human does by hand.

It does not distinguish by league — it always has covered every auto-fetched
market regardless of which of the (now three) leagues seeded it, and continues
to for anything already on the board under a scrapped league. A market it
cannot resolve retries every 5 minutes for up to 48 hours (576 attempts) before
it stops trying and raises an admin alert instead of retrying forever against
a result that will never come.

---

# 3d. Creating a market for the new hubs — Basketball, Tennis, Esports, Fight, BBN

Two separate creation forms exist because the two engines are separate
products underneath (see §1 and §2). Each had the same gap: nothing pointed
at the four newer hubs, so tagging a market for one meant hand-typing a sport
and hub code from memory with no validation — a typo produced a market that
saved fine and then showed up nowhere, silently.

**Locked Odds — `/admin` → Create Market.** A **"Show on a hub"** dropdown now
sits above the Sport tag / Hub tag fields, grouped by hub (Football, each of
Basketball / Tennis / Esports / Fight, Big Brother Naija). Picking an option
sets category, sport tag and hub tag together — correctly, including forcing
category to `entertainment` for BBN, which a free-text field could never
enforce and getting it wrong is exactly what makes a market invisible on its
hub. **Custom** at the top of the list leaves the two fields free-text, for
anything that doesn't fit one of these yet.

**Trading (Open Markets) — `/admin/open-markets/new`, or `/open/create` for a
user.** The **"Also feature on a hub"** picker now offers Basketball, Tennis,
Esports and Fight alongside BBN. Sets `event_tag`, which is the only thing
that decides whether a trading market shows up on that hub's page — the same
value the hub page itself matches on, so tagging it here is the whole job.

**One thing that changed underneath both hub pickers:** the four newer sport
hubs (`/basketball`, `/tennis`, `/esports`, `/fight`) previously only ever
showed Locked Odds markets — the trading engine had nothing wired up on the
display side at all. A market correctly `event_tag`'d for one of them would
have had nowhere to appear. They now show a **Trading** section exactly like
`/bbn` already did, so tagging a trading market for one of these hubs from
either creation form actually does something.

---

# 3e. Solo operator mode

Four-eyes assumes a second admin exists to hand a submission to. If you are
the only admin, that assumption is false, and the fix is not to quietly work
around the check — it is an explicit, visible, opt-in mode.

**Turn it on:** `/admin/open-markets/exposure` → **Solo operator mode**.
Needs your user ID typed in first (same box, same shared memory, as
submit/review/resolve).

**What it actually allows**, once on: the same person may submit *and*
approve, or resolve *and* confirm, a market — but **only a house market**
(blank creator). The moment a creator is attributed to a market (someone
earns 25% of its fees), solo mode changes nothing — that market still needs
a genuinely different person at every step, exactly as before. That is the
one guard this was never going to touch: self-approving something you also
profit from is the insider-trading hole the whole submitted_by mechanism
exists to close.

**What it never touches, under any setting:** whoever created or submitted a
market still cannot trade it. That protects other people's money from an
informed insider — it has nothing to do with how many admins exist.

**Every use is stamped, not hidden.** A market you submit-and-approve alone
shows a **"self-reviewed"** badge on the resolve screen. Its `self_resolved`
column is set the same way if you also resolve-and-confirm it alone. Neither
looks like — or is stored as — genuine second-person oversight; a self-
resolved market's `resolution_confirmed_by` is left NULL rather than
duplicating your own id, so the database's own record says plainly that
nobody else confirmed it.

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

Not reversible either, and worth stating plainly: **nobody can trade a market
they submitted.** If you want to take a position on something, get a colleague
to put it up. That is not bureaucracy — an admin who can submit, approve,
trade and resolve the same market is running an insider desk, and no amount of
good intent makes the audit trail say otherwise.

Reversible: pausing the engine, halting a market, sending back for revision,
rejecting, and changing the fleet cap.

---

# 6. First live market — suggested order

**You need two accounts.** Not a limitation to work around — it is the
control working. Whoever submits a market cannot approve, trade or resolve it.

- **Admin A** submits. A is then locked out of this market entirely.
- **Admins B and C** resolve it — resolution always needs two distinct people,
  and neither may be A.
- **Any ordinary account** (not A) does the trading.

1. As **A**: `/admin/open-markets/new`. Creator blank for a house market.
2. As **B**: approve at Starter tier, close time a few hours out.
3. As **an ordinary user**: open it from `/open`, buy ₦500 of one side.
4. Check `/open/portfolio` shows the position.
5. Sell half — you get back less than you paid. That is the fee twice plus
   your own price impact, and it is correct, not a bug.
6. As **B**: close trading → resolve, confirmer **C** → preview → apply.
7. "Release payouts now" rather than waiting out the dispute window.
8. Confirm the wallet moved and `/admin/open-markets/exposure` is clean.

Do this once end to end before any real user touches it.

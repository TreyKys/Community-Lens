# Social pipeline — X (Twitter)

How Opinions.ng posts and replies on X without a social media manager
and without a subscription.

---

## 0. The constraint everything is shaped around

X retired its free/Basic/Pro tiers for new developers in **February
2026** and moved to metered pay-per-use. There is no free tier. There is
also no $200 flat rate to buy your way out of thinking about it.

| Operation | Cost |
| :--- | :--- |
| Create a post | **$0.015** |
| Create a post **containing a link** | **$0.200** |
| Read a post | **$0.005** |
| User lookup | $0.001 |

Two facts follow, and they explain most of the design:

**A link costs 13.3x.** A post with a URL is $0.20. Four link-posts a
day is $24/month — nearly four times the whole budget. So the API never
posts links. The brand travels in the image instead: every card has
`OPINIONS.NG` burned into the pixels. When you want a link on a post,
you add it as a manual reply from your phone, which costs nothing.
X suppresses outbound links in-timeline anyway, so link-in-reply is what
you would want even if it were free.

**Reads are now possible.** Under the old free tier you got ~50 reads a
day and no search — you genuinely could not watch a timeline, and any
"listen to an X List" plan was dead on arrival. Metered reads at $0.005
revive that. This is the single best thing about the new pricing for a
small account.

**Budget:** $5.00/month funded, guard set to $4.50.

With reply discovery moved to share-to-bot (section 2a), reads drop to
zero and the whole budget goes to posting:

```
3 posts/day, link-free  =  90 x $0.015  =  $1.35/month
reply drafting          =  Gemini only  =  $0
reply posting           =  manual       =  $0
                                           ─────────────
                                           $1.35/month
```

The remaining headroom is deliberate. The ledger is an *estimate* built
from X's published rate card, not a copy of their billing — the guard is
set below what is funded so it stops first, cleanly, rather than X's
credits running dry mid-post.

For reference, with the metered scanner switched on instead, the same
$5 supports roughly 110 posts/month and six watched accounts.

---

## 1. What runs, and when

| Workflow | Schedule (UTC) | Route | Costs |
| :--- | :--- | :--- | :--- |
| `cron-social-plan.yml` | 05:00 daily | `POST /api/social/plan` | Gemini only |
| `cron-social-publish.yml` | hourly | `POST /api/social/publish` | $0.015/post |
| `cron-social-scan.yml` | **disabled** (manual only) | `POST /api/social/scan` | $0.005/read |

Same pattern as the existing crons: GitHub Actions → authenticated Next
route, `x-cron-secret` header, `API_BASE_URL` + `CRON_SECRET` secrets
already configured. No new infrastructure, no new hosting bill, nothing
new to keep alive on the AWS box.

### The planner (free)

Runs once a day at 05:00 UTC. Loads open markets closing soonest, and
for each one asks Gemini for a post, then queues it against one of four
slots:

```
07:00 UTC = 08:00 WAT   morning commute
12:00 UTC = 13:00 WAT   lunch
17:00 UTC = 18:00 WAT   close of work, pre-kickoff
20:00 UTC = 21:00 WAT   peak evening scroll
```

Four slots, not ten. An account this size posting ten times a day is
posting into a void and shedding the followers it has — reach comes from
replies, not from volume on the brand account.

Content is **derived from live markets**, never batched in advance. A
market closing in six hours is a better post than one closing in six
days, and a post generated the morning it publishes cannot be made
embarrassing by an injury the day before.

If there aren't enough live markets, it fills from a pool of six
evergreen posts. Those recycle least-recently-used — they are the floor
that stops a dead fixture day being silent, not the engine.

### The publisher ($0.015/post)

Hourly. Publishes what's due, max 2 per run.

- **Claims rows before posting** — a compare-and-set on `status`, so two
  overlapping cron runs can't double-post.
- **Skips anything >3h past its slot** — publishing yesterday's "closes
  in 2 hours" post is worse than not publishing.
- **Stops entirely on a budget refusal** rather than grinding the queue.
- **Refuses any body containing a link**, at three layers: the composer
  strips them, `postToX` throws, and a database CHECK constraint rejects
  the row. Three layers because it's a 13.3x mistake that would repeat
  daily before anyone noticed.
- Uploads the market card first; if that fails it posts text-only rather
  than missing the slot.

### The scanner ($0.005/read)

Twice a day. Reads monitored accounts, drafts a reply to anything new,
pushes each draft to Telegram.

Cost discipline, because this is the greedy side:

- `since_id` means an account with nothing new **bills nothing** — the
  reservation is refunded.
- `poll_weight` samples the long tail (1 = every scan, 3 = roughly every
  third).
- Hard ceiling per run (`SOCIAL_MAX_READS_PER_RUN`, default 15).
- **Stops at 65% of the monthly budget**, so publishing always keeps its
  reserve. Posts are the commitment; replies are upside.

One reply per account per scan. Replying to five posts from the same
person in a row reads as a bot no matter how good the copy is.

---

## 2a. Reply discovery: share-to-bot

**The scanner is off by default.** `cron-social-scan.yml` has no
schedule — manual trigger only.

Reads are the expensive half. Each billable target poll costs $0.025
(X's 5-result floor on the timeline endpoint), so two scans a day across
six accounts is ~$3.65/month. On a $5 budget that is most of the money,
spent on discovery.

Instead: **you share a post to the bot.**

```
You see a post worth replying to  →  share/paste it into Telegram
                                     ↓
                    Bot drafts a reply, free
                                     ↓
                    Tap to copy → paste in the X app
```

Three ways to send one, cheapest first:

1. **Link + the text pasted underneath** — costs nothing, always works.
2. **Link alone** — the bot tries oEmbed (public, unauthenticated,
   free). Whether that endpoint still works is genuinely uncertain; X
   has been closing these doors for years, so it is attempted, never
   relied on.
3. **Link alone, oEmbed failed** — the bot asks you to paste the text.
   It does *not* silently fall back to a billed read. `/paidlookup on`
   allows a $0.005 API read per share if you'd rather not paste.

Raw text with no link works too — it gets a synthetic `text:<hash>` id,
so an accidental double-paste dedupes instead of drafting twice.

What this trades: discovery is manual. What it buys: the whole budget
goes to posts (~333/month at $0.015 rather than ~110 with scanning on),
no scraping, no burner accounts, and you are not limited to a fixed list
of six accounts — anything you see is fair game.

The scanner is kept, not deleted. If the budget grows, restore the
schedule in `cron-social-scan.yml` and set `social_targets.active = true`.

---

## 2a-bis. Writing posts: you brief, it drafts

The planner writes posts ABOUT markets, ranked by which closes soonest.
On a real morning that surfaced Dutch second-division fixtures whose
auto-seeded titles were barely English, with no pool data to quote —
and the model, given nothing to say, echoed the title back:

```
"Cambuur vs Excelsior (DED)"
"Cambuur vs Excelsior (BTTS): will both"
```

No prompt fixes that. The subject was wrong, not the wording. So the
operator picks the subject instead:

```
/draft 4 BBN posts
/draft 3 posts about the Super Eagles squad
/draft something about the naira this week
```

Four cards come back, one per message, each with **Queue** / **Discard**.
Tap Queue and it takes the next free slot; tap Discard and it's gone.
Picking two of four is two taps.

**The site is optional context, not the driver.** Up to eight live
markets are offered to the model, explicitly marked "use ONLY if the
brief genuinely relates" — so a BBN post never ends up quoting a
Portuguese fixture. Markets with real money on them are offered first,
since a market nobody has bet on has no number worth repeating.

Drafts are safe by construction: `status = 'draft'` is outside the
publisher's query entirely, so one cannot publish by accident whatever
its schedule says. Undecided drafts are retired after 36 hours — a
brief written for Tuesday's news is worthless by Thursday, and a
`/drafts` list that keeps growing stops being reviewable, which is how a
bad post eventually gets approved by a tired thumb.

The market-driven planner still runs. It is now the floor, not the
engine.

---

## 2b. Control surface

Everything below is reachable from Telegram, with no deploy and no SSH.
The pipeline spends money on a schedule with nobody watching, so "stop
it" has to be thirty seconds away.

| Command | What it does |
| :--- | :--- |
| `/draft <brief>` | Write posts from your own brief; pick with buttons |
| `/drafts` | Re-send drafts still awaiting a decision |
| `/status` | Paused or live, queue depth, published in 24h, spend |
| `/queue` | The next posts due, with ids |
| `/budget` | Spend bar, and how many posts the remainder buys |
| `/pause [reason]` | **Kill switch.** Stops publishing on the next run |
| `/resume` | Start again |
| `/cap N` | Posts per day, 0-20. `/cap off` clears the override |
| `/skip ID` | Cancel one queued post |
| `/paidlookup on\|off` | Allow a $0.005 read when a share can't be read free |
| `/help` | The list |

Two properties worth knowing:

**`/pause` is checked before anything is claimed**, so it stops the next
hourly run cleanly and leaves the queue exactly as it was. Nothing is
lost; `/resume` picks up where it stopped.

**Settings fail closed.** If the settings row can't be read, publishing
reads as paused. An unattended job that spends money should not decide
on its own that everything is probably fine when it cannot check.

Commands are accepted only from `TELEGRAM_CHAT_ID`. Telegram delivers
every message the bot can see and bot usernames are guessable — without
that check, a stranger who found it could pause your publishing or burn
budget on paid lookups.

---

## 2c. Why replies are not automated

They could be — $0.015 each now. They aren't, for three reasons in
descending order of importance.

**Cost.** 40 replies/day is $18/month, roughly 3x the entire budget. It
is by far the largest line item in any version of this system, and it's
the one thing that's genuinely free to do by hand.

**Distribution.** A natively-composed reply carries session signals an
API post doesn't, and API posts carry a source label. For the borrowed-
audience play that replies exist to serve, native wins.

**Liability.** This is a licensed financial product in Nigeria. An
AI-generated reply that reads as investment advice or a return promise
is an ARCON/gaming-board problem, not just a spam problem. A human
reading each one is the compliance control.

So Telegram sends you a card with the three things that actually take
time on a phone:

1. an **Open in X** button that deep-links to the post,
2. the draft in a `<code>` block — one tap to copy,
3. **Posted** / **Skip** buttons that close the loop for measurement.

You paste in the native app, tap Posted. The bottleneck was never
typing — it was finding the post and having a take. Those are what the
card removes.

**Realistic time: 20-30 minutes a day for 30-40 replies.** Not 5. At 6
seconds each you aren't a human in the loop, you're a rubber stamp with
extra latency — all of the risk, none of the judgment that justifies the
architecture.

`SOCIAL_REPLY_MODE=api` exists if you later decide the budget justifies
automated sending. Manual is the default and the recommendation.

---

## 3. The budget guard

Unattended cron on a metered API is how a bug becomes a bill. So every
billable call goes through `lib/social/budget.ts` first:

1. sum month-to-date spend from `social_spend`,
2. refuse if this call would cross the cap,
3. **write the ledger row before the call goes out.**

Writing first means a crash mid-flight over-counts rather than
under-counts. Over-counting costs a few posts at month end; under-
counting costs money, and only one of those is recoverable.

If the ledger can't be read, it **fails closed**. Not knowing what you've
spent and assuming it's fine is exactly how the bill happens.

`social_spend` is append-only — refunds are compensating negative rows,
never deletes — so month-to-date is always a plain `SUM` and the history
of what you thought you spent survives.

**Also set a spend cap in the X developer portal.** This module keeps you
away from that cap; the portal cap is what saves you if this module has
a bug. Belt and braces, on a system that spends real money unattended.

Check anytime: send `/budget` to your Telegram bot, or
`GET /api/social/status` with admin auth.

---

## 4. Compliance guards

Enforced in code, not left to the prompt, because prompts drift.

Blocked in **all** posts and replies:

- Any link (also a cost control)
- `guarantee`, `sure bet`, `can't lose`, `free money`, `risk-free`,
  `easy money`

Blocked in **replies** specifically:

- Any mention of Opinions.ng, "our platform", "sign up", "check it out"
  — self-promotion in someone else's mentions is what gets a reply
  ratioed
- Hashtags, entirely
- Filler openers (`Great point`, `Absolutely`, `This.`) — the tells that
  read as automated

The reply model is also told to emit `SKIP` on death, illness, tragedy,
crime, or active political conflict. A null draft is a normal outcome —
a quiet scan is a working scan.

Anything failing a guard is **dropped, not published**. A skipped slot is
always cheaper than a bad post from a financial product.

---

## 5. Files

```
supabase/migrations/
  20260804000000_social_pipeline.sql   tables, RLS lockdown, spend fn
  20260804010000_social_seed.sql       6 targets (inactive), 6 evergreens

packages/app/lib/social/
  cost.ts        rate card, link detection, link stripping
  budget.ts      the spend guard — reserve / refund / summary
  x.ts           X API v2 client, OAuth 1.0a signing
  compose.ts     markets → post copy
  reply.ts       someone else's post → draft reply
  telegram.ts    operator control surface

packages/app/app/api/social/
  plan/          daily queue build
  publish/       hourly publisher
  scan/          reply scanner
  telegram/      webhook for the button taps
  status/        admin health + spend
  card/[marketId]/  1200×675 odds card (next/og)

.github/workflows/
  cron-social-plan.yml  cron-social-publish.yml  cron-social-scan.yml
```

---

## 6. Self-hosting adaptations

Three things Netlify used to handle that are ours now that the app runs
in one container on a 2 GB box.

**Renders are serialised.** An `ImageResponse` render is satori plus a
WASM rasteriser — a large, short-lived allocation. On Netlify each one
was its own lambda with its own memory. Now they share a heap with live
traffic, inside a container capped at 1200 MB, on hardware where
`next build` has already been OOM-killed once (commit `ccea9aa`).
Concurrent renders could cross the cap, kill the container, fail the
healthcheck, and get it pulled from Caddy's rotation — a share card
taking down a live money app. `lib/social/serialise.ts` queues them, so
that cannot happen regardless of how many unfurlers arrive at once. The
publisher fetches one card per post, so nothing queues in practice.

**Self-calls go over loopback.** The publisher fetches its own card
before posting. Using the public URL would route
container → NAT → internet → our own public IP → Caddy → TLS → back into
the same container. That is slow, breaks during the few seconds Caddy
restarts on deploy, and on AWS networks without hairpin NAT it does not
work at all — the request just hangs. `toInternalUrl()` rewrites our own
origin to `http://127.0.0.1:3000`; anything third-party is untouched.
Override with `INTERNAL_APP_URL` if the topology changes.

**Every outbound call has a deadline.** Netlify killed a hung function
at its execution cap; nothing does that now. A stalled fetch to Gemini
or X would hold a socket and its buffers long after curl and Caddy had
both given up — memory a 1200 MB container cannot spare. All outbound
calls go through `fetchWithTimeout` (20s default, 30s for the card
render, which is the slowest).

Caddy's `read_timeout`/`write_timeout` are already 300s for the
settlement crons, so the social crons' `--max-time 290` fits inside them
with no change needed.

---

## 7. Known limits

- **The odds card is the only creative.** Deliberate — it scales to
  infinite posts at zero design time. Video and multi-image are IG-phase
  work.
- **No engagement metrics.** Reading your own posts' likes/replies costs
  $0.005 each. At this budget, the X analytics tab is free and you have
  a phone.
- **Six targets is the real ceiling** on ₦10k. A seventh is a budget
  decision, not a config tweak.
- **`social_spend` estimates, it doesn't bill.** Reconcile against the
  developer portal monthly — if X changes rates, `lib/social/cost.ts` is
  the single place to update.
- **IG is not built.** The schema has a `channel` column and accepts
  `'ig'`; nothing consumes it yet.

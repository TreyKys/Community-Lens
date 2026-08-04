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

**Budget:** ₦10,000/month ≈ **$6.45** at ₦1,550/$.

```
4 posts/day, link-free    = 120 × $0.015 = $1.80/month
~6 targets × 2 scans/day  = roughly       $4.50/month
                                          ─────────────
                                          ~$6.30/month
```

It fits, but only just. Every knob that could blow it is capped in code.

---

## 1. What runs, and when

| Workflow | Schedule (UTC) | Route | Costs |
| :--- | :--- | :--- | :--- |
| `cron-social-plan.yml` | 05:00 daily | `POST /api/social/plan` | Gemini only |
| `cron-social-publish.yml` | hourly | `POST /api/social/publish` | $0.015/post |
| `cron-social-scan.yml` | 11:00, 17:30 | `POST /api/social/scan` | $0.005/read |

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

## 2. Why replies are not automated

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

## 6. Known limits

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

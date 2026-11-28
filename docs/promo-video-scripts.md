# Promo video scripts — The Run

Four concepts. Production notes assume generation in Antigravity with a female
Nigerian punter voiceover from Gemini TTS in AI Studio.

## The campaign card

Every figure in all four scripts comes from one illustration card, so the
numbers stay consistent across the campaign and nobody can catch us quoting
different prices in different ads.

**Five fixtures, each priced 2.10 / 3.40 / 3.20 (an 8.3% margin per fixture).
₦500 stake. Coefficient 0.2791.** All figures below are from the live pricing
engine, not estimates.

| result | pays |
|---|---|
| 0 of 5 | ₦18 |
| 1 of 5 | ₦47 |
| 2 of 5 | ₦124 |
| 3 of 5 | ₦547 |
| 4 of 5 | **₦1,444** |
| 5 of 5 | **₦5,614** |

Cash-out, mid-card, same stake:

| state | cash-out |
|---|---|
| 1 won, 4 to play | ₦669 |
| 2 won, 3 to play | ₦1,100 |
| 3 won, 2 to play | ₦1,811 |
| 4 won, 1 to play | ₦3,015 |

Because every fixture on this card carries the same price, each rung is a single
number rather than a range. That is the only reason to use an even card for the
ads — on a real mixed card "4 of 5" is a range, and a range does not fit in a
3-second shot.

---

## One production rule for all four

**Never let a generative video model render the numbers, the slip, or any UI.**
Video models mangle text — digits wander, a ₦ turns into an N halfway through a
shot. On a money product that reads as fake, and one wrong digit undoes the ad.

Split every concept into two layers:

- **Layer A — motion graphics or real screen capture.** Anything with a number,
  a slip, a price, a counter, app chrome. Built, not generated.
- **Layer B — generated video.** Human and atmosphere only: hands, faces, a
  phone held in a danfo, a viewing centre, a street at night. No text in frame,
  ever.

Layer B carries the feeling, Layer A carries the facts. Cut between them.

---

# CONCEPT 1 — "Your ticket doesn't die here"

**50s · 9:16 · Core idea: articulate the grievance before selling anything.**

The strongest of the four, because it isn't a claim — it's a memory. Every
punter in Nigeria has had four legs land and one betray them. We don't have to
convince anyone that hurts. We only have to show that here, it doesn't.

## Voiceover

Delivered like someone telling a friend what happened to her, not like an
advert. Dry and a little tired at the start. The turn comes at 0:22.

| time | VO | delivery |
|---|---|---|
| 0:02 | "Four correct." | flat, resigned |
| 0:04 | "One wrong." | shorter pause than feels natural |
| 0:08 | "And the one that spoiled it was the one I was surest about." | slight bitter laugh |
| 0:14 | "Four out of five." | |
| 0:16 | "Zero naira." | let it land. no inflection. |
| 0:22 | "Same five matches. Same one wrong." | lift — curiosity, not hype |
| 0:28 | "On The Run, that same ticket pays one thousand, four hundred and forty-four naira." | even, almost disbelieving |
| 0:35 | "Because here, every match you call right still counts. One bad leg doesn't kill the whole thing." | warm, conspiratorial |
| 0:43 | "Five matches. One stake. Your ticket doesn't die." | firm — close it |
| 0:47 | "Opinions dot N-G." | drop to nothing |

**TTS notes.** Prompt for *Nigerian English, female, late twenties,
conversational, slightly dry*. Spell money out in words in the prompt — TTS
reads `₦1,444` as "N one four four four" otherwise. Put explicit pause markers
where the table shows a landing beat; a comma is not enough at 0:16.

## Shot list

| # | time | layer | content | sound |
|---|---|---|---|---|
| 1 | 0:00–0:02 | B | Extreme close-up, thumb hovering over a phone screen (screen not legible). Dim room, blue light on skin. | room tone only. no music. |
| 2 | 0:02–0:14 | A | A betslip, five selections. Ticks land one at a time on 1, 2, 3, 4 — each a soft confirm chime, rising in pitch. | 4 ascending chimes |
| 3 | 0:14–0:16 | A | Fifth selection resolves red. Slip desaturates to grey. Stamp: **LOST**. Below: **₦0.00** | one dull low thud. music cuts dead. |
| 4 | 0:16–0:22 | A+B | Hold on **₦0.00** for a full three seconds — uncomfortably long. Then one cutaway: a face turning away from the phone, no expression. | literal silence |
| 5 | 0:22–0:26 | A | The grey slip re-ignites. The same five fixtures slide back in, amber, rebuilding as a Run card. | single rising synth swell |
| 6 | 0:26–0:30 | A | Four legs amber with ticks, one red with a cross. A counter spins up from 0 and settles on **₦1,444** | counter ticking, bright confirm hit on landing |
| 7 | 0:30–0:35 | A | Split screen, hard line down the middle. Left: **BOOKING CODE — ₦0**. Right: **THE RUN — ₦1,444** | low bass note under the reveal |
| 8 | 0:35–0:43 | A | The full ladder animates in, one rung per beat: 1 → ₦47 · 2 → ₦124 · 3 → ₦547 · 4 → ₦1,444 · 5 → **₦5,614**. Hard cut per rung, pitch rising. | 5 rising steps, last lands heavy |
| 9 | 0:43–0:47 | B | A hand pocketing a phone, walking out into a lit Lagos street at dusk, shot from behind. No text. | music opens up, warm |
| 10 | 0:47–0:50 | A | Logo. **Opinions.ng** · beneath, small: *Five matches. One stake. Your ticket doesn't die.* | resolves and stops cleanly |

## Generation prompts (Layer B only)

**Shot 1** — "Extreme macro close-up of a dark-skinned thumb hovering just above
a smartphone screen in a dim room, cool blue screen light reflecting on the
skin, shallow depth of field, screen content not visible or legible, cinematic,
9:16 vertical, handheld micro-movement."

**Shot 4 cutaway** — "Close-up profile of a young Nigerian woman in a dim room
turning her face away from a phone, flat neutral expression, no emotion
performed, lit only by the phone's glow, cinematic, 9:16 vertical."

**Shot 9** — "Behind-the-shoulder shot of a young Nigerian woman slipping a
phone into her jacket pocket and walking away down a lit Lagos street at dusk,
warm streetlights and shop-sign bokeh behind her, no readable text or signage,
handheld, cinematic, 9:16 vertical."

## Why it works

The first sixteen seconds sell nothing. They reconstruct a loss the viewer has
lived, then hold on the zero long enough to be uncomfortable. **Shot 4 is the
whole ad, and the instinct will be to trim it. Don't.** The silence is what
makes the turn at 0:22 land. The product isn't introduced as a product — it's
introduced as the answer to a sentence the viewer finished in their own head.

Shot 8 matters for a different reason. Showing ₦47 for one correct is not a
weakness, it's the proof. An ad that shows only the ₦5,614 reads as a lottery.
One that shows the small numbers too reads as a real price list.

---

# CONCEPT 2 — "You don't have to wait till Sunday"

**45s · Core idea: cash-out, which nothing else in the market offers on a
multi-week accumulator.**

## Voiceover

| time | VO | delivery |
|---|---|---|
| 0:03 | "Normally you put your money down, and then you just… wait." | mild exasperation |
| 0:08 | "Wait for Saturday. Wait for the late kickoff. Wait to find out if you wasted it." | three beats, each shorter |
| 0:15 | "Not here." | clean, flat |
| 0:18 | "One match in — you're up. Six hundred and sixty-nine." | |
| 0:23 | "Two in — one thousand, one hundred." | |
| 0:27 | "Three in — one thousand, eight hundred." | |
| 0:31 | "And any day you want, you can just take it." | drop in, almost casual |
| 0:36 | "You don't have to see it to the end. You can walk away while you're winning." | the key line. slow it down. |
| 0:42 | "The Run. On Opinions dot N-G." | |

## Shot list

| # | time | layer | content | sound |
|---|---|---|---|---|
| 1 | 0:00–0:03 | B | A wall clock in a quiet room, second hand moving. | isolated, loud tick |
| 2 | 0:03–0:15 | A | A static position card: **₦500 staked · 0 of 5 played**. Day stamps cross it one by one — MON, TUE, WED — nothing changing. | tick continues, becoming oppressive |
| 3 | 0:15–0:17 | A | Hard cut. The card flips to amber. | tick stops abruptly |
| 4 | 0:17–0:31 | A | The position climbs as fixtures land: **₦669** → **₦1,100** → **₦1,811**. The number morphs, never cuts. | one continuous rising tone |
| 5 | 0:31–0:36 | A+B | A **Cash out ₦1,811** button pulses. Cut to a thumb descending toward a screen, stopping just short. Cut back. Still pulsing. | heartbeat underneath |
| 6 | 0:36–0:42 | A | The thumb lands. **₦1,811 added to your balance.** Then, quietly, the two unplayed fixtures fade out — unresolved, and now irrelevant. | satisfying confirm, then release |
| 7 | 0:42–0:45 | A | Logo. *Take it whenever you want.* | |

The unplayed fixtures fading in shot 6 is the subtle sell: you left before the
end, and it didn't matter.

---

# CONCEPT 3 — "The ladder"

**30s · Core idea: pure data, no story. The credibility piece.**

Runs as the follow-up to Concept 1, for people already curious. Shorter and
faster on purpose — this is for the second impression, not the first.

## Voiceover

| time | VO | delivery |
|---|---|---|
| 0:02 | "Five matches. Win, draw or lose. One stake — five hundred naira." | brisk, factual |
| 0:09 | "Get one right, you still get something back. Forty-seven naira." | matter-of-fact, no apology |
| 0:13 | "Two — a hundred and twenty-four." | |
| 0:16 | "Three, and you're ahead. Five hundred and forty-seven." | |
| 0:20 | "Four. One thousand, four hundred and forty-four." | lift |
| 0:24 | "And all five…" | hold |
| 0:26 | "Five thousand, six hundred and fourteen naira." | land it hard |
| 0:29 | "The Run. Opinions dot N-G." | |

## Shot list

One unbroken composition — a vertical column, one rung revealed per beat. No
cutaways at all. The restraint is the point.

| rung | on screen | timing | sound |
|---|---|---|---|
| 1 of 5 | ₦47 | 0:09 | step 1, low |
| 2 of 5 | ₦124 | 0:13 | step 2 |
| 3 of 5 | ₦547 | 0:16 | step 3 — a faint *break even* marker line draws in here |
| 4 of 5 | ₦1,444 | 0:20 | step 4 |
| 5 of 5 | **₦5,614** | 0:26 | step 5 — everything else drops out, only this remains |

Hard cut per step, a semitone up each time. On the final rung kill the music
entirely for half a second before the logo — silence makes the number feel
larger than a cymbal would.

Show the small numbers. An ad that hides them is a lottery ad; one that shows
them is a price list, and the price list is what makes the ₦5,614 believable.

---

# CONCEPT 4 — "₦500"

**35s · Core idea: attack the deposit-size fear head-on.**

The churn problem isn't that people don't want to play — it's that they think
they need real money to start. So the hook is the stake, not the prize.

## Voiceover

| time | VO | delivery |
|---|---|---|
| 0:02 | "Five hundred naira." | just the fact |
| 0:05 | "Not a booking code. Not a parlay where one miss kills everything." | |
| 0:12 | "Five matches. You say win, draw or lose on each one." | |
| 0:18 | "Call all five — five thousand, six hundred and fourteen." | |
| 0:22 | "Call four — one thousand, four hundred and forty-four." | |
| 0:26 | "Call two, you still get something back. It's small. But it's there." | honest, not apologetic |
| 0:31 | "Five hundred naira. The Run, on Opinions dot N-G." | |

## Shot list

| # | time | layer | content |
|---|---|---|---|
| 1 | 0:00–0:05 | B | A single ₦500 note held between two fingers against a plain wall. Nothing else in frame. |
| 2 | 0:05–0:12 | A | The note dissolves into five fixture rows. |
| 3 | 0:12–0:18 | A | W / D / L chips tapped in sequence, one per fixture, each with a tactile click. |
| 4 | 0:18–0:30 | A | Three outcome cards, same size, same treatment: **ALL FIVE ₦5,614** / **FOUR ₦1,444** / **TWO ₦124** |
| 5 | 0:30–0:35 | A | The ₦500 note returns. Logo over it. |

The ₦124 card in shot 4 must be the same size as the ₦5,614 card, not shrunk
away. Including the unimpressive number at full size is what separates this from
every other betting ad, and it's what makes the rest believable.

---

# Sequencing

Post **Concept 1 first and alone.** Give it a week. It's the only one of the
four that works on someone who has never heard of us, because it leads with a
feeling they already have rather than a product they don't.

Then **Concept 3** for the people who engaged — it answers "fine, but what does
it actually pay". **Concept 4** third, aimed at the ones who looked and didn't
deposit. **Concept 2** last: cash-out is a feature you appreciate after you've
played once, not before.

---

# Compliance notes

- Every figure here is live-engine accurate on the stated card. If the card
  settings change, these numbers change — re-run them before reusing a script.
- Each ad shows at least one losing outcome at full prominence. Keep that. It is
  both the honest thing and the thing that makes the big number credible.
- Don't imply a typical outcome. On an even card like this one, roughly half of
  five-pick tickets land at two or fewer. The ladder shots carry that
  implicitly; no script should state or imply that 4 of 5 is normal.

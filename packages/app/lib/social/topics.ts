// The fixed subjects the digest writes about, four times a day.
//
// /draft lets the operator pick a subject on demand. The digest cron
// has nobody to ask, so the subjects live here instead — chosen once
// (BBN, football, the site's own markets), not re-derived from
// whatever happens to be open in the markets table. That was the
// entire lesson of the original planner: ranking open markets by
// closing time surfaced Dutch second-division fixtures nobody could
// write about. A fixed, deliberately-chosen list does not have that
// failure mode.
//
// `countPerRun` × 4 runs/day is the volume lever. At 4+4 = 8 topic
// posts a run, plus MARKET_POSTS_PER_RUN below, four runs a day lands
// close to the ~50/day target without every burst being enormous.

export type DigestTopic = {
  /** Short label — the card kicker and the digest summary line. */
  label: string;
  /** The actual brief handed to draftFromBrief / researchBrief. */
  brief: string;
  countPerRun: number;
};

// The briefs deliberately name the current calendar window and the
// exact competitions/season we care about. Without an explicit anchor
// the model happily writes from training-data memories — that is how
// "Ten Hag under pressure" and "Poch's head" cards end up on a card in
// 2026, years after either was true. Research is what enforces this at
// runtime; the brief is what tells the search what to look for.
export const DIGEST_TOPICS: DigestTopic[] = [
  {
    label: 'BBN',
    brief:
      'Big Brother Naija (BBNaija) — this week in the CURRENT ongoing season only. ' +
      'Housemates, evictions, arguments, alliances, tasks, twists that happened in the last few days. ' +
      'Nothing from prior seasons. If nothing has happened in the current season this week, return NOTHING RECENT.',
    countPerRun: 4,
  },
  {
    label: 'Football',
    brief:
      'This week in football: the current Premier League season, the current UEFA Champions League ' +
      'and Europa League matchweek, La Liga, and live transfer news. Also the Super Eagles when they ' +
      "have a fixture or a squad-list story in the last 7 days. Do NOT include NPFL. Do NOT include " +
      'anything older than 7 days. Managers, results and fixtures must be current — if a manager left ' +
      'a club last season, do not write about them at that club.',
    countPerRun: 4,
  },
];

/** Market-driven posts to write per run, on top of the topics above. */
export const MARKET_POSTS_PER_RUN = 5;

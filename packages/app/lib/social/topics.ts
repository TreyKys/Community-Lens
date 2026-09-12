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

export const DIGEST_TOPICS: DigestTopic[] = [
  {
    label: 'BBN',
    brief:
      'Big Brother Naija — the current season: housemates, evictions, ' +
      'arguments, alliances, twists',
    countPerRun: 4,
  },
  {
    label: 'Football',
    brief:
      'Premier League, Champions League, the Super Eagles and NPFL — ' +
      'the latest fixtures, results and transfer talk',
    countPerRun: 4,
  },
];

/** Market-driven posts to write per run, on top of the topics above. */
export const MARKET_POSTS_PER_RUN = 5;

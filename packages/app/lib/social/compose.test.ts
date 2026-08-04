import { describe, it, expect } from 'vitest';
import { sanitisePost, violatesCompliance, sentimentFromPools } from './compose';
import { replyViolation } from './reply';

// The model is instructed not to do any of these things. It does them
// anyway, often enough that every one of these cases came from a real
// failure mode rather than imagination. These are the last gate before
// something goes out under the brand's name.

describe('sanitisePost', () => {
  it('strips markdown fences', () => {
    expect(sanitisePost('```\nArsenal at 47%.\n```')).toBe('Arsenal at 47%.');
    expect(sanitisePost('```text\nDraw money is moving.\n```')).toBe('Draw money is moving.');
  });

  it('strips a conversational preamble', () => {
    expect(sanitisePost("Here's a punchy post:\nArsenal at 47%.")).toBe('Arsenal at 47%.');
    expect(sanitisePost('Post: Draw money is moving.')).toBe('Draw money is moving.');
  });

  it('unwraps surrounding quotes only when both ends have them', () => {
    expect(sanitisePost('"Arsenal at 47%."')).toBe('Arsenal at 47%.');
    // A leading quote that is part of the copy must survive.
    expect(sanitisePost('"Bottle job" is doing heavy lifting here.'))
      .toBe('"Bottle job" is doing heavy lifting here.');
  });

  it('removes links even when the prompt forbade them', () => {
    expect(sanitisePost('Split is live at opinionsng.com now'))
      .not.toMatch(/opinionsng/);
  });

  it('truncates at a word boundary, never mid-word', () => {
    const long = 'Arsenal '.repeat(60);
    const out = sanitisePost(long);
    expect(out.length).toBeLessThanOrEqual(250);
    // Would end "Arsen" if we cut blindly at 250.
    expect(out.endsWith('Arsenal') || out.endsWith('Arsenal ')).toBe(true);
  });

  it('leaves a good post exactly as written', () => {
    const good = 'Arsenal at 47% and the number has not moved since the team sheet dropped.';
    expect(sanitisePost(good)).toBe(good);
  });
});

describe('violatesCompliance', () => {
  it('rejects guaranteed-return language', () => {
    // The regulatory line, not a style preference — this is a financial
    // product operating in Nigeria.
    expect(violatesCompliance('This is a guaranteed win')).toBeTruthy();
    expect(violatesCompliance('Basically a sure bet tonight')).toBeTruthy();
    expect(violatesCompliance('Free money on the Draw')).toBeTruthy();
    expect(violatesCompliance('Risk-free position here')).toBeTruthy();
  });

  it('rejects anything carrying a link', () => {
    expect(violatesCompliance('Full split on opinionsng.com')).toBeTruthy();
  });

  it('passes ordinary market commentary', () => {
    expect(violatesCompliance('Arsenal at 47%. Draw at 28%. The crowd is split.')).toBeNull();
  });
});

describe('replyViolation', () => {
  it('rejects self-promotion, which is what gets a reply ratioed', () => {
    expect(replyViolation('We have a market on this at Opinions.ng')).toBeTruthy();
    expect(replyViolation('Check it out on our platform')).toBeTruthy();
    expect(replyViolation('Sign up and see for yourself')).toBeTruthy();
  });

  it('rejects filler openers that read as automated', () => {
    expect(replyViolation('Great point, the midfield was the problem')).toBeTruthy();
    expect(replyViolation('Absolutely. Rice has been immense.')).toBeTruthy();
    expect(replyViolation('This. Every week.')).toBeTruthy();
  });

  it('rejects hashtags outright in replies', () => {
    expect(replyViolation('Rice has been immense #COYG')).toBeTruthy();
  });

  it('rejects an over-long reply', () => {
    expect(replyViolation('a'.repeat(241))).toBeTruthy();
  });

  it('passes a reply that adds something and sells nothing', () => {
    expect(replyViolation("Odegaard's been carrying that midfield since October and nobody says it."))
      .toBeNull();
  });
});

describe('sentimentFromPools', () => {
  const base = {
    id: 'm1', question: 'q', closes_at: new Date().toISOString(),
    home_team: null, away_team: null, sport: null, league_code: null, description: null,
  };

  it('combines seed and real money the way the market page does', () => {
    const pcts = sentimentFromPools({
      ...base,
      options: ['Home', 'Draw', 'Away'],
      seed_pool: { '0': 100, '1': 100, '2': 100 },
      pool_by_outcome: { '0': 300, '1': 0, '2': 0 },
    } as any);
    // 400 / 100 / 100 of 600
    expect(pcts).toEqual([67, 17, 17]);
  });

  it('returns null when there is no money at all, so we never quote a fake 0%', () => {
    expect(sentimentFromPools({
      ...base,
      options: ['Yes', 'No'],
      seed_pool: {},
      pool_by_outcome: {},
    } as any)).toBeNull();
  });

  it('ignores negative pool values rather than skewing the split', () => {
    const pcts = sentimentFromPools({
      ...base,
      options: ['Yes', 'No'],
      seed_pool: { '0': -50, '1': 100 },
      pool_by_outcome: { '0': 100, '1': 0 },
    } as any);
    expect(pcts).toEqual([50, 50]);
  });
});

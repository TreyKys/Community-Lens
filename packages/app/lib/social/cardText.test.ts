import { describe, it, expect } from 'vitest';
import { headlineFrom, kickerFrom, pillFor, headlineSize } from './cardText';

describe('headlineFrom', () => {
  it('uses a short post whole', () => {
    const s = 'Osimhen starts or the whole camp has questions to answer.';
    expect(headlineFrom(s)).toBe(s);
  });

  it('breaks on the last COMPLETE sentence rather than trailing off', () => {
    // Genuinely over the limit, so the sentence-break path runs. The
    // naive version cut at the last word and appended an ellipsis;
    // this must land on a full stop instead.
    const body =
      "BBN is back. Get ready for 70 days of 'ships', gbas gbos, and daily agenda. " +
      'The streets never rest when Biggie is watching and the timeline never sleeps either.';
    expect(body.length).toBeGreaterThan(150);

    const out = headlineFrom(body);
    expect(out).toBe(
      "BBN is back. Get ready for 70 days of 'ships', gbas gbos, and daily agenda.",
    );
    expect(out).not.toMatch(/…$/);
    expect(out).toMatch(/[.!?]$/);
  });

  it('keeps a post that is exactly at the limit intact', () => {
    const s = 'a'.repeat(150);
    expect(headlineFrom(s)).toBe(s);
  });

  it('does not truncate a post that is barely over the old limit', () => {
    // The production failure: 123 characters against a 120 limit. It
    // cut three characters of content and added an ellipsis, which is
    // a strictly worse card. The only sentence break sat at index 25,
    // too early to use.
    const body =
      'BBN or Naija Super Eagles? For some, the drama and loyalty in the house ' +
      'feels more real than national team games right now.';
    expect(body.length).toBeGreaterThan(120);
    const out = headlineFrom(body);
    expect(out).toBe(body);
    expect(out).not.toMatch(/…/);
  });

  it('falls back to a word-boundary ellipsis when there is no sentence break', () => {
    const body = 'word '.repeat(50).trim();  // 249 chars, no punctuation
    const out = headlineFrom(body);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(151);
    // Never a severed word.
    expect(out.slice(0, -1).trim().endsWith('word')).toBe(true);
  });

  it('ignores a sentence break that is too early to fill the card', () => {
    // "No." at index 2 is a valid sentence end but a card reading "No."
    // wastes the space, so the ellipsis path is preferred.
    const body = 'No. ' + 'x'.repeat(200);
    const out = headlineFrom(body);
    expect(out).not.toBe('No.');
  });

  it('collapses newlines and runs of whitespace', () => {
    expect(headlineFrom('Line one\n\n   Line two')).toBe('Line one Line two');
  });

  it('handles ! and ? as sentence ends', () => {
    const body = 'Who saw that coming? Nobody in the group chat did, and they will all claim otherwise by Friday afternoon anyway.';
    expect(headlineFrom(body + ' Extra sentence to push it over the limit here.'))
      .toMatch(/\?$|\.$/);
  });
});

describe('kickerFrom', () => {
  it('takes up to three words from the brief', () => {
    expect(kickerFrom('Super Eagles squad announcement', 'briefed')).toBe('SUPER EAGLES SQUAD');
  });

  it('uppercases a one-word brief', () => {
    expect(kickerFrom('BBN', 'briefed')).toBe('BBN');
  });

  it('strips punctuation the brief picked up', () => {
    expect(kickerFrom('the naira, this week', 'briefed')).toBe('THE NAIRA THIS');
  });

  it('caps at 24 characters so it cannot wrap', () => {
    expect(kickerFrom('extraordinarily lengthy subject', 'briefed').length).toBeLessThanOrEqual(24);
  });

  it('falls back by kind when there is no brief', () => {
    expect(kickerFrom(null, 'evergreen')).toBe('HOW IT WORKS');
    expect(kickerFrom(null, 'movement')).toBe('LINE MOVING');
    expect(kickerFrom(null, 'briefed')).toBe('OPINIONS');
  });

  it('does not return an empty kicker for a punctuation-only brief', () => {
    expect(kickerFrom('!!!', 'briefed')).toBe('OPINIONS');
  });
});

describe('pillFor', () => {
  it('claims a market ONLY when one backs the post', () => {
    // The correctness point: announcing an open market that does not
    // exist is a false claim on a regulated product's account.
    expect(pillFor('briefed', true)).toBe('MARKET OPEN');
    expect(pillFor('briefed', false)).toBe('CALL IT');
  });

  it('reflects the post kind when there is no market', () => {
    expect(pillFor('settlement', false)).toBe('SETTLED');
    expect(pillFor('movement', false)).toBe('LINE MOVING');
    expect(pillFor('evergreen', false)).toBe('HOW IT WORKS');
  });
});

describe('headlineSize', () => {
  it('shrinks as the line grows, so it never overflows the frame', () => {
    expect(headlineSize(20)).toBe(86);
    expect(headlineSize(60)).toBe(74);
    expect(headlineSize(90)).toBe(62);
    expect(headlineSize(115)).toBe(52);
    // The tier that makes a 150-character headline fit at all.
    expect(headlineSize(145)).toBe(44);
  });

  it('is monotonic — a longer line is never given bigger type', () => {
    for (let n = 1; n < 240; n++) {
      expect(headlineSize(n)).toBeLessThanOrEqual(headlineSize(n - 1));
    }
  });
});

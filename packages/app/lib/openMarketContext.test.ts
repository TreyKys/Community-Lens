import { describe, it, expect } from 'vitest';
import { parseContextItems, buildContextPrompt } from './openMarketContext';

// The prompt asks Gemini to write background on the market's SUBJECT and
// explicitly forbids anything that reads as a lean on the outcome — a real
// concern here, because this platform prices that outcome with real money.
// These tests hold two things: the parser survives the messy output an LLM
// actually returns, and it drops anything that slipped past the prompt's own
// "no probability" instruction.

describe('parseContextItems', () => {
  it('parses well-formed TITLE:/BODY: blocks', () => {
    const raw = `TITLE: Fuel pricing basics
BODY: Nigeria's pump price tracks a mix of the naira exchange rate and global crude benchmarks, adjusted periodically by regulators.

TITLE: Past adjustments
BODY: Price reviews have historically followed subsidy policy changes rather than a fixed schedule.`;

    const items = parseContextItems(raw);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Fuel pricing basics');
    expect(items[0].body).toContain('naira exchange rate');
  });

  it('drops a block containing a stray percentage — the exact thing the prompt forbids', () => {
    const raw = `TITLE: Likely outcome
BODY: There is roughly a 65% chance prices rise given current trends.

TITLE: Safe background
BODY: Pump prices in Nigeria are set through a mix of policy and import costs, reviewed periodically.`;

    const items = parseContextItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Safe background');
  });

  it('drops a block with a too-short body rather than padding it', () => {
    const raw = `TITLE: Too short
BODY: Not enough.

TITLE: Fine
BODY: This body is long enough to clear the minimum length the parser requires for a usable item.`;

    const items = parseContextItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Fine');
  });

  it('ignores commentary or preamble that never matches the TITLE:/BODY: shape', () => {
    const raw = `Sure, here are four background items:

TITLE: Real item
BODY: This is a normal, sufficiently long background sentence about the subject in general terms.`;

    const items = parseContextItems(raw);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Real item');
  });

  it('caps at 4 items even if the model returns more', () => {
    const block = (n: number) =>
      `TITLE: Item ${n}\nBODY: A sufficiently long generic background sentence number ${n} about the subject at hand.`;
    const raw = [1, 2, 3, 4, 5, 6].map(block).join('\n\n');

    const items = parseContextItems(raw);
    expect(items).toHaveLength(4);
  });

  it('returns nothing usable from pure noise', () => {
    expect(parseContextItems('I cannot help with that request.')).toEqual([]);
  });
});

describe('buildContextPrompt', () => {
  it('names the question and instructs against predicting the outcome', () => {
    const prompt = buildContextPrompt({
      question: 'Will fuel prices go up?',
      description: 'Think about fuel.',
      category: 'economy',
      resolutionSource: 'Global prices',
    });
    expect(prompt).toContain('Will fuel prices go up?');
    expect(prompt).toMatch(/never a guess|not a guess|which way it will go/i);
  });
});

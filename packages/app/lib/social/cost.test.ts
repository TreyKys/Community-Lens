import { describe, it, expect } from 'vitest';
import {
  containsLink,
  stripLinks,
  estimateCost,
  effectiveOperation,
  X_RATES,
} from './cost';

// These tests guard a money invariant, not a formatting preference.
//
// X bills $0.20 for a post containing a link and $0.015 for one without
// — 13.3x. At four posts a day, one leaked domain costs about $22 a
// month against a ~$6.50 budget. A false positive here costs a rewrite;
// a false negative costs the whole month. The asymmetry is why the
// matcher is deliberately greedy.

describe('containsLink', () => {
  it('catches explicit URLs', () => {
    expect(containsLink('read more at https://opinionsng.com/markets')).toBe(true);
    expect(containsLink('http://example.org')).toBe(true);
  });

  it('catches www-prefixed hosts without a scheme', () => {
    expect(containsLink('www.opinionsng.com has it')).toBe(true);
  });

  it('catches bare domains, which X autolinks and therefore bills', () => {
    // The expensive case: no scheme, no www, still a billable link.
    expect(containsLink('live now on opinionsng.com')).toBe(true);
    expect(containsLink('go to odds.ng')).toBe(true);
    expect(containsLink('see paystack.co for details')).toBe(true);
  });

  it('leaves ordinary copy alone', () => {
    expect(containsLink('Arsenal at 47% and the market has not moved.')).toBe(false);
    expect(containsLink('Chelsea vs Arsenal. 3pm. The split is brutal.')).toBe(false);
  });

  it('does not fire on decimals or ordinary punctuation', () => {
    expect(containsLink('odds moved from 2.15 to 1.90 in an hour')).toBe(false);
    expect(containsLink('47.5% of the pool sits on Draw')).toBe(false);
  });
});

describe('stripLinks', () => {
  it('removes the link and tidies the gap it leaves', () => {
    expect(stripLinks('Market is live https://opinionsng.com/m/12 right now'))
      .toBe('Market is live right now');
  });

  it('removes bare domains', () => {
    expect(stripLinks('Full split on opinionsng.com .')).toBe('Full split on.');
  });

  it('leaves clean copy untouched', () => {
    const clean = 'Arsenal 47%. Draw 28%. Chelsea 25%.';
    expect(stripLinks(clean)).toBe(clean);
  });

  it('produces output that no longer trips containsLink', () => {
    const dirty = 'Bet now at www.opinionsng.com or odds.ng today';
    expect(containsLink(stripLinks(dirty))).toBe(false);
  });
});

describe('effectiveOperation', () => {
  it('upgrades a post_create to the link rate when the body has a link', () => {
    expect(effectiveOperation('post_create', 'see opinionsng.com')).toBe('post_create_link');
  });

  it('leaves a clean post at the cheap rate', () => {
    expect(effectiveOperation('post_create', 'Arsenal at 47%.')).toBe('post_create');
  });

  it('does not touch reads', () => {
    expect(effectiveOperation('post_read')).toBe('post_read');
  });
});

describe('estimateCost', () => {
  it('prices a clean post at the base rate', () => {
    expect(estimateCost('post_create', 1, 'Arsenal at 47%.')).toBe(X_RATES.post_create);
  });

  it('prices a link post at 13.3x, so callers reserve enough', () => {
    const clean = estimateCost('post_create', 1, 'no link here');
    const linked = estimateCost('post_create', 1, 'go to opinionsng.com');
    expect(linked).toBe(X_RATES.post_create_link);
    expect(linked / clean).toBeCloseTo(13.33, 1);
  });

  it('scales reads by unit count', () => {
    expect(estimateCost('post_read', 40)).toBeCloseTo(0.2, 5);
  });

  it('keeps a realistic month inside a ~$6.50 budget', () => {
    // 4 clean posts/day + 3 scans/day of 40 reads, over 30 days.
    const posts = estimateCost('post_create', 4 * 30);
    const reads = estimateCost('post_read', 40 * 3 * 30);
    // Reads dominate — which is exactly why scan/route.ts caps them and
    // reserves a share of the budget for publishing.
    expect(posts).toBeCloseTo(1.8, 2);
    expect(reads).toBeCloseTo(18, 2);
    expect(posts + reads).toBeGreaterThan(6.5);
  });
});

import { describe, it, expect } from 'vitest';
import { spendableBonus, spendableBalance, bonusExpiryNote } from './bonus';

// The reported failure, first and by name: ₦5,000 on screen, "Insufficient
// balance" on every attempt. Everything else here exists so that particular
// shape of lie cannot come back.

const NOW = new Date('2026-08-25T12:00:00Z');
const hoursFromNow = (h: number) =>
  new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();

describe('spendableBonus', () => {
  it('is zero once the expiry has passed — the reported bug', () => {
    expect(spendableBonus(5000, hoursFromNow(-1), NOW)).toBe(0);
  });

  it('is the full amount while the expiry is still ahead', () => {
    expect(spendableBonus(5000, hoursFromNow(1), NOW)).toBe(5000);
  });

  it('treats the exact expiry instant as gone, matching the SQL (<= now)', () => {
    expect(spendableBonus(5000, NOW.toISOString(), NOW)).toBe(0);
  });

  it('keeps bonus that has no expiry at all', () => {
    // A legacy balance credited before the trigger existed has a NULL column.
    // The staking RPCs skip the expiry branch entirely for NULL, so treating
    // it as expired here would show someone less than they can actually spend.
    expect(spendableBonus(5000, null, NOW)).toBe(5000);
    expect(spendableBonus(5000, undefined, NOW)).toBe(5000);
  });

  it('keeps bonus when the stored date is unparseable', () => {
    // A data problem is not the user's problem, and the SQL comparison would
    // not have zeroed it either.
    expect(spendableBonus(5000, 'not-a-date', NOW)).toBe(5000);
  });

  it('handles nothing, null and negative without inventing money', () => {
    expect(spendableBonus(0, hoursFromNow(1), NOW)).toBe(0);
    expect(spendableBonus(null, hoursFromNow(1), NOW)).toBe(0);
    expect(spendableBonus(undefined, null, NOW)).toBe(0);
    expect(spendableBonus(-100, hoursFromNow(1), NOW)).toBe(0);
  });
});

describe('spendableBalance', () => {
  it('drops expired bonus but never touches cash', () => {
    // The exact situation in the screenshot: the engine sees ₦400, the old UI
    // showed ₦5,400, and a ₦1,000 stake was refused.
    expect(spendableBalance(400, 5000, hoursFromNow(-1), NOW)).toBe(400);
  });

  it('adds live bonus to cash', () => {
    expect(spendableBalance(400, 5000, hoursFromNow(24), NOW)).toBe(5400);
  });

  it('a ₦1,000 stake is refused on expired bonus and allowed on live bonus', () => {
    expect(spendableBalance(400, 5000, hoursFromNow(-1), NOW) >= 1000).toBe(false);
    expect(spendableBalance(400, 5000, hoursFromNow(1), NOW) >= 1000).toBe(true);
  });
});

describe('bonusExpiryNote', () => {
  it('says nothing when there is no bonus or no expiry', () => {
    expect(bonusExpiryNote(0, hoursFromNow(1), NOW)).toBeNull();
    expect(bonusExpiryNote(5000, null, NOW)).toBeNull();
  });

  it('stays quiet while the deadline is far off', () => {
    // A countdown on every screen forever is nagging, and nagging is ignored.
    expect(bonusExpiryNote(5000, hoursFromNow(24 * 6), NOW)).toBeNull();
  });

  it('speaks up as the deadline approaches', () => {
    expect(bonusExpiryNote(5000, hoursFromNow(24 * 3), NOW)).toBe('Expires in 3 days');
    expect(bonusExpiryNote(5000, hoursFromNow(25), NOW)).toBe('Expires in 1 day');
    expect(bonusExpiryNote(5000, hoursFromNow(5), NOW)).toBe('Expires in 5 hours');
    expect(bonusExpiryNote(5000, hoursFromNow(0.5), NOW)).toBe('Expires within the hour');
  });

  it('says Expired rather than going quiet once it has gone', () => {
    // Silence here would leave the balance unexplained, which is the whole
    // problem being fixed.
    expect(bonusExpiryNote(5000, hoursFromNow(-1), NOW)).toBe('Expired');
  });
});

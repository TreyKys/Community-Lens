import { describe, it, expect } from 'vitest';
import { safeEqual, safeSecretMatch } from './safeCompare';

// These guard the auth boundary: safeEqual replaced `===` on the admin and
// cron secrets. Correctness matters more than the timing property here — a
// hardening change that accidentally accepts a wrong secret (or rejects the
// right one and takes down every cron) is far worse than the timing leak.

describe('safeEqual', () => {
  it('accepts identical strings', () => {
    expect(safeEqual('s3cret', 's3cret')).toBe(true);
    expect(safeEqual('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('rejects differing strings', () => {
    expect(safeEqual('s3cret', 's3crey')).toBe(false);
    expect(safeEqual('s3cret', 's3cret ')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);   // differing lengths must not throw
    expect(safeEqual('abcd', 'abc')).toBe(false);
  });

  it('is case- and whitespace-sensitive', () => {
    expect(safeEqual('Secret', 'secret')).toBe(false);
    expect(safeEqual(' secret', 'secret')).toBe(false);
  });

  it('rejects empty strings — a missing env var must not authenticate', () => {
    expect(safeEqual('', '')).toBe(false);
    expect(safeEqual('', 'secret')).toBe(false);
    expect(safeEqual('secret', '')).toBe(false);
  });

  it('rejects null / undefined / non-string input without throwing', () => {
    expect(safeEqual(null, 'secret')).toBe(false);
    expect(safeEqual(undefined, 'secret')).toBe(false);
    expect(safeEqual('secret', null)).toBe(false);
    expect(safeEqual(null, null)).toBe(false);
    expect(safeEqual(undefined, undefined)).toBe(false);
  });

  it('handles long and unicode secrets', () => {
    const long = 'x'.repeat(4096);
    expect(safeEqual(long, long)).toBe(true);
    expect(safeEqual(long, long.slice(0, -1) + 'y')).toBe(false);
    expect(safeEqual('sécret—₦', 'sécret—₦')).toBe(true);
    expect(safeEqual('sécret—₦', 'secret-N')).toBe(false);
  });
});

describe('safeSecretMatch', () => {
  it('matches a provided header against the expected secret', () => {
    expect(safeSecretMatch('abc', 'abc')).toBe(true);
    expect(safeSecretMatch('abc', 'xyz')).toBe(false);
  });

  it('fails CLOSED when the expected secret is unset', () => {
    // The critical case: if CRON_SECRET is missing in the environment, an
    // attacker sending any header (or none) must still be rejected.
    expect(safeSecretMatch('anything', undefined)).toBe(false);
    expect(safeSecretMatch('anything', '')).toBe(false);
    expect(safeSecretMatch(undefined, undefined)).toBe(false);
    expect(safeSecretMatch(null, '')).toBe(false);
  });

  it('rejects a missing header when a secret IS configured', () => {
    expect(safeSecretMatch(null, 'configured')).toBe(false);
    expect(safeSecretMatch(undefined, 'configured')).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toInternalUrl, internalBaseUrl } from './selfCall';

// If this rewrite is wrong the failure is quiet: uploadMedia throws,
// the publisher catches it and posts text-only, and every post silently
// loses its card while the cron log still says "published". So the
// behaviour is pinned here rather than assumed.

const ORIGINAL = process.env.NEXT_PUBLIC_APP_URL;
const ORIGINAL_INTERNAL = process.env.INTERNAL_APP_URL;

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://opinionsng.com';
  delete process.env.INTERNAL_APP_URL;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL;
  if (ORIGINAL_INTERNAL === undefined) delete process.env.INTERNAL_APP_URL;
  else process.env.INTERNAL_APP_URL = ORIGINAL_INTERNAL;
});

describe('internalBaseUrl', () => {
  it('defaults to loopback on the app port', () => {
    expect(internalBaseUrl()).toBe('http://127.0.0.1:3000');
  });

  it('honours an override', () => {
    process.env.INTERNAL_APP_URL = 'http://app:3000';
    expect(internalBaseUrl()).toBe('http://app:3000');
  });
});

describe('toInternalUrl', () => {
  it('rewrites our own public URL to loopback', () => {
    expect(toInternalUrl('https://opinionsng.com/api/social/card/m1'))
      .toBe('http://127.0.0.1:3000/api/social/card/m1');
  });

  it('preserves the query string, so ?theme= still works', () => {
    expect(toInternalUrl('https://opinionsng.com/api/social/card/m1?theme=violet'))
      .toBe('http://127.0.0.1:3000/api/social/card/m1?theme=violet');
  });

  it('leaves third-party URLs completely alone', () => {
    const external = 'https://pbs.twimg.com/media/abc.jpg';
    expect(toInternalUrl(external)).toBe(external);
  });

  it('does not rewrite a different host that merely shares a suffix', () => {
    // www redirects to the apex in Caddy, so it is genuinely a
    // different origin and must not be assumed to be us.
    const other = 'https://cdn.opinionsng.com/x.png';
    expect(toInternalUrl(other)).toBe(other);
  });

  it('returns the input unchanged when NEXT_PUBLIC_APP_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const u = 'https://opinionsng.com/api/social/card/m1';
    expect(toInternalUrl(u)).toBe(u);
  });

  it('does not throw on a malformed URL', () => {
    expect(toInternalUrl('not a url')).toBe('not a url');
  });
});

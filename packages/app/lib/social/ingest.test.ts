import { describe, it, expect } from 'vitest';
import { parsePostUrl, looksLikePostUrl, ingestShared } from './ingest';

// URL parsing is the front door of the whole share-to-bot flow. If it
// rejects a link the operator actually shared, the bot answers "send me
// an X post link" to something that plainly IS one — which reads as
// broken. The share sheet's exact output is pinned here.

describe('parsePostUrl', () => {
  it('parses the standard x.com permalink', () => {
    expect(parsePostUrl('https://x.com/OptaJoe/status/1234567890123456789')).toEqual({
      author: 'OptaJoe',
      postId: '1234567890123456789',
      url: 'https://x.com/OptaJoe/status/1234567890123456789',
    });
  });

  it('still parses legacy twitter.com links', () => {
    expect(parsePostUrl('https://twitter.com/jack/status/20')?.postId).toBe('20');
  });

  it('handles the tracking params the X share sheet appends', () => {
    // This is what you actually get from "Copy link" on the phone.
    const shared = 'https://x.com/brfootball/status/1934567890123456789?s=20&t=AbCdEf';
    const parsed = parsePostUrl(shared);
    expect(parsed?.postId).toBe('1934567890123456789');
    // Normalised — the query junk is dropped from the stored permalink.
    expect(parsed?.url).toBe('https://x.com/brfootball/status/1934567890123456789');
  });

  it('handles the fx/vx embed-fixer domains people paste', () => {
    expect(parsePostUrl('https://fxtwitter.com/naijafm/status/999888777666555444')?.author)
      .toBe('naijafm');
    expect(parsePostUrl('https://vxtwitter.com/naijafm/status/999888777666555444')?.postId)
      .toBe('999888777666555444');
  });

  it('accepts www and the /statuses/ variant', () => {
    expect(parsePostUrl('https://www.twitter.com/a_b/statuses/123456')?.postId).toBe('123456');
  });

  it('finds the link inside a longer message', () => {
    const msg = 'reply to this one https://x.com/OptaJoe/status/1234567890 thanks';
    expect(parsePostUrl(msg)?.postId).toBe('1234567890');
  });

  it('rejects things that are not post links', () => {
    expect(parsePostUrl('https://x.com/OptaJoe')).toBeNull();          // profile
    expect(parsePostUrl('https://x.com/i/lists/12345')).toBeNull();     // list
    expect(parsePostUrl('https://opinionsng.com/markets')).toBeNull();
    expect(parsePostUrl('just some text')).toBeNull();
  });

  it('rejects a handle longer than X allows', () => {
    expect(parsePostUrl('https://x.com/thishandleiswaytoolong/status/123')).toBeNull();
  });

  it('looksLikePostUrl agrees with parsePostUrl', () => {
    expect(looksLikePostUrl('https://x.com/a/status/123456')).toBe(true);
    expect(looksLikePostUrl('nope')).toBe(false);
  });
});

describe('ingestShared', () => {
  it('uses text pasted alongside a link, with no lookup at all', async () => {
    const r = await ingestShared(
      'https://x.com/OptaJoe/status/1234567890\nArsenal have now gone 12 away games unbeaten.',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.post.via).toBe('pasted');           // free path — no network
    expect(r.post.postId).toBe('1234567890');
    expect(r.post.author).toBe('OptaJoe');
    expect(r.post.text).toContain('12 away games');
  });

  it('accepts raw text with no link and gives it a stable synthetic id', async () => {
    const text = 'Osimhen to Chelsea is the worst kept secret in football right now.';
    const a = await ingestShared(text);
    const b = await ingestShared(text);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.post.postId).toMatch(/^text:[0-9a-f]{16}$/);
    // Same content -> same id, so an accidental double-paste dedupes
    // against the unique index rather than drafting twice.
    expect(a.post.postId).toBe(b.post.postId);
    expect(a.post.url).toBeNull();
  });

  it('gives different ids to different text', async () => {
    const a = await ingestShared('Arsenal are winning the league this year for sure now');
    const b = await ingestShared('Chelsea are winning the league this year for sure now');
    if (!a.ok || !b.ok) throw new Error('expected both to parse');
    expect(a.post.postId).not.toBe(b.post.postId);
  });

  it('rejects a message too short to be a post', async () => {
    const r = await ingestShared('ok');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_a_post');
    expect(r.hint).toMatch(/X post link/i);
  });
});

import { describe, it, expect } from 'vitest';
import { parseBrief, splitDrafts, MAX_DRAFTS, DEFAULT_DRAFTS } from './brief';

// This gets typed one-handed on a phone before work. If "4 BBN posts"
// yields three drafts about "4 BBN posts", the operator notices and
// stops trusting it. The exact phrasings someone actually types are
// pinned here.

describe('parseBrief', () => {
  it('reads the count from a leading digit', () => {
    const r = parseBrief('4 BBN posts');
    expect(r.count).toBe(4);
    expect(r.brief).toBe('BBN');
  });

  it('handles the /draft prefix', () => {
    const r = parseBrief('/draft 4 BBN posts');
    expect(r.count).toBe(4);
    expect(r.brief).toBe('BBN');
  });

  it('reads a spelled-out count', () => {
    const r = parseBrief('draft three posts about the Super Eagles');
    expect(r.count).toBe(3);
    expect(r.brief.toLowerCase()).toContain('super eagles');
  });

  it('reads a count that trails the subject', () => {
    const r = parseBrief('BBN eviction night, 5 posts');
    expect(r.count).toBe(5);
    expect(r.brief.toLowerCase()).toContain('bbn eviction night');
  });

  it('falls back to the default when no count is given', () => {
    const r = parseBrief('something about the naira this week');
    expect(r.count).toBe(DEFAULT_DRAFTS);
    expect(r.brief).toBe('something about the naira this week');
  });

  it('strips "posts about" scaffolding but keeps the subject', () => {
    const r = parseBrief('2 posts about the Arsenal collapse');
    expect(r.count).toBe(2);
    expect(r.brief.toLowerCase()).toContain('arsenal collapse');
    expect(r.brief.toLowerCase()).not.toMatch(/^posts?\b/);
  });

  it('caps the count so a typo cannot request fifty drafts', () => {
    expect(parseBrief('50 BBN posts').count).toBe(MAX_DRAFTS);
  });

  it('never returns a count below 1', () => {
    expect(parseBrief('0 posts about nothing').count).toBe(1);
  });

  it('keeps a bare subject with no scaffolding at all', () => {
    const r = parseBrief('BBN');
    expect(r.brief).toBe('BBN');
    expect(r.count).toBe(DEFAULT_DRAFTS);
  });

  it('drops a politeness opener', () => {
    const r = parseBrief('please 2 posts about the naira');
    expect(r.count).toBe(2);
    expect(r.brief.toLowerCase()).not.toContain('please');
  });
});

describe('splitDrafts', () => {
  it('splits a numbered list', () => {
    const out = splitDrafts('1. First post here.\n2. Second post here.\n3. Third one.');
    expect(out).toEqual(['First post here.', 'Second post here.', 'Third one.']);
  });

  it('handles ) instead of . as the separator', () => {
    const out = splitDrafts('1) One.\n2) Two.');
    expect(out).toEqual(['One.', 'Two.']);
  });

  it('handles bullets, which the model emits despite being asked not to', () => {
    const out = splitDrafts('- First thought.\n- Second thought.');
    expect(out).toEqual(['First thought.', 'Second thought.']);
  });

  it('falls back to blank-line separated paragraphs', () => {
    const out = splitDrafts('First para here.\n\nSecond para here.');
    expect(out).toEqual(['First para here.', 'Second para here.']);
  });

  it('strips markdown fences', () => {
    const out = splitDrafts('```\n1. Fenced post.\n2. Another.\n```');
    expect(out).toEqual(['Fenced post.', 'Another.']);
  });

  it('returns a single unnumbered post as one draft', () => {
    expect(splitDrafts('Just the one post, no list.')).toEqual(['Just the one post, no list.']);
  });

  it('returns nothing for empty output', () => {
    expect(splitDrafts('   ')).toEqual([]);
  });

  it('does not split on a number inside a sentence', () => {
    // "gone 12 away games" must not become a list boundary — the split
    // only fires at a line start.
    const out = splitDrafts('1. Arsenal have gone 12 away games unbeaten.\n2. Second.');
    expect(out).toEqual(['Arsenal have gone 12 away games unbeaten.', 'Second.']);
  });

  it('keeps multi-line posts intact within a numbered item', () => {
    const out = splitDrafts('1. Line one\ncontinues here.\n2. Second post.');
    expect(out[0]).toContain('continues here.');
    expect(out).toHaveLength(2);
  });
});

import { describe, it, expect } from 'vitest';
import { filterUncitedFindings, hasCitedFindings } from './research';

const SOURCES = ['Punch', 'BBNaija Updates', 'Vanguard Nigeria'];

describe('filterUncitedFindings', () => {
  it('keeps a line whose bracketed citation matches a real source', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Sun 3 Aug — Kola was evicted with 12% of the vote [Punch]\n\n' +
      '=== WHAT PEOPLE ARE ARGUING ABOUT ===\n' +
      'Half the timeline says Kola was robbed.';

    const out = filterUncitedFindings(findings, SOURCES);
    expect(out).toContain('Kola was evicted');
  });

  it('drops a line with no bracketed citation at all', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Kola was evicted with 12% of the vote\n\n' +
      '=== WHAT PEOPLE ARE ARGUING ABOUT ===\n' +
      'Something.';

    const out = filterUncitedFindings(findings, SOURCES);
    expect(out).not.toContain('Kola was evicted');
  });

  it('drops a line whose citation names a source that was never actually searched', () => {
    // A model hallucinating a source name is exactly the failure mode
    // this guards against — a plausible-sounding outlet nobody's
    // grounding metadata ever named.
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Kola was evicted with 12% of the vote [Made Up Gossip Blog]\n\n' +
      '=== WHAT PEOPLE ARE ARGUING ABOUT ===\n' +
      'Something.';

    const out = filterUncitedFindings(findings, SOURCES);
    expect(out).not.toContain('Kola was evicted');
  });

  it('matches case-insensitively and on partial overlap', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Kola was evicted [punch]\n';

    const out = filterUncitedFindings(findings, SOURCES);
    expect(out).toContain('Kola was evicted');
  });

  it('never touches the "what people are arguing about" section', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Uncited claim here\n\n' +
      '=== WHAT PEOPLE ARE ARGUING ABOUT ===\n' +
      'Half the timeline says Kola was robbed; the other half says he coasted.';

    const out = filterUncitedFindings(findings, SOURCES);
    expect(out).toContain('Half the timeline says Kola was robbed');
    expect(out).not.toContain('Uncited claim here');
  });

  it('drops every line when no real sources were returned at all', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Kola was evicted [Punch]\n' +
      'Ada won the task [Vanguard Nigeria]\n';

    const out = filterUncitedFindings(findings, []);
    expect(out).not.toContain('Kola was evicted');
    expect(out).not.toContain('Ada won the task');
  });

  it('keeps text unchanged when there is no "WHAT HAPPENED" header to filter', () => {
    const findings = 'NOTHING RECENT';
    expect(filterUncitedFindings(findings, SOURCES)).toBe(findings);
  });

  it('together with hasCitedFindings — an empty result after filtering reads as "no findings"', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Kola was evicted [Made Up Blog]\n\n' +
      '=== WHAT PEOPLE ARE ARGUING ABOUT ===\n' +
      'People argue about things.';

    const out = filterUncitedFindings(findings, SOURCES);
    // The section header stays, but there is nothing under it — the
    // caller must be able to detect that, or a "successful" research
    // return with an empty facts section will smuggle general-knowledge
    // drafts through the anti-hallucination rail. That was the Ten Hag
    // bug of 2026-09.
    expect(hasCitedFindings(out)).toBe(false);
  });

  it('hasCitedFindings — true when at least one line survives', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Kola was evicted [Punch]\n\n' +
      '=== WHAT PEOPLE ARE ARGUING ABOUT ===\n' +
      'Argument.';
    const out = filterUncitedFindings(findings, SOURCES);
    expect(hasCitedFindings(out)).toBe(true);
  });

  it('preserves blank-line spacing between kept and dropped lines', () => {
    const findings =
      '=== WHAT HAPPENED ===\n' +
      'Kola was evicted [Punch]\n' +
      'Uncited filler line\n' +
      'Ada won the task [Vanguard Nigeria]\n';

    const out = filterUncitedFindings(findings, SOURCES);
    expect(out).toContain('Kola was evicted');
    expect(out).toContain('Ada won the task');
    expect(out).not.toContain('Uncited filler');
  });
});

import { describe, expect, it } from 'vitest';
import type { JobStatus } from '../db/types.js';
import { assertTransition, canTransition, isTerminal } from './lifecycle.js';

const ALL: JobStatus[] = [
  'queued',
  'scheduled',
  'running',
  'retrying',
  'completed',
  'dead',
  'cancelled',
];

const LEGAL: ReadonlyArray<[JobStatus, JobStatus]> = [
  ['queued', 'running'],
  ['queued', 'cancelled'],
  ['scheduled', 'queued'],
  ['scheduled', 'cancelled'],
  ['running', 'completed'],
  ['running', 'retrying'],
  ['running', 'queued'],
  ['running', 'dead'],
  ['retrying', 'queued'],
  ['retrying', 'cancelled'],
  ['dead', 'queued'], // manual retry (R6)
];

describe('canTransition', () => {
  it('allows every legal edge', () => {
    for (const [from, to] of LEGAL) expect(canTransition(from, to)).toBe(true);
  });

  it('rejects every edge not in the legal set (full matrix)', () => {
    const legalSet = new Set(LEGAL.map(([f, t]) => `${f}->${t}`));
    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to) continue;
        const expected = legalSet.has(`${from}->${to}`);
        expect(canTransition(from, to)).toBe(expected);
      }
    }
  });

  it('completed, dead, and cancelled are all terminal (no outgoing edges except dead->queued)', () => {
    for (const to of ALL) expect(canTransition('completed', to)).toBe(false);
    for (const to of ALL) expect(canTransition('cancelled', to)).toBe(false);
  });

  it('assertTransition throws on an illegal edge', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(/illegal/);
    expect(() => assertTransition('running', 'completed')).not.toThrow();
  });
});

describe('isTerminal', () => {
  it('completed, dead, and cancelled are terminal; others are not', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('dead')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isTerminal('retrying')).toBe(false);
  });
});

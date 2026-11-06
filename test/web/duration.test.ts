import { describe, expect, it } from 'vitest';
import { clockText, durationText } from '../../src/web/duration.js';

describe('durationText', () => {
  it('says seconds, minutes and hours in short words', () => {
    expect(durationText(45_000)).toBe('45 s');
    expect(durationText(372_000)).toBe('6 min 12 s');
    expect(durationText(360_000)).toBe('6 min');
    expect(durationText(3_840_000)).toBe('1 h 4 min');
    expect(durationText(3_600_000)).toBe('1 h');
    expect(durationText(-5)).toBe('0 s');
  });
});

describe('clockText', () => {
  it('reads like a clock', () => {
    expect(clockText(7_000)).toBe('0:07');
    expect(clockText(252_400)).toBe('4:12');
    expect(clockText(3_729_000)).toBe('1:02:09');
  });
});

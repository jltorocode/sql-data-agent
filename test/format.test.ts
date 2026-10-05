import { describe, expect, it } from 'vitest';
import { formatCompact, formatDateLabel, formatValue, niceScale } from '@/lib/format';

describe('niceScale', () => {
  it('starts at zero with round steps', () => {
    expect(niceScale([120, 1907])).toEqual({ lo: 0, hi: 2000, ticks: [0, 500, 1000, 1500, 2000] });
  });

  it('uses one step for both sides', () => {
    expect(niceScale([-35, 60]).ticks).toEqual([-50, -25, 0, 25, 50, 75]);
  });

  it('gives a tiny negative side just enough room', () => {
    const scale = niceScale([-15, 1337]);
    expect(scale.ticks).toEqual([0, 500, 1000, 1500]);
    expect(scale.lo).toBeCloseTo(-16.2);
  });
});

describe('formatting', () => {
  it('writes money the Chilean way', () => {
    expect(formatValue(4977883656, 'clp')).toBe('$4.977.883.656');
    expect(formatCompact(4977883656, 'clp')).toBe('$4.978 MM');
    expect(formatCompact(35000, 'clp')).toBe('$35 mil');
    expect(formatValue(12.345, 'percent')).toBe('12,3 %');
  });

  it('labels months and days', () => {
    expect(formatDateLabel('2026-03-01', true)).toMatch(/mar.*2026/);
    expect(formatDateLabel('2025-09-17', false)).toMatch(/17.*sept.*2025/);
  });
});

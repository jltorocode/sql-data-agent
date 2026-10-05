import type { ChartSpec } from './agent/events';

const LOCALE = 'es-CL';

/** Full value, for tables and tooltips: $4.978.123 · 12,3 % · 1.284 */
export function formatValue(value: unknown, unit: ChartSpec['unit'] | 'auto' = 'auto'): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value === null || value === undefined ? '—' : String(value);
  if (unit === 'clp') return `$${Math.round(value).toLocaleString(LOCALE)}`;
  if (unit === 'percent') return `${value.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} %`;
  return value.toLocaleString(LOCALE, { maximumFractionDigits: Number.isInteger(value) ? 0 : 2 });
}

/** Short value, for axes and labels: $4.978 MM · $35 mil · 12,3 % · 1,3 mil */
export function formatCompact(value: number, unit: ChartSpec['unit']): string {
  const abs = Math.abs(value);
  const n = (v: number, digits: number) => v.toLocaleString(LOCALE, { maximumFractionDigits: digits });
  if (unit === 'percent') return `${n(value, 1)} %`;
  const prefix = unit === 'clp' ? '$' : '';
  if (abs >= 1e6) return `${prefix}${n(value / 1e6, abs >= 1e8 ? 0 : 1)} MM`;
  if (abs >= 1e3) return `${prefix}${n(value / 1e3, abs >= 1e5 ? 0 : 1)} mil`;
  return `${prefix}${n(value, 1)}`;
}

/** "2026-03-01" → "mar 2026" when every date is the first of a month, else "17 sept 2025". */
export function formatDateLabel(value: unknown, monthly: boolean): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return String(value);
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return date.toLocaleDateString(LOCALE, monthly ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * A domain that always includes zero, with round ticks on one shared step:
 * 0, 500, 1.000… or -20, 0, 20, 40. One step for both sides keeps labels apart.
 */
export function niceScale(values: number[], count = 4): { lo: number; hi: number; ticks: number[] } {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (lo === hi) return { lo: 0, hi: 1, ticks: [0, 1] };
  const raw = (hi - lo) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  // A side much smaller than one step (-15 next to +1.500) gets just enough room, not a whole step.
  const start = -lo < step / 2 ? lo * 1.08 : Math.floor(lo / step) * step;
  const end = hi < step / 2 ? hi * 1.08 : Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end + 1e-9; t += step) ticks.push(Math.round(t / step) * step || 0);
  return { lo: start, hi: end, ticks };
}

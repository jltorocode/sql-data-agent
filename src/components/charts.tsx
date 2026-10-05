'use client';

import { type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import type { ChartSpec, QueryTable } from '@/lib/agent/events';
import { formatCompact, formatDateLabel, formatValue, niceScale } from '@/lib/format';

// Marks follow the dataviz rules: bars at most 20px thick with a 4px rounded
// data end, 2px lines, end dots with a 2px surface ring, hairline gridlines,
// a legend for two or more series, and text in ink colors, never series colors.
// The series colors are validated for color-vision deficiencies in both themes.

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

/**
 * The chart's real width in pixels. The SVG is drawn at that size instead of
 * being scaled, so 11px labels stay 11px on a phone and on a wide screen.
 */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry!.contentRect.width))));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

interface ChartProps {
  spec: ChartSpec;
  table: QueryTable;
}

export function Chart({ spec, table }: ChartProps) {
  const index = (name?: string) => table.columns.findIndex((c) => c.name === name);
  const x = index(spec.x);
  const ys = spec.y.map(index).filter((i) => i >= 0);
  const xIsDate = table.columns[x]?.type === 'date' || table.columns[x]?.type === 'timestamp';

  return (
    <figure className="rounded-xl border border-line bg-surface p-4">
      <figcaption className="mb-3 text-sm font-medium text-ink">{spec.title}</figcaption>
      {spec.kind === 'number' && <NumberTile value={table.rows[0]?.[ys[0]!]} unit={spec.unit} />}
      {spec.kind !== 'number' && ys.length > 1 && <Legend names={spec.y} kind={spec.kind} />}
      {spec.kind === 'bar' && <BarChart table={table} x={x} ys={ys} spec={spec} />}
      {spec.kind === 'line' && <LineChart table={table} x={x} ys={ys} spec={spec} xIsDate={xIsDate} />}
    </figure>
  );
}

function NumberTile({ value, unit }: { value: unknown; unit: ChartSpec['unit'] }) {
  const full = formatValue(value, unit);
  const long = typeof value === 'number' && unit === 'clp' && Math.abs(value) >= 1e8;
  return (
    <div>
      <p className="text-5xl font-semibold tracking-tight text-ink">{long ? formatCompact(value as number, unit) : full}</p>
      {long && <p className="mt-1 text-sm text-ink-2">{full}</p>}
    </div>
  );
}

function Legend({ names, kind }: { names: string[]; kind: ChartSpec['kind'] }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {names.map((name, i) => (
        <li key={name} className="flex items-center gap-1.5">
          {kind === 'line' ? (
            <span className="h-0.5 w-3.5 rounded" style={{ background: SERIES[i] }} />
          ) : (
            <span className="size-2.5 rounded-sm" style={{ background: SERIES[i] }} />
          )}
          {name}
        </li>
      ))}
    </ul>
  );
}

interface PlotProps {
  table: QueryTable;
  x: number;
  ys: number[];
  spec: ChartSpec;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);


function BarChart({ table, x, ys, spec }: PlotProps) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const W = useWidth(box);
  const rows = table.rows;
  const { lo, hi, ticks } = niceScale(rows.flatMap((r) => ys.map((i) => num(r[i]))));
  const left = Math.min(150, Math.round(W * 0.32));
  const right = W - 64;
  const thick = ys.length === 1 ? 18 : Math.max(6, Math.min(12, 30 / ys.length));
  const band = ys.length === 1 ? 30 : ys.length * (thick + 2) + 12;
  const top = 6;
  const height = top + rows.length * band + 24;
  const sx = (v: number) => left + ((v - lo) / (hi - lo || 1)) * (right - left);
  const zero = sx(0);
  const labelTips = ys.length === 1 && rows.length <= 12;
  const maxLabel = Math.max(8, Math.floor(left / 6.5));

  return (
    <div ref={box} className="relative">
      <svg viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="block max-w-full" role="img" aria-label={spec.title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={sx(t)} x2={sx(t)} y1={top} y2={height - 22} stroke="var(--grid)" strokeWidth={1} />
            <text x={sx(t)} y={height - 6} textAnchor="middle" className="fill-muted text-[11px] tabular-nums">
              {formatCompact(t, spec.unit)}
            </text>
          </g>
        ))}
        <line x1={zero} x2={zero} y1={top} y2={height - 22} stroke="var(--axis)" strokeWidth={1} />
        {rows.map((row, r) => {
          const y0 = top + r * band;
          const label = String(row[x] ?? '');
          return (
            <g
              key={r}
              tabIndex={0}
              onPointerEnter={() => setHover(r)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(r)}
              onBlur={() => setHover(null)}
              className="outline-none"
            >
              <rect x={0} y={y0} width={W} height={band} fill={hover === r ? 'var(--hover)' : 'transparent'} />
              <text x={left - 10} y={y0 + band / 2} dominantBaseline="middle" textAnchor="end" className="fill-ink-2 text-[12px]">
                {label.length > maxLabel ? `${label.slice(0, maxLabel - 1)}…` : label}
                <title>{label}</title>
              </text>
              {ys.map((col, s) => {
                const v = num(row[col]);
                const by = y0 + (band - (ys.length * (thick + 2) - 2)) / 2 + s * (thick + 2);
                return <path key={col} d={barPath(zero, sx(v), by, thick)} fill={SERIES[s]} />;
              })}
              {labelTips && (
                <text
                  x={num(row[ys[0]!]) >= 0 ? sx(num(row[ys[0]!])) + 6 : sx(num(row[ys[0]!])) - 6}
                  y={y0 + band / 2}
                  dominantBaseline="middle"
                  textAnchor={num(row[ys[0]!]) >= 0 ? 'start' : 'end'}
                  className="fill-ink-2 text-[11px] tabular-nums"
                >
                  {formatCompact(num(row[ys[0]!]), spec.unit)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip
          title={String(rows[hover]![x] ?? '')}
          items={ys.map((col, s) => ({ name: spec.y[s]!, value: formatValue(rows[hover]![col], spec.unit), color: SERIES[s]! }))}
          style={{ top: `${((top + hover * band) / height) * 100}%`, right: 0 }}
        />
      )}
    </div>
  );
}

/** A bar from the baseline to the value: square at the baseline, 4px rounded at the data end. */
function barPath(x0: number, x1: number, y: number, h: number): string {
  const r = Math.min(4, Math.abs(x1 - x0), h / 2);
  if (x1 >= x0) return `M${x0},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y + h - r} Q${x1},${y + h} ${x1 - r},${y + h} H${x0} Z`;
  return `M${x0},${y} H${x1 + r} Q${x1},${y} ${x1},${y + r} V${y + h - r} Q${x1},${y + h} ${x1 + r},${y + h} H${x0} Z`;
}

function LineChart({ table, x, ys, spec, xIsDate }: PlotProps & { xIsDate: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const W = useWidth(box);
  const rows = table.rows;
  const height = 260;
  const top = 12;
  const bottom = height - 28;
  const left = 64;
  const single = ys.length === 1;
  const right = W - (single ? 72 : 16);
  const { lo, hi, ticks } = niceScale(rows.flatMap((r) => ys.map((i) => num(r[i]))));
  const step = rows.length > 1 ? (right - left) / (rows.length - 1) : 0;
  const px = (i: number) => left + i * step;
  const py = (v: number) => bottom - ((v - lo) / (hi - lo || 1)) * (bottom - top);
  const monthly = xIsDate && rows.every((r) => String(r[x]).slice(8, 10) === '01');
  const xLabel = (i: number) => (xIsDate ? formatDateLabel(rows[i]![x], monthly) : String(rows[i]![x]));
  // A label every ~90px; the last point gets one too when it isn't crowded.
  const tickEvery = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((right - left) / 90))));
  const xTicks = rows.map((_, i) => i).filter((i) => i % tickEvery === 0);
  if (rows.length - 1 - xTicks.at(-1)! >= Math.ceil(tickEvery * 0.75)) xTicks.push(rows.length - 1);

  function move(event: PointerEvent<SVGRectElement>) {
    const box = svg.current!.getBoundingClientRect();
    const vx = ((event.clientX - box.left) / box.width) * W;
    setHover(Math.max(0, Math.min(rows.length - 1, Math.round((vx - left) / (step || 1)))));
  }

  const last = rows.length - 1;
  return (
    <div ref={box} className="relative">
      <svg ref={svg} viewBox={`0 0 ${W} ${height}`} width={W} height={height} className="block max-w-full" role="img" aria-label={spec.title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={left} x2={right} y1={py(t)} y2={py(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth={1} />
            <text x={left - 8} y={py(t)} dominantBaseline="middle" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {formatCompact(t, spec.unit)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={px(i)} y={height - 8} textAnchor="middle" className="fill-muted text-[11px]">
            {xLabel(i)}
          </text>
        ))}
        {hover !== null && <line x1={px(hover)} x2={px(hover)} y1={top} y2={bottom} stroke="var(--axis)" strokeWidth={1} />}
        {ys.map((col, s) => (
          <g key={col}>
            <polyline
              points={rows.map((r, i) => `${px(i)},${py(num(r[col]))}`).join(' ')}
              fill="none"
              stroke={SERIES[s]}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle cx={px(last)} cy={py(num(rows[last]![col]))} r={4} fill={SERIES[s]} stroke="var(--surface)" strokeWidth={2} />
            {hover !== null && <circle cx={px(hover)} cy={py(num(rows[hover]![col]))} r={4} fill={SERIES[s]} stroke="var(--surface)" strokeWidth={2} />}
          </g>
        ))}
        {single && (
          <text x={px(last) + 10} y={py(num(rows[last]![ys[0]!]))} dominantBaseline="middle" className="fill-ink-2 text-[11px] tabular-nums">
            {formatCompact(num(rows[last]![ys[0]!]), spec.unit)}
          </text>
        )}
        <rect
          x={left}
          y={top}
          width={right - left}
          height={bottom - top}
          fill="transparent"
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <Tooltip
          title={xLabel(hover)}
          items={ys.map((col, s) => ({ name: spec.y[s]!, value: formatValue(rows[hover]![col], spec.unit), color: SERIES[s]! }))}
          line
          style={{ top: 0, ...(px(hover) > W / 2 ? { left: 8 } : { right: 8 }) }}
        />
      )}
    </div>
  );
}

function Tooltip({
  title,
  items,
  line,
  style,
}: {
  title: string;
  items: { name: string; value: string; color: string }[];
  line?: boolean;
  style: React.CSSProperties;
}) {
  return (
    <div className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-sm" style={style}>
      <p className="mb-1 text-ink-2">{title}</p>
      {items.map((item) => (
        <p key={item.name} className="flex items-center gap-2">
          <span className={line ? 'h-0.5 w-3 rounded' : 'size-2 rounded-sm'} style={{ background: item.color }} />
          <span className="font-semibold tabular-nums text-ink">{item.value}</span>
          <span className="text-ink-2">{item.name}</span>
        </p>
      ))}
    </div>
  );
}

'use client';

import { useState } from 'react';
import type { QueryTable } from '@/lib/agent/events';
import { formatValue } from '@/lib/format';

const VISIBLE = 50;

function toCsv(table: QueryTable): string {
  const cell = (v: unknown) => {
    const text = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [table.columns.map((c) => cell(c.name)).join(','), ...table.rows.map((r) => r.map(cell).join(','))].join('\n');
}

export function ResultTable({ table }: { table: QueryTable }) {
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? table.rows : table.rows.slice(0, VISIBLE);

  function download() {
    const url = URL.createObjectURL(new Blob([toCsv(table)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${table.id}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="max-h-80 overflow-auto rounded-lg border border-line">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 bg-surface">
            <tr>
              {table.columns.map((c) => (
                <th
                  key={c.name}
                  scope="col"
                  className={`border-b border-line px-3 py-2 font-medium text-ink-2 ${c.type === 'number' ? 'text-right' : 'text-left'}`}
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="odd:bg-surface/60">
                {table.columns.map((c, i) => (
                  <td key={c.name} className={`border-b border-line/60 px-3 py-1.5 ${c.type === 'number' ? 'text-right tabular-nums' : ''}`}>
                    {formatValue(row[i])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted">
        <span>
          {table.rows.length.toLocaleString('es-CL')} {table.rows.length === 1 ? 'row' : 'rows'}
          {table.truncated && ' (first 500)'} · {table.durationMs} ms
        </span>
        {table.rows.length > VISIBLE && (
          <button onClick={() => setShowAll(!showAll)} className="underline-offset-2 hover:text-ink hover:underline">
            {showAll ? 'Show fewer' : `Show all ${table.rows.length}`}
          </button>
        )}
        <button onClick={download} className="underline-offset-2 hover:text-ink hover:underline">
          Download CSV
        </button>
      </div>
    </div>
  );
}

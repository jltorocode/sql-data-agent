// Shared by the server and the browser: no Node or SDK imports here.

export type ColumnType = 'number' | 'text' | 'date' | 'timestamp' | 'boolean' | 'other';

export interface QueryTable {
  id: string;
  sql: string;
  purpose: string;
  columns: { name: string; type: ColumnType }[];
  rows: unknown[][];
  truncated: boolean;
  durationMs: number;
}

export const CHART_KINDS = ['bar', 'line', 'number'] as const;
export const UNITS = ['clp', 'percent', 'count', 'other'] as const;

export interface ChartSpec {
  queryId: string;
  kind: (typeof CHART_KINDS)[number];
  title: string;
  /** Category or time column. Unused for `number`. */
  x?: string;
  /** One to four numeric columns. */
  y: string[];
  unit: (typeof UNITS)[number];
}

/** What the server streams to the browser while the agent works. */
export type AgentEvent =
  | { type: 'text'; block: string; text: string }
  /** A model call was retried: drop the text already shown for that step. */
  | { type: 'step_reset'; step: number }
  | { type: 'sql_start'; id: string; purpose: string }
  | { type: 'sql_result'; table: QueryTable }
  | { type: 'sql_error'; id: string; sql: string; purpose: string; message: string }
  | { type: 'chart'; chart: ChartSpec }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; message: string };

export interface Usage {
  steps: number;
  queries: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function encodeEvent(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Splits a chunk of an SSE stream into events; returns the unfinished tail to prepend to the next chunk. */
export function decodeEvents(buffer: string): { events: AgentEvent[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = parts
    .map((part) => part.trim())
    .filter((part) => part.startsWith('data: '))
    .map((part) => JSON.parse(part.slice(6)) as AgentEvent);
  return { events, rest };
}

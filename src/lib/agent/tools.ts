import type pg from 'pg';
import { z } from 'zod';
import { DEFAULT_LIMITS, QueryError, type QueryLimits, runReadOnly } from '../sql/execute';
import { type AgentEvent, CHART_KINDS, type QueryTable, UNITS } from './events';
import type { Tool } from './sdk';

/** Rows of a result the model reads. The person sees the whole table (up to 500 rows). */
export const ROWS_FOR_MODEL = 50;

export const inputSchemas = {
  run_sql: z.strictObject({
    sql: z.string().min(1).max(8000),
    purpose: z.string().min(3).max(200),
  }),
  show_chart: z.strictObject({
    query_id: z.string(),
    kind: z.enum(CHART_KINDS),
    title: z.string().min(1).max(120),
    x: z.string().optional(),
    y: z.array(z.string()).min(1).max(4),
    unit: z.enum(UNITS),
  }),
};

// Inputs stream as they are generated (eager_input_streaming), so the API doesn't
// validate them: inputSchemas does, before any tool runs.
export const TOOLS: Tool[] = [
  {
    name: 'run_sql',
    description:
      'Runs one read-only PostgreSQL SELECT on the analytics views and returns its result with a query_id. Only SELECT, only the views in the schema, at most 500 rows (you see the first 50), 5 seconds at most. The user sees the query and its full result.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sql', 'purpose'],
      properties: {
        sql: { type: 'string', description: 'One SELECT statement. WITH and window functions are fine.' },
        purpose: { type: 'string', description: "What the query answers, in a few words in the user's language. Shown above the result." },
      },
    },
  },
  {
    name: 'show_chart',
    description:
      'Shows a chart of a result you already have. line: a trend over time, x is the date column. bar: compare or rank categories, x is the category column (40 rows at most). number: one headline figure from a one-row result. Up to 4 numeric columns in y.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['query_id', 'kind', 'title', 'y', 'unit'],
      properties: {
        query_id: { type: 'string', description: 'The query_id returned by run_sql.' },
        kind: { type: 'string', enum: [...CHART_KINDS] },
        title: { type: 'string', description: "A short title in the user's language." },
        x: { type: 'string', description: 'The column for the categories or dates. Not used for number.' },
        y: { type: 'array', items: { type: 'string' }, description: 'One to four numeric columns.' },
        unit: { type: 'string', enum: [...UNITS], description: 'clp for money, percent for 0-100 percentages, count for orders, units or people.' },
      },
    },
  },
];

export interface ToolContext {
  pool: pg.Pool;
  /** Results of this conversation, so charts can refer to them by id. */
  tables: Map<string, QueryTable>;
  emit: (event: AgentEvent) => void;
  limits?: QueryLimits;
}

export interface ToolOutcome {
  ok: boolean;
  content: string;
}

const invalid = (input: unknown, problems: string[]): ToolOutcome => ({
  ok: false,
  content: JSON.stringify({ INVALID_INPUT: JSON.stringify(input), problems }),
});

export async function runTool(name: string, input: unknown, context: ToolContext): Promise<ToolOutcome> {
  if (name === 'run_sql') {
    const parsed = inputSchemas.run_sql.safeParse(input);
    if (!parsed.success) return invalid(input, parsed.error.issues.map((i) => i.message));
    const { sql, purpose } = parsed.data;
    const id = `q${context.tables.size + 1}`;
    context.emit({ type: 'sql_start', id, purpose });
    try {
      const result = await runReadOnly(context.pool, sql, context.limits ?? DEFAULT_LIMITS);
      const table: QueryTable = {
        id,
        sql: result.sql,
        purpose,
        columns: result.columns,
        rows: result.rows,
        truncated: result.truncated,
        durationMs: result.durationMs,
      };
      context.tables.set(id, table);
      context.emit({ type: 'sql_result', table });
      return {
        ok: true,
        content: JSON.stringify({
          query_id: id,
          columns: result.columns.map((c) => `${c.name} (${c.type})`),
          rows: result.rows.slice(0, ROWS_FOR_MODEL),
          row_count: result.rowCount,
          ...(result.rowCount > ROWS_FOR_MODEL ? { note: `You see the first ${ROWS_FOR_MODEL} rows; the user sees all ${result.rowCount}.` } : {}),
          ...(result.truncated ? { truncated: 'There were more than 500 rows. Aggregate or filter.' } : {}),
        }),
      };
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      // The id is spent either way, so later ids never collide.
      context.tables.set(id, { id, sql, purpose, columns: [], rows: [], truncated: false, durationMs: 0 });
      context.emit({ type: 'sql_error', id, sql, purpose, message: error.message });
      return { ok: false, content: JSON.stringify({ error: error.message, kind: error.kind }) };
    }
  }

  if (name === 'show_chart') {
    const parsed = inputSchemas.show_chart.safeParse(input);
    if (!parsed.success) return invalid(input, parsed.error.issues.map((i) => i.message));
    const { query_id, kind, title, x, y, unit } = parsed.data;
    const table = context.tables.get(query_id);
    const problems: string[] = [];
    if (!table || table.columns.length === 0) problems.push(`No result with query_id ${query_id}.`);
    else {
      const column = (n: string) => table.columns.find((c) => c.name === n);
      for (const n of y) {
        if (!column(n)) problems.push(`Column ${n} is not in ${query_id}.`);
        else if (column(n)!.type !== 'number') problems.push(`Column ${n} is not numeric.`);
      }
      if (kind === 'number') {
        if (table.rows.length !== 1 || y.length !== 1) problems.push('A number chart needs a one-row result and one y column.');
      } else {
        if (!x || !column(x)) problems.push(`Column ${x ?? '(x)'} is not in ${query_id}.`);
        if (kind === 'bar' && table.rows.length > 40) problems.push('Too many bars: aggregate or keep the top 40.');
        if (table.rows.length < 2) problems.push('A one-row result is better as kind number.');
      }
    }
    if (problems.length) return { ok: false, content: JSON.stringify({ error: problems.join(' ') }) };
    context.emit({ type: 'chart', chart: { queryId: query_id, kind, title, ...(x && kind !== 'number' ? { x } : {}), y, unit } });
    return { ok: true, content: 'Chart shown to the user.' };
  }

  return { ok: false, content: `Unknown tool: ${name}` };
}

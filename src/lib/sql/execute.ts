import pg from 'pg';
import { GuardError, guardSql } from './guard';

export interface Column {
  name: string;
  type: 'number' | 'text' | 'date' | 'timestamp' | 'boolean' | 'other';
}

export interface QueryResult {
  sql: string;
  columns: Column[];
  rows: unknown[][];
  /** Rows returned, up to maxRows. */
  rowCount: number;
  /** There were more rows than maxRows. */
  truncated: boolean;
  durationMs: number;
  /** The planner's estimate, checked against maxCost before running. */
  estimatedCost: number;
}

export interface QueryLimits {
  maxRows: number;
  /**
   * Planner cost units. On the demo data, the heaviest sensible queries (every order,
   * joined and grouped) cost about 25,000; a careless self-join, 470,000; a cross join never finishes.
   */
  maxCost: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: QueryLimits = { maxRows: 500, maxCost: 250_000, timeoutMs: 5000 };

export class QueryError extends Error {
  constructor(
    message: string,
    readonly kind: 'rejected' | 'too_expensive' | 'timeout' | 'database',
  ) {
    super(message);
  }
}

const NUMBER_TYPES = new Set([20, 21, 23, 700, 701, 1700]);
const TYPE_NAMES: Record<number, Column['type']> = { 16: 'boolean', 25: 'text', 1043: 'text', 1082: 'date', 1114: 'timestamp', 1184: 'timestamp' };

/** Numbers as numbers (pg returns bigint and numeric as strings), dates and timestamps as ISO text. */
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (NUMBER_TYPES.has(oid)) return (value: string) => Number(value);
    if (oid === 1082 || oid === 1114 || oid === 1184) return (value: string) => value;
    return pg.types.getTypeParser(oid, format);
  },
} as pg.CustomTypesConfig;

/**
 * Runs one query the safe way: guarded by the parser, inside a read-only
 * transaction with a timeout, only if its estimated cost is reasonable, and
 * through a cursor so at most maxRows + 1 rows ever leave the database.
 */
export async function runReadOnly(pool: pg.Pool, sql: string, limits: QueryLimits = DEFAULT_LIMITS): Promise<QueryResult> {
  let text: string;
  try {
    text = await guardSql(sql);
  } catch (error) {
    if (error instanceof GuardError) throw new QueryError(error.message, 'rejected');
    throw error;
  }

  const client = await pool.connect();
  const started = performance.now();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.round(limits.timeoutMs)}`);
    await client.query('SET LOCAL search_path = analytics');

    const plan = await client.query<{ 'QUERY PLAN': [{ Plan: { 'Total Cost': number } }] }>(`EXPLAIN (FORMAT JSON) ${text}`);
    const estimatedCost = plan.rows[0]!['QUERY PLAN'][0].Plan['Total Cost'];
    if (estimatedCost > limits.maxCost) {
      throw new QueryError(
        `The query is too expensive (estimated cost ${Math.round(estimatedCost).toLocaleString('en-US')}, limit ${limits.maxCost.toLocaleString('en-US')}). Check the joins, and filter or aggregate more.`,
        'too_expensive',
      );
    }

    await client.query(`DECLARE agent_cursor NO SCROLL CURSOR FOR ${text}`);
    const result = await client.query({ text: `FETCH ${limits.maxRows + 1} FROM agent_cursor`, rowMode: 'array', types });
    const rows = result.rows as unknown[][];
    const truncated = rows.length > limits.maxRows;
    if (truncated) rows.length = limits.maxRows;
    return {
      sql: text,
      columns: result.fields.map((f) => ({
        name: f.name,
        type: NUMBER_TYPES.has(f.dataTypeID) ? 'number' : (TYPE_NAMES[f.dataTypeID] ?? 'other'),
      })),
      rows,
      rowCount: rows.length,
      truncated,
      durationMs: Math.round(performance.now() - started),
      estimatedCost,
    };
  } catch (error) {
    if (error instanceof QueryError) throw error;
    const code = (error as { code?: string }).code;
    if (code === '57014') throw new QueryError(`The query took longer than ${limits.timeoutMs / 1000} seconds.`, 'timeout');
    // Postgres messages are safe to show and are exactly what the model needs to fix its SQL.
    throw new QueryError((error as Error).message, 'database');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

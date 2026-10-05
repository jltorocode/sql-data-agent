import { parse } from 'libpg-query';

/** The views the agent may read, all in the `analytics` schema. */
export const ALLOWED_TABLES = new Set(['stores', 'products', 'customers', 'orders', 'order_items']);

/**
 * Functions the agent may call. An allowlist, not a denylist: anything new,
 * like pg_sleep, pg_read_file, dblink or set_config, is rejected by default.
 */
export const ALLOWED_FUNCTIONS = new Set([
  // aggregates
  'count', 'sum', 'avg', 'min', 'max', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'percentile_cont', 'percentile_disc', 'mode', 'string_agg', 'array_agg', 'bool_and', 'bool_or', 'corr',
  // window functions
  'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value',
  'nth_value',
  // numbers
  'round', 'ceil', 'ceiling', 'floor', 'abs', 'trunc', 'sqrt', 'power', 'exp', 'ln', 'log', 'mod', 'sign', 'div',
  'width_bucket',
  // text
  'lower', 'upper', 'initcap', 'length', 'char_length', 'substr', 'substring', 'left', 'right', 'btrim', 'ltrim', 'rtrim',
  'concat', 'concat_ws', 'replace', 'split_part', 'position', 'strpos', 'lpad', 'rpad', 'to_char', 'to_number', 'format',
  // dates
  'date_trunc', 'date_part', 'extract', 'age', 'make_date', 'make_interval', 'to_date', 'to_timestamp', 'date_bin',
  'timezone', 'now', 'justify_days', 'isfinite',
  // sets
  'generate_series', 'unnest', 'array_length', 'cardinality',
]);

export const MAX_SQL_LENGTH = 8000;

export class GuardError extends Error {}

/**
 * Checks a query with PostgreSQL's own parser before it gets anywhere near the
 * database: one SELECT, only the analytics views, only allowlisted functions,
 * no writes hidden in a CTE, no SELECT INTO, no row locks.
 *
 * This is one layer of several. The database role is read-only and can only see
 * the analytics views, every query runs in a read-only transaction with a
 * timeout, and its estimated cost is checked first.
 */
export async function guardSql(sql: string): Promise<string> {
  const text = sql.trim().replace(/;+\s*$/, '');
  if (!text) throw new GuardError('The query is empty.');
  if (text.length > MAX_SQL_LENGTH) throw new GuardError(`The query is longer than ${MAX_SQL_LENGTH} characters.`);

  let tree: { stmts?: { stmt: Record<string, unknown> }[] };
  try {
    tree = (await parse(text)) as unknown as typeof tree;
  } catch (error) {
    // Parse errors carry the position in the query; anything else (the parser failing to load) is not the query's fault.
    if ((error as { sqlDetails?: unknown }).sqlDetails) throw new GuardError(`Syntax error: ${(error as Error).message}`);
    throw error;
  }
  const statements = tree.stmts ?? [];
  if (statements.length !== 1) throw new GuardError('Send exactly one statement.');
  const root = statements[0]!.stmt;
  if (!('SelectStmt' in root)) throw new GuardError('Only SELECT queries are allowed.');

  const cteNames = new Set<string>();
  walk(root, (key, node) => {
    if (key === 'CommonTableExpr') cteNames.add(String(node.ctename));
  });

  walk(root, (key, node) => {
    if (key.endsWith('Stmt') && key !== 'SelectStmt') {
      throw new GuardError(`Only SELECT queries are allowed (found ${key.replace(/Stmt$/, '').toUpperCase()}).`);
    }
    if (key === 'SelectStmt') {
      if (node.intoClause) throw new GuardError('SELECT INTO is not allowed.');
      if (node.lockingClause) throw new GuardError('Row locks (FOR UPDATE, FOR SHARE) are not allowed.');
    }
    if (key === 'RangeVar') {
      const schema = node.schemaname as string | undefined;
      const table = String(node.relname);
      const allowed = (schema === undefined || schema === 'analytics') && ALLOWED_TABLES.has(table);
      const cte = schema === undefined && cteNames.has(table);
      if (!allowed && !cte) {
        throw new GuardError(`Unknown table ${schema ? `${schema}.` : ''}${table}. Available: ${[...ALLOWED_TABLES].join(', ')}.`);
      }
    }
    if (key === 'FuncCall') {
      const parts = (node.funcname as { String: { sval: string } }[]).map((n) => n.String.sval);
      const name = parts.at(-1)!;
      const schema = parts.length > 1 ? parts[0] : undefined;
      if ((schema !== undefined && schema !== 'pg_catalog') || !ALLOWED_FUNCTIONS.has(name)) {
        throw new GuardError(`Function ${parts.join('.')} is not allowed.`);
      }
    }
    if (key === 'ParamRef') throw new GuardError('Query parameters ($1) are not supported.');
  });
  return text;
}

type Visitor = (key: string, node: Record<string, unknown>) => void;

/** Depth-first walk over every keyed node of the parse tree. */
function walk(value: unknown, visit: Visitor): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && typeof child === 'object' && !Array.isArray(child) && /^[A-Z]/.test(key)) {
      visit(key, child as Record<string, unknown>);
    }
    walk(child, visit);
  }
}

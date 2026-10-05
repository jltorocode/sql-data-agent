import { describe, expect, it } from 'vitest';
import { GuardError, guardSql } from '@/lib/sql/guard';

const allowed = [
  'SELECT count(*) FROM orders',
  "SELECT date_trunc('month', order_date) AS month, sum(net_amount) FROM orders JOIN order_items USING (order_id) WHERE status = 'completed' GROUP BY 1 ORDER BY 1;",
  'WITH r AS (SELECT region, sum(net_amount) AS revenue FROM analytics.orders JOIN stores USING (store_id) JOIN order_items USING (order_id) GROUP BY 1) SELECT region, revenue, rank() OVER (ORDER BY revenue DESC) FROM r',
  "SELECT extract(year FROM order_date), ordered_at AT TIME ZONE 'America/Santiago', trim(name) FROM orders JOIN stores USING (store_id)",
  "SELECT g::date FROM generate_series(date '2026-01-01', date '2026-09-01', interval '1 month') AS g",
  "SELECT category, sum(quantity) FILTER (WHERE status = 'returned')::numeric / nullif(sum(quantity), 0) FROM orders JOIN order_items USING (order_id) JOIN products USING (product_id) GROUP BY 1",
];

const rejected: [string, string][] = [
  ['DELETE FROM orders', 'Only SELECT'],
  ["UPDATE products SET list_price = 0", 'Only SELECT'],
  ['INSERT INTO stores VALUES (99)', 'Only SELECT'],
  ['DROP TABLE orders', 'Only SELECT'],
  ['TRUNCATE orders', 'Only SELECT'],
  ['SELECT 1; DELETE FROM orders', 'exactly one statement'],
  ['WITH gone AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM gone', 'found DELETE'],
  ['SELECT * INTO stolen FROM customers', 'SELECT INTO'],
  ['SELECT * FROM orders FOR UPDATE', 'Row locks'],
  ['SELECT email FROM store.customers', 'Unknown table store.customers'],
  ['SELECT * FROM pg_shadow', 'Unknown table pg_shadow'],
  ['SELECT * FROM pg_catalog.pg_authid', 'Unknown table pg_catalog.pg_authid'],
  ['SELECT table_name FROM information_schema.tables', 'Unknown table information_schema.tables'],
  ['SELECT * FROM orders WHERE order_id IN (SELECT usesysid FROM pg_user)', 'Unknown table pg_user'],
  ['SELECT pg_sleep(10)', 'pg_sleep is not allowed'],
  ["SELECT pg_read_file('/etc/passwd')", 'pg_read_file is not allowed'],
  ["SELECT set_config('statement_timeout', '0', false)", 'set_config is not allowed'],
  ["SELECT * FROM dblink('host=evil', 'select 1') AS t(a int)", 'dblink is not allowed'],
  ['SELECT current_setting($1)', 'not allowed'],
  ['SELECT public.my_function()', 'public.my_function is not allowed'],
  ["COPY orders TO '/tmp/orders.csv'", 'Only SELECT'],
  ['SET statement_timeout = 0', 'Only SELECT'],
  ["DO $$ BEGIN PERFORM 1; END $$", 'Only SELECT'],
  ['SELEC * FROM orders', 'Syntax error'],
  ['', 'empty'],
  [`SELECT ${'1 + '.repeat(3000)}1`, 'longer than'],
];

describe('guardSql', () => {
  it.each(allowed)('allows %s', async (sql) => {
    await expect(guardSql(sql)).resolves.toBe(sql.trim().replace(/;$/, ''));
  });

  it.each(rejected)('rejects %s', async (sql, reason) => {
    const attempt = guardSql(sql);
    await expect(attempt).rejects.toBeInstanceOf(GuardError);
    await expect(attempt).rejects.toThrow(reason);
  });
});

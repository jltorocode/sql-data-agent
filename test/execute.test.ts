import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, QueryError, runReadOnly } from '@/lib/sql/execute';

// Runs against the demo database (npm run db:setup). Skipped when there is none.
const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url }) : undefined;
afterAll(() => pool?.end());

describe.skipIf(!pool)('runReadOnly against PostgreSQL', () => {
  it('returns typed columns: numbers as numbers, dates as text', async () => {
    const result = await runReadOnly(pool!, "SELECT order_date, count(*) AS orders, sum(order_id)::numeric AS total FROM orders WHERE order_date = date '2025-09-17' GROUP BY 1");
    expect(result.columns).toEqual([
      { name: 'order_date', type: 'date' },
      { name: 'orders', type: 'number' },
      { name: 'total', type: 'number' },
    ]);
    expect(result.rows[0]![0]).toBe('2025-09-17');
    expect(typeof result.rows[0]![1]).toBe('number');
  });

  it('never returns more than maxRows, and says so', async () => {
    const result = await runReadOnly(pool!, 'SELECT order_id FROM orders ORDER BY order_id', { ...DEFAULT_LIMITS, maxRows: 10 });
    expect(result.rowCount).toBe(10);
    expect(result.truncated).toBe(true);
    expect(result.rows.map((r) => r[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('rejects a query whose plan is too expensive, before running it', async () => {
    const attempt = runReadOnly(pool!, 'SELECT count(*) FROM order_items a JOIN order_items b ON a.product_id = b.product_id');
    await expect(attempt).rejects.toMatchObject({ kind: 'too_expensive' });
  });

  it('stops a query that runs too long', async () => {
    const attempt = runReadOnly(pool!, 'SELECT count(*) FROM order_items a JOIN order_items b ON a.product_id = b.product_id', {
      ...DEFAULT_LIMITS,
      maxCost: Number.POSITIVE_INFINITY,
      timeoutMs: 300,
    });
    await expect(attempt).rejects.toMatchObject({ kind: 'timeout' });
  });

  it("passes Postgres' own error back, so the model can fix its query", async () => {
    const attempt = runReadOnly(pool!, 'SELECT revenue FROM orders');
    await expect(attempt).rejects.toBeInstanceOf(QueryError);
    await expect(attempt).rejects.toThrow('column "revenue" does not exist');
  });

  it('cannot see personal data even by asking for the column', async () => {
    await expect(runReadOnly(pool!, 'SELECT email FROM customers')).rejects.toThrow('column "email" does not exist');
  });
});

describe.skipIf(!url)('the agent_reader role, without the guard', () => {
  it('cannot write, read raw tables or create anything', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await expect(client.query('DELETE FROM orders')).rejects.toThrow(/permission denied|read-only/);
      await expect(client.query('SELECT * FROM store.customers')).rejects.toThrow('permission denied for schema store');
      await expect(client.query('CREATE TABLE x (a int)')).rejects.toThrow(/read-only|permission denied/);
    } finally {
      await client.end();
    }
  });
});

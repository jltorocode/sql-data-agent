import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type Conversation, type ModelStep, type StepRequest, TurnError, runTurn } from '@/lib/agent/agent';
import type { AgentEvent, QueryTable } from '@/lib/agent/events';
import type { Message } from '@/lib/agent/sdk';
import { TOOLS, runTool } from '@/lib/agent/tools';
import { reducer } from '@/lib/chat-state';

const url = process.env.DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url }) : new pg.Pool({ connectionString: 'postgres://invalid' });
afterAll(() => pool.end());

type Block = Message['content'][number];
const reply = (content: Block[], stop_reason: Message['stop_reason'] = 'end_turn') =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'test', content, stop_reason, usage: { input_tokens: 100, output_tokens: 10 } }) as unknown as Message;
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as unknown as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input }) as unknown as Block;

function scripted(...replies: Message[]) {
  const requests: StepRequest[] = [];
  const step: ModelStep = async (request, emit, n) => {
    requests.push(structuredClone({ ...request, signal: undefined }));
    const next = replies.shift()!;
    for (const block of next.content) if (block.type === 'text') emit({ type: 'text', block: `${n}:0`, text: block.text });
    return next;
  };
  return { step, requests };
}

let events: AgentEvent[];
let tables: Map<string, QueryTable>;
let conversation: Conversation;
const context = () => ({ pool, tables, emit: (e: AgentEvent) => events.push(e) });
beforeEach(() => {
  events = [];
  tables = new Map();
  conversation = { id: 'c', messages: [], turns: 0, lastActive: 0 };
});

describe.skipIf(!url)('tools against the demo database', () => {
  it('runs SQL, keeps the result for charts and shows the model at most 50 rows', async () => {
    const outcome = await runTool('run_sql', { sql: 'SELECT order_id FROM orders ORDER BY order_id LIMIT 80', purpose: 'Some orders' }, context());
    const content = JSON.parse(outcome.content);
    expect(outcome.ok).toBe(true);
    expect(content.query_id).toBe('q1');
    expect(content.rows).toHaveLength(50);
    expect(content.row_count).toBe(80);
    expect(tables.get('q1')!.rows).toHaveLength(80);
    expect(events.map((e) => e.type)).toEqual(['sql_start', 'sql_result']);
  });

  it('returns a rejected query as an error the model can read', async () => {
    const outcome = await runTool('run_sql', { sql: 'DELETE FROM orders', purpose: 'Clean up' }, context());
    expect(outcome.ok).toBe(false);
    expect(JSON.parse(outcome.content)).toMatchObject({ kind: 'rejected' });
    expect(events.at(-1)).toMatchObject({ type: 'sql_error', id: 'q1' });
  });

  it('checks a chart against the result it draws', async () => {
    await runTool('run_sql', { sql: 'SELECT category, count(*) AS products FROM products GROUP BY 1', purpose: 'Products per category' }, context());
    const bad = await runTool('show_chart', { query_id: 'q1', kind: 'bar', title: 'x', x: 'category', y: ['category'], unit: 'count' }, context());
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('not numeric');
    const wrongId = await runTool('show_chart', { query_id: 'q9', kind: 'bar', title: 'x', x: 'category', y: ['products'], unit: 'count' }, context());
    expect(wrongId.ok).toBe(false);
    const good = await runTool('show_chart', { query_id: 'q1', kind: 'bar', title: 'Products', x: 'category', y: ['products'], unit: 'count' }, context());
    expect(good.ok).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'chart', chart: { queryId: 'q1', kind: 'bar' } });
  });

  it('runs the loop: query, error, fixed query, chart, answer', async () => {
    const { step, requests } = scripted(
      reply([toolUse('t1', 'run_sql', { sql: 'SELECT revenue FROM orders', purpose: 'Revenue' })], 'tool_use'),
      reply([toolUse('t2', 'run_sql', { sql: "SELECT sum(net_amount) AS revenue FROM orders JOIN order_items USING (order_id) WHERE status = 'completed'", purpose: 'Revenue' })], 'tool_use'),
      reply([toolUse('t3', 'show_chart', { query_id: 'q2', kind: 'number', title: 'Revenue', y: ['revenue'], unit: 'clp' })], 'tool_use'),
      reply([text('Revenue was $14.000 millones.')]),
    );
    const usage = await runTurn(conversation, 'How much did we sell?', { step, system: 's', tools: TOOLS, toolContext: context() });
    expect(usage).toMatchObject({ steps: 4, queries: 2 });
    const firstResult = (requests[1]!.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
    expect(firstResult.is_error).toBe(true);
    expect(firstResult.content).toContain('column \\"revenue\\" does not exist');
    expect(events.filter((e) => e.type === 'chart')).toHaveLength(1);
    expect(conversation.messages).toHaveLength(8);
  });
});

describe('runTurn', () => {
  it('never runs a tool call cut off by max_tokens, and leaves the conversation as it was', async () => {
    const { step } = scripted(reply([toolUse('t1', 'run_sql', { sql: 'SELECT 1', purpose: 'x' })], 'max_tokens'));
    await expect(runTurn(conversation, 'q', { step, system: 's', tools: TOOLS, toolContext: context() })).rejects.toBeInstanceOf(TurnError);
    expect(events).toEqual([]);
    expect(conversation.messages).toEqual([]);
  });

  it('stops after too many steps', async () => {
    const loop = Array.from({ length: 5 }, (_, i) => reply([toolUse(`t${i}`, 'show_chart', { query_id: 'q1', kind: 'number', title: 't', y: ['a'], unit: 'count' })], 'tool_use'));
    const { step } = scripted(...loop);
    await expect(runTurn(conversation, 'q', { step, system: 's', tools: TOOLS, toolContext: context(), maxSteps: 3 })).rejects.toThrow('too many steps');
  });
});

describe('chat state', () => {
  it('builds queries, charts and text from the events', () => {
    const table: QueryTable = { id: 'q1', sql: 'SELECT 1', purpose: 'p', columns: [{ name: 'a', type: 'number' }], rows: [[1]], truncated: false, durationMs: 3 };
    const sequence: AgentEvent[] = [
      { type: 'sql_start', id: 'q1', purpose: 'p' },
      { type: 'sql_result', table },
      { type: 'chart', chart: { queryId: 'q1', kind: 'number', title: 't', y: ['a'], unit: 'count' } },
      { type: 'text', block: '1:0', text: 'One' },
      { type: 'text', block: '1:0', text: ' order.' },
      { type: 'done', usage: { steps: 2, queries: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } },
    ];
    const [, answer] = sequence.reduce((m, event) => reducer(m, { type: 'event', event }), reducer([], { type: 'ask', text: 'q' }));
    expect(answer!.parts.map((p) => p.kind)).toEqual(['query', 'chart', 'text']);
    expect(answer!.parts[0]).toMatchObject({ status: 'ok', sql: 'SELECT 1' });
    expect(answer!.parts[2]).toMatchObject({ text: 'One order.' });
    expect(answer!.status).toBe('done');
  });
});

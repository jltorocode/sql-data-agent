/**
 * Runs every case against the real agent and the demo database, and grades it.
 *
 *   npm run eval                    all cases (calls the Claude API)
 *   npm run eval -- grills return   only the cases whose id contains one of the words
 *   npm run eval -- --check-gold    only run the reference queries (no API calls)
 *
 * Reads ANTHROPIC_API_KEY and DATABASE_URL from .env.local.
 */
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { z } from 'zod';
import { type Conversation, runTurn } from '../src/lib/agent/agent';
import { DEFAULT_MODEL, claudeStep } from '../src/lib/agent/claude';
import type { AgentEvent, QueryTable, Usage } from '../src/lib/agent/events';
import { SYSTEM_PROMPT } from '../src/lib/agent/prompt';
import { TOOLS } from '../src/lib/agent/tools';
import { runReadOnly } from '../src/lib/sql/execute';
import { CASES, type EvalCase } from './cases';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const args = process.argv.slice(2);
const filters = args.filter((a) => !a.startsWith('--'));
const cases = filters.length ? CASES.filter((c) => filters.some((f) => c.id.includes(f))) : CASES;

if (args.includes('--check-gold')) {
  for (const c of cases.filter((c) => c.gold)) {
    const result = await runReadOnly(pool, c.gold!);
    console.log(`✓ ${c.id.padEnd(24)} ${JSON.stringify(result.rows.slice(0, 3))}${result.rowCount > 3 ? ` … ${result.rowCount} rows` : ''}`);
  }
  await pool.end();
  process.exit(0);
}

const client = new Anthropic();
const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
const step = claudeStep({ client, model });

// ---------- Comparing results

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.01 * Math.abs(b), 0.051);
/** Numbers within 1%, a ratio matches its percentage (0.086 ~ 8.6), text ignores case, dates their time. */
function sameValue(gold: unknown, got: unknown): boolean {
  if (typeof gold === 'number' && typeof got === 'number') return close(got, gold) || close(got, gold * 100) || close(got * 100, gold);
  const text = (v: unknown) => String(v ?? '').trim().toLowerCase().slice(0, /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? 10 : undefined);
  return text(gold) === text(got);
}
/** Every value of the gold row appears in the agent's row (which may have extra columns). */
function rowContains(gold: unknown[], got: unknown[]): boolean {
  const used = new Set<number>();
  return gold.every((g) => {
    const i = got.findIndex((v, j) => !used.has(j) && sameValue(g, v));
    if (i === -1) return false;
    used.add(i);
    return true;
  });
}
function sameResult(gold: unknown[][], got: unknown[][], ordered: boolean): boolean {
  if (gold.length !== got.length) return false;
  if (ordered) return gold.every((row, i) => rowContains(row, got[i]!));
  const used = new Set<number>();
  return gold.every((row) => {
    const i = got.findIndex((g, j) => !used.has(j) && rowContains(row, g));
    if (i === -1) return false;
    used.add(i);
    return true;
  });
}

// ---------- Playing and grading

interface Run {
  answer: string;
  tables: QueryTable[];
  usage?: Usage;
  error?: string;
}

async function play(testCase: EvalCase): Promise<Run> {
  const conversation: Conversation = { id: testCase.id, messages: [], turns: 0, lastActive: 0 };
  const tables = new Map<string, QueryTable>();
  let answer = '';
  const emit = (event: AgentEvent) => {
    if (event.type === 'text') answer += event.text;
  };
  try {
    const usage = await runTurn(conversation, testCase.question, {
      step,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      toolContext: { pool, tables, emit },
    });
    return { answer, tables: [...tables.values()].filter((t) => t.columns.length > 0), usage };
  } catch (error) {
    return { answer, tables: [], error: error instanceof Error ? error.message : String(error) };
  }
}

const verdict = z.object({ pass: z.boolean(), reason: z.string() });

async function judge(testCase: EvalCase, run: Run): Promise<z.infer<typeof verdict>> {
  const queries = run.tables.map((t) => `<query>\n${t.sql}\n</query>\n<rows>${JSON.stringify(t.rows.slice(0, 20))}</rows>`).join('\n');
  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: { type: 'object', additionalProperties: false, required: ['pass', 'reason'], properties: { pass: { type: 'boolean' }, reason: { type: 'string' } } },
      },
    },
    system: 'You grade a data analyst assistant. Read the question, the queries it ran, its answer and the rubric. Pass only if the answer meets every point of the rubric. Give the reason in one sentence.',
    messages: [
      {
        role: 'user',
        content: `<rubric>\n${testCase.rubric}\n</rubric>\n<question>\n${testCase.question}\n</question>\n${queries}\n<answer>\n${run.answer}\n</answer>`,
      },
    ],
  });
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const parsed = verdict.safeParse(JSON.parse(text || '{}'));
  return parsed.success ? parsed.data : { pass: false, reason: 'the judge answer did not match the schema' };
}

async function grade(testCase: EvalCase) {
  const run = await play(testCase);
  const problems: string[] = [];
  if (run.error) problems.push(`error: ${run.error}`);
  if (testCase.gold && !run.error) {
    const gold = await runReadOnly(pool, testCase.gold);
    const last = run.tables.at(-1);
    if (!last) problems.push('ran no successful query');
    else if (!sameResult(gold.rows, last.rows, testCase.ordered ?? false)) {
      problems.push(`result differs from the reference: got ${JSON.stringify(last.rows.slice(0, 3))}, expected ${JSON.stringify(gold.rows.slice(0, 3))}`);
    }
  }
  // Whatever the question, no result may contain personal data.
  if (run.tables.some((t) => JSON.stringify(t.rows).includes('@mail.example'))) problems.push('a result contains an email');
  if (testCase.rubric && !run.error) {
    const { pass, reason } = await judge(testCase, run);
    if (!pass) problems.push(`judge: ${reason}`);
  }
  return { testCase, run, problems };
}

console.log(`Running ${cases.length} cases on ${model}…\n`);
const results: Awaited<ReturnType<typeof grade>>[] = [];
// Three at a time: fast, and gentle with rate limits.
for (let i = 0; i < cases.length; i += 3) results.push(...(await Promise.all(cases.slice(i, i + 3).map(grade))));

for (const { testCase, run, problems } of results) {
  console.log(`${problems.length ? '✗' : '✓'} ${testCase.id}  (${run.usage?.queries ?? 0} queries)`);
  for (const problem of problems) console.log(`    ${problem}`);
}
const passed = results.filter((r) => r.problems.length === 0).length;
const accuracy = results.filter((r) => r.testCase.gold);
const usage = results.reduce((sum, r) => ({
  input: sum.input + (r.run.usage?.inputTokens ?? 0),
  cached: sum.cached + (r.run.usage?.cachedInputTokens ?? 0),
  output: sum.output + (r.run.usage?.outputTokens ?? 0),
}), { input: 0, cached: 0, output: 0 });
console.log(`\nExecution accuracy: ${accuracy.filter((r) => r.problems.length === 0).length}/${accuracy.length} · all checks: ${passed}/${results.length}`);
console.log(`Agent tokens: ${usage.input} in, ${usage.cached} cached, ${usage.output} out (the judge is not counted)`);
await pool.end();
process.exitCode = passed === results.length ? 0 : 1;

'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { type QueryTable, decodeEvents } from '@/lib/agent/events';
import { type ChatMessage, type Part, reducer, tablesOf } from '@/lib/chat-state';
import { Chart } from './charts';
import { ResultTable } from './result-table';

const MAX_CHARS = 1000;

const STARTERS = [
  '¿Cuánto vendimos por mes en 2026?',
  'Top 5 categories by revenue in 2025',
  '¿Qué región creció más este año contra el año pasado?',
  'Which category has the highest return rate?',
];

export function Ask() {
  const [messages, dispatch] = useReducer(reducer, []);
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID());
  const [input, setInput] = useState('');
  const controller = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const tables = useMemo(() => tablesOf(messages), [messages]);
  const working = messages.at(-1)?.status === 'streaming';

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  async function ask(text: string) {
    const question = text.trim();
    if (!question || working) return;
    setInput('');
    dispatch({ type: 'ask', text: question });
    controller.current = new AbortController();
    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, question }),
        signal: controller.current.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        dispatch({ type: 'fail', message: body?.error ?? `The server answered ${response.status}.` });
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { events, rest } = decodeEvents(buffer + value);
        buffer = rest;
        for (const event of events) dispatch({ type: 'event', event });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') dispatch({ type: 'fail', message: 'Could not reach the server.' });
    } finally {
      controller.current = null;
    }
  }

  function stop() {
    controller.current?.abort();
    dispatch({ type: 'stop' });
  }

  function newConversation() {
    controller.current?.abort();
    dispatch({ type: 'reset' });
    setConversationId(crypto.randomUUID());
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-page/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <span className="grid size-9 place-items-center rounded-lg bg-accent text-accent-ink" aria-hidden>
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
              <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[15px] font-semibold leading-tight">Andes Market · Data Agent</h1>
            <p className="truncate text-xs text-ink-2">Ask in plain language. Claude writes the SQL; the database only lets it read.</p>
          </div>
          {messages.length > 0 && (
            <button onClick={newConversation} className="rounded-lg px-2.5 py-1.5 text-sm text-ink-2 hover:bg-surface hover:text-ink">
              New chat
            </button>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-4 pb-40 pt-6">
        {messages.length === 0 ? (
          <Welcome onPick={ask} />
        ) : (
          <ol className="space-y-8">
            {messages.map((m) => (
              <li key={m.id}>
                {m.role === 'user' ? (
                  <h2 className="text-lg font-semibold leading-snug">{m.text}</h2>
                ) : (
                  <Answer message={m} tables={tables} />
                )}
              </li>
            ))}
          </ol>
        )}
        <div ref={bottom} />
      </main>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
        className="fixed inset-x-0 bottom-0 border-t border-line bg-page/95 backdrop-blur"
      >
        <div className="mx-auto flex max-w-4xl items-end gap-2 px-4 py-3">
          <label htmlFor="question" className="sr-only">
            Question
          </label>
          <textarea
            id="question"
            value={input}
            onChange={(e) => setInput(e.target.value.slice(0, MAX_CHARS))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(input);
              }
            }}
            rows={1}
            placeholder="Ask about sales, stores, products, customers…"
            className="field-sizing-content max-h-40 min-h-11 flex-1 resize-none rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[15px] outline-none placeholder:text-muted focus:border-ink-2"
          />
          {working ? (
            <button type="button" onClick={stop} className="h-11 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:border-ink-2">
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="h-11 rounded-xl bg-accent px-4 text-sm font-medium text-accent-ink disabled:opacity-40">
              Ask
            </button>
          )}
        </div>
        <p className="mx-auto max-w-4xl px-4 pb-3 text-[11px] text-muted">
          Demo with a fictional company. Read-only access to analytics views; no personal data.
        </p>
      </form>
    </div>
  );
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <section className="pt-8 sm:pt-16">
      <h2 className="text-2xl font-semibold tracking-tight">What do you want to know?</h2>
      <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-ink-2">
        Sales of Andes Market, a Chilean retail chain, from January 2024 to September 2026: 24 stores, 177 products and about
        68,000 orders. Every answer shows the SQL behind it.
      </p>
      <div className="mt-8 grid gap-2 sm:grid-cols-2">
        {STARTERS.map((text) => (
          <button key={text} onClick={() => onPick(text)} className="rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm hover:border-ink-2">
            {text}
          </button>
        ))}
      </div>
    </section>
  );
}

function Answer({ message, tables }: { message: ChatMessage; tables: Map<string, QueryTable> }) {
  const waiting = message.status === 'streaming' && !message.parts.some((p) => p.kind === 'text' && p.text);
  const text = message.parts.filter((p): p is Extract<Part, { kind: 'text' }> => p.kind === 'text');
  const work = message.parts.filter((p) => p.kind !== 'text');

  return (
    <article className="space-y-4">
      {work.map((part) =>
        part.kind === 'query' ? (
          <Query key={part.id} part={part} />
        ) : part.kind === 'chart' && tables.get(part.chart.queryId) ? (
          <Chart key={`${part.chart.queryId}-${part.chart.title}`} spec={part.chart} table={tables.get(part.chart.queryId)!} />
        ) : null,
      )}
      {text.length > 0 && <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{text.map((p) => p.text).join('')}</p>}
      {waiting && (
        <span className="inline-flex gap-1 py-1" aria-label="Thinking">
          <span className="dot size-1.5 rounded-full bg-muted" />
          <span className="dot size-1.5 rounded-full bg-muted" />
          <span className="dot size-1.5 rounded-full bg-muted" />
        </span>
      )}
      {message.status === 'error' && (
        <p className="flex items-center gap-2 text-sm text-critical">
          <span aria-hidden>⚠</span>
          {message.error}
        </p>
      )}
    </article>
  );
}

function Query({ part }: { part: Extract<Part, { kind: 'query' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-line bg-surface p-3">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span
          className={`size-2 rounded-full ${part.status === 'running' ? 'dot bg-muted' : part.status === 'ok' ? 'bg-good' : 'bg-critical'}`}
          aria-hidden
        />
        <span className="flex-1 font-medium">{part.purpose}</span>
        {part.sql && (
          <button onClick={() => setOpen(!open)} className="text-xs text-ink-2 hover:text-ink" aria-expanded={open}>
            {open ? 'Hide SQL' : 'SQL'}
          </button>
        )}
      </div>
      {open && part.sql && (
        <pre className="mb-2 overflow-x-auto rounded-lg bg-code p-3 font-mono text-xs leading-relaxed text-ink">{part.sql}</pre>
      )}
      {part.status === 'running' && <p className="text-xs text-muted">Running the query…</p>}
      {part.status === 'error' && (
        <p className="text-xs text-critical">
          <span className="font-medium">Query rejected or failed:</span> {part.error} <span className="text-ink-2">Claude reads this and retries.</span>
        </p>
      )}
      {part.status === 'ok' && part.table && <ResultTable table={part.table} />}
    </section>
  );
}

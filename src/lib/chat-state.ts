import type { AgentEvent, ChartSpec, QueryTable } from './agent/events';

// The conversation as the browser sees it, built from the streamed events.

export type Part =
  | { kind: 'text'; block: string; text: string }
  | { kind: 'query'; id: string; purpose: string; status: 'running' | 'ok' | 'error'; table?: QueryTable; sql?: string; error?: string }
  | { kind: 'chart'; chart: ChartSpec };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  parts: Part[];
  status: 'streaming' | 'done' | 'error';
  error?: string;
}

export type Action =
  | { type: 'ask'; text: string }
  | { type: 'event'; event: AgentEvent }
  | { type: 'fail'; message: string }
  | { type: 'stop' }
  | { type: 'reset' };

export function applyEvent(message: ChatMessage, event: AgentEvent): ChatMessage {
  const parts = [...message.parts];
  switch (event.type) {
    case 'text': {
      const i = parts.findIndex((p) => p.kind === 'text' && p.block === event.block);
      if (i === -1) parts.push({ kind: 'text', block: event.block, text: event.text });
      else {
        const part = parts[i] as Extract<Part, { kind: 'text' }>;
        parts[i] = { ...part, text: part.text + event.text };
      }
      return { ...message, parts };
    }
    case 'step_reset':
      return { ...message, parts: parts.filter((p) => !(p.kind === 'text' && p.block.startsWith(`${event.step}:`))) };
    case 'sql_start':
      return { ...message, parts: [...parts, { kind: 'query', id: event.id, purpose: event.purpose, status: 'running' }] };
    case 'sql_result':
      return {
        ...message,
        parts: parts.map((p) => (p.kind === 'query' && p.id === event.table.id ? { ...p, status: 'ok', table: event.table, sql: event.table.sql } : p)),
      };
    case 'sql_error':
      return {
        ...message,
        parts: parts.map((p) => (p.kind === 'query' && p.id === event.id ? { ...p, status: 'error', sql: event.sql, error: event.message } : p)),
      };
    case 'chart':
      return { ...message, parts: [...parts, { kind: 'chart', chart: event.chart }] };
    case 'done':
      return { ...message, status: 'done' };
    case 'error':
      return { ...message, status: 'error', error: event.message };
  }
}

export function reducer(messages: ChatMessage[], action: Action): ChatMessage[] {
  const last = messages.at(-1);
  switch (action.type) {
    case 'ask':
      return [
        ...messages,
        { id: crypto.randomUUID(), role: 'user', text: action.text, parts: [], status: 'done' },
        { id: crypto.randomUUID(), role: 'assistant', text: '', parts: [], status: 'streaming' },
      ];
    case 'event':
      return last?.role === 'assistant' ? [...messages.slice(0, -1), applyEvent(last, action.event)] : messages;
    case 'fail':
      return last?.role === 'assistant' ? [...messages.slice(0, -1), { ...last, status: 'error', error: action.message }] : messages;
    case 'stop':
      return last?.role === 'assistant' && last.status === 'streaming'
        ? [...messages.slice(0, -1), { ...last, status: 'error', error: 'Stopped.' }]
        : messages;
    case 'reset':
      return [];
  }
}

/** Every result table of the conversation, so a chart can find its data. */
export function tablesOf(messages: ChatMessage[]): Map<string, QueryTable> {
  const tables = new Map<string, QueryTable>();
  for (const m of messages) for (const p of m.parts) if (p.kind === 'query' && p.table) tables.set(p.table.id, p.table);
  return tables;
}

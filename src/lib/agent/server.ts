import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { type Conversation, type ModelStep, TurnError, runTurn } from './agent';
import { claudeStep } from './claude';
import { type AgentEvent, type QueryTable, encodeEvent } from './events';
import { SYSTEM_PROMPT } from './prompt';
import { TOOLS } from './tools';

export const LIMITS = { questionChars: 1000, turnsPerConversation: 30, conversationTtlMs: 60 * 60 * 1000 };

interface Session {
  conversation: Conversation;
  tables: Map<string, QueryTable>;
}

interface Services {
  sessions: Map<string, Session>;
  busy: Set<string>;
  pool?: pg.Pool;
  step?: ModelStep;
}

// One instance per server process; on globalThis so dev hot reloads keep the conversations.
// In production, conversations belong in Redis or Postgres.
const globals = globalThis as typeof globalThis & { __dataAgent?: Services };
const services: Services = (globals.__dataAgent ??= { sessions: new Map(), busy: new Set() });

function session(id: string): Session {
  const now = Date.now();
  for (const [key, s] of services.sessions) if (now - s.conversation.lastActive > LIMITS.conversationTtlMs) services.sessions.delete(key);
  let found = services.sessions.get(id);
  if (!found) {
    found = { conversation: { id, messages: [], turns: 0, lastActive: now }, tables: new Map() };
    services.sessions.set(id, found);
  }
  return found;
}

/** Runs a turn and returns it as a Server-Sent Events stream. */
export function streamTurn(conversationId: string, question: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (event: AgentEvent) => {
        if (!signal.aborted) controller.enqueue(encoder.encode(encodeEvent(event)));
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // The user closed the page: the stream is already gone.
        }
      };
      const { conversation, tables } = session(conversationId);
      if (services.busy.has(conversationId)) {
        emit({ type: 'error', message: 'Still working on your last question.' });
        return close();
      }
      if (conversation.turns >= LIMITS.turnsPerConversation) {
        emit({ type: 'error', message: 'This conversation is very long. Please start a new one.' });
        return close();
      }
      if (!process.env.DATABASE_URL) {
        emit({ type: 'error', message: 'DATABASE_URL is not set. Run npm run db:setup and add it to .env.local.' });
        return close();
      }

      services.busy.add(conversationId);
      let modelCalls = 0;
      try {
        services.pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
        services.step ??= claudeStep();
        const usage = await runTurn(conversation, question, {
          step: async (...args) => {
            modelCalls += 1;
            return services.step!(...args);
          },
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          toolContext: { pool: services.pool, tables, emit },
          signal,
        });
        emit({ type: 'done', usage });
      } catch (error) {
        if (!signal.aborted) {
          console.error('[data-agent]', error);
          emit({ type: 'error', message: userMessage(error, modelCalls) });
        }
      } finally {
        services.busy.delete(conversationId);
        close();
      }
    },
  });
}

function userMessage(error: unknown, modelCalls: number): string {
  if (error instanceof TurnError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) return 'The server has no valid Claude API key. Set ANTHROPIC_API_KEY in .env.local.';
  if (error instanceof Anthropic.RateLimitError) return 'Too many questions right now. Please try again in a minute.';
  if (error instanceof Anthropic.APIError) return 'The assistant is unavailable right now. Please try again later.';
  // The SDK throws a plain Error, before any request, when it finds no credentials.
  if (modelCalls <= 1) return 'Could not reach Claude. Is ANTHROPIC_API_KEY set in .env.local?';
  return 'Something went wrong. Please try again.';
}

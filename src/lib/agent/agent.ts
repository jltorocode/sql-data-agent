import type { AgentEvent, Usage } from './events';
import type { Message, MessageParam, Tool, ToolResultBlockParam, ToolUseBlock } from './sdk';
import { type ToolContext, runTool } from './tools';

export interface Conversation {
  id: string;
  /** The transcript as the API saw it. Only the server writes it, and only by appending. */
  messages: MessageParam[];
  turns: number;
  lastActive: number;
}

export interface StepRequest {
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  signal?: AbortSignal;
}

/** One streamed model call. Text goes to `emit` as it arrives; the full message is returned. */
export type ModelStep = (request: StepRequest, emit: (event: AgentEvent) => void, step: number) => Promise<Message>;

export interface TurnOptions {
  step: ModelStep;
  system: string;
  tools: Tool[];
  toolContext: ToolContext;
  maxSteps?: number;
  signal?: AbortSignal;
}

/** A failure with a message that is safe to show to the user. */
export class TurnError extends Error {}

/**
 * Runs one question through the agent loop: Claude writes SQL, the server runs
 * it safely, the result goes back, and it repeats until Claude can answer.
 *
 * The transcript is append-only and is committed only when the turn finishes,
 * so a failed turn leaves the conversation exactly as it was.
 */
export async function runTurn(conversation: Conversation, question: string, options: TurnOptions): Promise<Usage> {
  const { emit } = options.toolContext;
  const maxSteps = options.maxSteps ?? 8;
  const messages: MessageParam[] = [...conversation.messages, { role: 'user', content: question }];
  const usage: Usage = { steps: 0, queries: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  for (let step = 0; step < maxSteps; step++) {
    const request: StepRequest = { system: options.system, messages, tools: options.tools };
    if (options.signal) request.signal = options.signal;
    const message = await options.step(request, emit, step);
    usage.steps += 1;
    usage.inputTokens += message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0);
    usage.cachedInputTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.outputTokens += message.usage.output_tokens;

    if (message.stop_reason === 'refusal') throw new TurnError("Sorry, I can't help with that one.");
    const toolUses = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    // A tool input cut off by max_tokens can still look valid: never run it.
    if (message.stop_reason === 'max_tokens' && toolUses.length > 0) {
      throw new TurnError('My answer got cut off. Could you ask again?');
    }

    // Content goes back exactly as it came, thinking blocks included.
    messages.push({ role: 'assistant', content: message.content });
    if (toolUses.length === 0) {
      conversation.messages = messages;
      conversation.turns += 1;
      conversation.lastActive = Date.now();
      return usage;
    }

    const results: ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (use.name === 'run_sql') usage.queries += 1;
      const outcome = await runTool(use.name, use.input, options.toolContext);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: outcome.content, ...(outcome.ok ? {} : { is_error: true }) });
    }
    // All results of a step go back in one message.
    messages.push({ role: 'user', content: results });
  }
  throw new TurnError('That took me too many steps. Could you ask in a simpler way?');
}

import Anthropic from '@anthropic-ai/sdk';
import type { ModelStep } from './agent';

export const DEFAULT_MODEL = 'claude-opus-5-5';
type Effort = 'low' | 'medium' | 'high';

export interface ClaudeConfig {
  client?: Anthropic;
  model?: string;
  /** Writing correct SQL benefits from some thinking: medium by default. */
  effort?: Effort;
}

export function claudeStep({
  client = new Anthropic(),
  model = process.env.CLAUDE_MODEL || DEFAULT_MODEL,
  effort = (process.env.CLAUDE_EFFORT as Effort | undefined) || 'medium',
}: ClaudeConfig = {}): ModelStep {
  return async (request, emit, step) => {
    for (let attempt = 0; ; attempt++) {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 32000,
          system: [{ type: 'text', text: request.system }],
          messages: request.messages,
          tools: request.tools,
          output_config: { effort },
          // Caches the system prompt (schema included) and the conversation so far.
          cache_control: { type: 'ephemeral' },
          // If a safety classifier declines, the API retries on a fallback model in the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        request.signal ? { signal: request.signal } : undefined,
      );
      let started = false;
      try {
        for await (const event of stream) {
          started = true;
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            emit({ type: 'text', block: `${step}:${event.index}`, text: event.delta.text });
          }
        }
        return await stream.finalMessage();
      } catch (error) {
        // With eager input streaming, a tool input that isn't valid JSON rejects the stream
        // after it started. That is the only error worth retrying here: API errors already had
        // the SDK's retries, and an error before the first event (no credentials) won't go away.
        if (error instanceof Anthropic.APIError || !started || attempt >= 2) throw error;
        emit({ type: 'step_reset', step });
      }
    }
  };
}

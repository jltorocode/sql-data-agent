import { z } from 'zod';
import { LIMITS, streamTurn } from '@/lib/agent/server';

// A question can take several queries.
export const maxDuration = 120;

const body = z.object({
  conversationId: z.uuid(),
  question: z.string().trim().min(1).max(LIMITS.questionChars),
});

export async function POST(request: Request) {
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: `Send { conversationId: uuid, question: 1 to ${LIMITS.questionChars} characters }` }, { status: 400 });
  }
  return new Response(streamTurn(parsed.data.conversationId, parsed.data.question, request.signal), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}

import type { NarrativeRewriter } from '@marchmaker/shared';
import type { Env } from '../config/env';

const SYSTEM_PROMPT = [
  'You lightly rewrite one short paragraph of a personality reflection for a marriage-introductions service in India.',
  'Keep the meaning exactly the same. Keep it warm, plain and second person ("you").',
  'Do not add facts, advice, comparisons or judgement. Do not say one style is better than another.',
  'Never include numbers, scores, percentages, names or ratings.',
  'Return only the rewritten paragraph, no quotes or commentary, similar in length to the original.',
].join(' ');

/**
 * Optional LLM polish. Only the template paragraph and its heading are sent: no member id,
 * name, answers or scores. Output is still checked by `isSafeRewrite` before it is used.
 */
export class OpenAiNarrativeRewriter implements NarrativeRewriter {
  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-4o-mini',
  ) {}

  async rewrite(body: string, ctx: { assessmentTitle: string; heading: string }): Promise<string> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.4,
        max_tokens: 220,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Topic: ${ctx.assessmentTitle} / ${ctx.heading}\n\nParagraph:\n${body}` },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`rewriter returned ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content?.trim() ?? '';
  }
}

export function createNarrativeRewriter(env: Env): NarrativeRewriter | null {
  return env.OPENAI_API_KEY ? new OpenAiNarrativeRewriter(env.OPENAI_API_KEY) : null;
}

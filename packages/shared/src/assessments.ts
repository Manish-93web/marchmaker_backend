import { z } from 'zod';

export const ASSESSMENT_KEYS = ['values', 'communication', 'family', 'finances', 'lifestyle', 'faith'] as const;
export type AssessmentKey = (typeof ASSESSMENT_KEYS)[number];

export type QuestionType = 'likert' | 'single_choice' | 'ranking';

export interface ChoiceOption {
  id: string;
  label: string;
  /** Internal 0..1 position on the question's dimension. Never sent to members. */
  value: number;
}

export interface RankItem {
  id: string;
  label: string;
  /** The dimension this item expresses; a higher rank pushes that dimension up. */
  dimension: string;
}

export interface QuestionDef {
  id: string;
  type: QuestionType;
  prompt: string;
  /** likert / single_choice: the dimension this question informs. */
  dimension?: string;
  /** likert: agreeing means a LOWER score on the dimension. */
  reverse?: boolean;
  options?: ChoiceOption[];
  items?: RankItem[];
}

export type Answers = Record<string, number | string | string[]>;

export const LIKERT_LABELS = ['Strongly disagree', 'Disagree', 'Neither agree nor disagree', 'Agree', 'Strongly agree'] as const;

/** What members receive: the question without any scoring information. */
export interface PublicQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  options?: { id: string; label: string }[];
  items?: { id: string; label: string }[];
}

export function toPublicQuestion(q: QuestionDef): PublicQuestion {
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt,
    ...(q.options && { options: q.options.map(({ id, label }) => ({ id, label })) }),
    ...(q.items && { items: q.items.map(({ id, label }) => ({ id, label })) }),
  };
}

export function isValidAnswer(q: QuestionDef, a: unknown): boolean {
  switch (q.type) {
    case 'likert':
      return typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= 5;
    case 'single_choice':
      return typeof a === 'string' && !!q.options?.some((o) => o.id === a);
    case 'ranking': {
      if (!Array.isArray(a) || !q.items) return false;
      const ids = q.items.map((i) => i.id);
      return a.length === ids.length && new Set(a).size === a.length && a.every((x) => ids.includes(x));
    }
  }
}

export const answersPatchSchema = z.object({
  answers: z
    .record(z.string().max(40), z.union([z.number(), z.string().max(40), z.array(z.string().max(40)).max(12)]))
    .refine((r) => Object.keys(r).length <= 40, 'Too many answers'),
});

/** Internal dimension scores, 0..1, from a (possibly partial) set of answers. */
export function scoreAnswers(questions: QuestionDef[], answers: Answers): Record<string, number> {
  const parts: Record<string, number[]> = {};
  const push = (dim: string, v: number) => (parts[dim] ??= []).push(Math.min(1, Math.max(0, v)));

  for (const q of questions) {
    const a = answers[q.id];
    if (a === undefined || !isValidAnswer(q, a)) continue;
    if (q.type === 'likert' && q.dimension) {
      const v = ((a as number) - 1) / 4;
      push(q.dimension, q.reverse ? 1 - v : v);
    } else if (q.type === 'single_choice' && q.dimension) {
      const opt = q.options?.find((o) => o.id === a);
      if (opt) push(q.dimension, opt.value);
    } else if (q.type === 'ranking' && q.items) {
      const order = a as string[];
      const n = order.length;
      order.forEach((id, idx) => {
        const item = q.items?.find((i) => i.id === id);
        if (item) push(item.dimension, n > 1 ? 1 - idx / (n - 1) : 1);
      });
    }
  }
  return Object.fromEntries(
    Object.entries(parts).map(([dim, vs]) => [dim, Math.round((vs.reduce((s, x) => s + x, 0) / vs.length) * 100) / 100]),
  );
}

export type Band = 'low' | 'mid' | 'high';

export function bandFor(score: number): Band {
  if (score < 0.34) return 'low';
  if (score < 0.67) return 'mid';
  return 'high';
}

export function answeredCount(questions: QuestionDef[], answers: Answers): number {
  return questions.filter((q) => answers[q.id] !== undefined && isValidAnswer(q, answers[q.id])).length;
}

/** First unanswered question index, used to resume. */
export function resumeIndex(questions: QuestionDef[], answers: Answers): number {
  const i = questions.findIndex((q) => answers[q.id] === undefined || !isValidAnswer(q, answers[q.id]));
  return i === -1 ? questions.length : i;
}

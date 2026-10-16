import {
  answeredCount,
  ASSESSMENT_BANKS,
  ASSESSMENT_KEYS,
  bandFor,
  buildNarrative,
  DEFAULTS,
  isValidAnswer,
  resumeIndex,
  rewriteNarrative,
  scoreAnswers,
  toPublicQuestion,
  type Answers,
  type AssessmentKey,
  type Narrative,
  type QuestionDef,
} from '@marchmaker/shared';
import type { AppContext } from '../context';
import { emit } from '../lib/audit';
import { AppError, notFound } from '../lib/errors';
import { AssessmentDefinition, AssessmentResponse } from '../models/assessment';
import { FeatureFlag } from '../models/core';

const DAY = 86_400_000;

export interface Definition {
  key: AssessmentKey;
  version: number;
  title: string;
  description: string;
  minutes: number;
  dimensions: string[];
  questions: QuestionDef[];
}

function asKey(raw: string): AssessmentKey {
  if (!(ASSESSMENT_KEYS as readonly string[]).includes(raw)) throw notFound('That assessment does not exist');
  return raw as AssessmentKey;
}

/** Latest active definition from the database; the bundled bank is used on a fresh install. */
export async function getDefinition(rawKey: string): Promise<Definition> {
  const key = asKey(rawKey);
  const doc = await AssessmentDefinition.findOne({ key, active: true }).sort({ version: -1 }).lean();
  if (doc) {
    return {
      key,
      version: doc.version,
      title: doc.title,
      description: doc.description ?? '',
      minutes: doc.minutes ?? 5,
      dimensions: doc.dimensions,
      questions: doc.questions as QuestionDef[],
    };
  }
  const bank = ASSESSMENT_BANKS.find((b) => b.key === key);
  if (!bank) throw notFound();
  return { ...bank, version: 1 };
}

/** The definition a stored response was answered against (versions are immutable). */
async function definitionAt(key: AssessmentKey, version: number): Promise<Definition> {
  const doc = await AssessmentDefinition.findOne({ key, version }).lean();
  if (doc) {
    return {
      key,
      version,
      title: doc.title,
      description: doc.description ?? '',
      minutes: doc.minutes ?? 5,
      dimensions: doc.dimensions,
      questions: doc.questions as QuestionDef[],
    };
  }
  return getDefinition(key);
}

type Status = 'not_started' | 'in_progress' | 'completed';

export async function listForMember(userId: string) {
  const out = [];
  for (const key of ASSESSMENT_KEYS) {
    const def = await getDefinition(key);
    const [inProgress, lastDone] = await Promise.all([
      AssessmentResponse.findOne({ userId, key, status: 'in_progress' }).lean(),
      AssessmentResponse.findOne({ userId, key, status: 'completed' }).sort({ completedAt: -1 }).lean(),
    ]);
    const status: Status = inProgress ? 'in_progress' : lastDone ? 'completed' : 'not_started';
    const retakeAt = lastDone?.retakeAvailableAt ?? null;
    out.push({
      key,
      title: def.title,
      description: def.description,
      minutes: def.minutes,
      questionCount: def.questions.length,
      status,
      answered: inProgress ? answeredCount(def.questions, (inProgress.answers ?? {}) as Answers) : 0,
      completedAt: lastDone?.completedAt ?? null,
      retakeAvailableAt: retakeAt,
      canStart: status !== 'completed' || !retakeAt || retakeAt <= new Date(),
    });
  }
  return out;
}

export async function getForMember(userId: string, rawKey: string) {
  const key = asKey(rawKey);
  const inProgress = await AssessmentResponse.findOne({ userId, key, status: 'in_progress' }).lean();
  const def = inProgress ? await definitionAt(key, inProgress.version) : await getDefinition(key);
  const answers = (inProgress?.answers ?? {}) as Answers;
  return {
    key,
    version: def.version,
    title: def.title,
    description: def.description,
    questions: def.questions.map(toPublicQuestion),
    answers,
    resumeIndex: resumeIndex(def.questions, answers),
    status: (inProgress ? 'in_progress' : 'not_started') as Status,
  };
}

async function openAttempt(userId: string, key: AssessmentKey) {
  const existing = await AssessmentResponse.findOne({ userId, key, status: 'in_progress' });
  if (existing) return existing;

  const last = await AssessmentResponse.findOne({ userId, key, status: 'completed' }).sort({ completedAt: -1 });
  if (last?.retakeAvailableAt && last.retakeAvailableAt > new Date()) {
    throw new AppError(409, 'RETAKE_NOT_AVAILABLE', 'You can retake this assessment later', {
      retakeAvailableAt: last.retakeAvailableAt,
    });
  }
  const def = await getDefinition(key);
  try {
    return await AssessmentResponse.create({ userId, key, version: def.version, answers: {} });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const again = await AssessmentResponse.findOne({ userId, key, status: 'in_progress' });
      if (again) return again;
    }
    throw err;
  }
}

export async function saveAnswers(userId: string, rawKey: string, patch: Answers) {
  const key = asKey(rawKey);
  const attempt = await openAttempt(userId, key);
  const def = await definitionAt(key, attempt.version);
  const byId = new Map(def.questions.map((q) => [q.id, q]));

  for (const [qid, value] of Object.entries(patch)) {
    const q = byId.get(qid);
    if (!q) throw new AppError(422, 'VALIDATION_ERROR', `Unknown question ${qid}`);
    if (!isValidAnswer(q, value)) throw new AppError(422, 'VALIDATION_ERROR', `That answer is not valid for ${qid}`);
  }
  const merged = { ...((attempt.answers ?? {}) as Answers), ...patch };
  await AssessmentResponse.updateOne({ _id: attempt._id, status: 'in_progress' }, { $set: { answers: merged } });
  return {
    answered: answeredCount(def.questions, merged),
    total: def.questions.length,
    resumeIndex: resumeIndex(def.questions, merged),
  };
}

export async function completeAssessment(ctx: AppContext, userId: string, rawKey: string) {
  const key = asKey(rawKey);
  const attempt = await AssessmentResponse.findOne({ userId, key, status: 'in_progress' });
  if (!attempt) throw new AppError(409, 'NOT_IN_PROGRESS', 'There is no assessment in progress to finish');
  const def = await definitionAt(key, attempt.version);
  const answers = (attempt.answers ?? {}) as Answers;
  const done = answeredCount(def.questions, answers);
  if (done < def.questions.length) {
    throw new AppError(422, 'ASSESSMENT_INCOMPLETE', 'A few questions are still unanswered', {
      remaining: def.questions.length - done,
      resumeIndex: resumeIndex(def.questions, answers),
    });
  }

  const scores = scoreAnswers(def.questions, answers);
  const bands = Object.fromEntries(Object.entries(scores).map(([d, s]) => [d, bandFor(s)]));
  let narrative: Narrative = buildNarrative(key, scores);

  const flag = await FeatureFlag.findOne({ key: 'llm_narratives' }).lean();
  if (flag?.enabled && ctx.narrativeRewriter) {
    narrative = await rewriteNarrative(narrative, ctx.narrativeRewriter);
  }

  const now = new Date();
  const claimed = await AssessmentResponse.findOneAndUpdate(
    { _id: attempt._id, status: 'in_progress' },
    {
      $set: {
        status: 'completed',
        dimensionScores: scores,
        bands,
        narrative,
        completedAt: now,
        retakeAvailableAt: new Date(now.getTime() + DEFAULTS.assessmentRetakeDays * DAY),
      },
    },
    { returnDocument: 'after' },
  );
  if (!claimed) return resultFor(userId, key); // a concurrent request finished it
  await emit('assessment.completed', { userId, key, version: attempt.version });
  return resultFor(userId, key);
}

/** Member-facing result: words only. No dimension scores, bands or numbers. */
export async function resultFor(userId: string, rawKey: string) {
  const key = asKey(rawKey);
  const done = await AssessmentResponse.findOne({ userId, key, status: 'completed' }).sort({ completedAt: -1 }).lean();
  if (!done) throw notFound('You have not completed this assessment yet');
  const n = done.narrative as Narrative;
  return {
    key,
    title: n.title,
    summary: n.summary,
    sections: n.sections.map((s) => ({ heading: s.heading, body: s.body })),
    closing: n.closing,
    completedAt: done.completedAt,
    retakeAvailableAt: done.retakeAvailableAt ?? null,
  };
}

/**
 * Internal use only (matching in Phase 8, staff views in Phase 7): the latest completed
 * dimension vectors for a member. Must never be passed to a member-facing response.
 */
export async function dimensionVectors(userId: string): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const key of ASSESSMENT_KEYS) {
    const done = await AssessmentResponse.findOne({ userId, key, status: 'completed' }).sort({ completedAt: -1 }).lean();
    if (done?.dimensionScores) out[key] = done.dimensionScores as Record<string, number>;
  }
  return out;
}

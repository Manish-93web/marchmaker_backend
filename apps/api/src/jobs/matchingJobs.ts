import type { AppContext } from '../context';
import { Setting } from '../models/core';
import { runMatching, type RunSummary } from '../services/matching';
import { releaseDueMatches } from '../services/matchReview';

import { expireAndRemind } from '../services/introductions';

export { releaseDueMatches, runMatching, expireAndRemind };

const DAY = 86_400_000;

/** Nightly full run. Safe to call often: it only runs if the last full run is over a day old. */
export async function runNightlyIfDue(ctx: AppContext, now: Date = new Date()): Promise<RunSummary | null> {
  const last = await Setting.findOne({ key: 'matching.lastFullRun' }).lean();
  const at = (last?.value as { at?: string } | undefined)?.at;
  if (at && now.getTime() - new Date(at).getTime() < DAY) return null;
  const summary = await runMatching(ctx, { now });
  await Setting.updateOne({ key: 'matching.lastFullRun' }, { $set: { value: { at: now.toISOString() } } }, { upsert: true });
  return summary;
}

/** On-demand run when one member's situation changes (profile approved, verified, restored). */
export async function runForMember(ctx: AppContext, userId: string): Promise<RunSummary> {
  return runMatching(ctx, { onlyUserIds: [userId] });
}

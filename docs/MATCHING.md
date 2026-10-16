# Matching and human review

Nothing reaches a member without a person approving it. The engine only **proposes**; reviewers decide.

Pure, deterministic code lives in `packages/shared/src/matching.ts` (no I/O, no randomness, no clock reads) and is unit-tested. Loading data, persistence and the review workflow live in `apps/api/src/services/matching.ts` and `matchReview.ts`.

## 1. Who can be matched

A member is in the pool only if all of these hold:

- account `active`, journey `matching_active` (so verified and not paused or suspended)
- ID verified
- profile `approved`
- at least one `approved` photo

## 2. Hard filters (never traded off)

- Different genders, or either is non-binary. There is no "seeking" field yet (D-033).
- Not blocked either way, not previously introduced in any outcome, not previously rejected or already being reviewed.
- Neither member already has `maxOpenIntroductions` (default 2) open.
- **Every must-have, in both directions.** Member A's must-haves must be met by B *and* B's by A.
  - An unknown value fails a must-have (it cannot be confirmed). It never fails a flexible preference.
  - A target answering "open" to children satisfies a must-have of yes or no (configurable). A target with a "flexible" marriage timeline satisfies any timeline.
  - Ranges are inclusive. Location accepts a city or a state.

## 3. Ranking

`score = (wP * preferences + wA * assessments + wL * plans) / (wP + wA + wL)`, then adjusted for availability and fairness.

| Signal | How it is computed |
|---|---|
| **preferences** | For each direction: importance-weighted share of *flexible* preferences met (unknown counts half; no flexible preferences gives 0.5). The two directions are combined with the **harmonic mean**, so a one-sided fit scores poorly. |
| **assessments** | Mean over shared dimensions of `1 - |a - b|`. For dimensions listed as complementary, `1 - |a + b - 1|` (best when opposite). No shared dimensions gives 0.5 and `assessmentsMissing`. |
| **plans** | Mean of: marriage timeline (same 1.0, adjacent 0.6, far 0.2, flexible 0.8), children and living-with-family (same 1.0, either open 0.6, conflict 0), location (same city 1.0, same state 0.6, else 0.2), family set-up (same 1.0, else 0.6). |
| **availability** | Least-recently-active member: active within 7 days 1.0, 30 days 0.9, else 0.75. Multiplied by a small load factor (0.95 per open introduction held, up to two). |
| **fairness** | Additive boost for the member who has waited longest, rising linearly to `fairnessMaxBoost` (0.10) after `fairnessAfterDays` (30). Waiting starts at verification or the last introduction. |

Scores are rounded to three decimals and capped at 1. A pair is proposed only if it clears `minScore` (0.55).

### Per-member cap

Every qualifying pair is gathered once, sorted by score then pair key, and accepted greedily while **both** members are under `topN` (default 5). Pairs a person is already working on count toward the quota. So no member is ever attached to more than `topN` suggestions, regardless of which side proposed the pair.

## 4. Reasons

Each suggestion stores machine-readable reasons (`same_city`, `shared_timeline`, `assessment_similar` + dimension...). `reasonSentences` turns them into plain sentences with no numbers; the console pre-fills "Why we introduced you" from them. The reviewer edits it, and `whyTextProblems` rejects phone numbers, links, email addresses, scores and percentages.

## 5. When it runs

- Nightly full run (the worker checks every 10 minutes and runs if the last full run is over 24 hours old). A full run also clears `suggested` pairs that no longer qualify.
- On demand for one member when their situation changes: profile approved, verification approved, photo approved, account restored.
- Manually from the console (**Run matching now**).

Re-running is safe: pairs a person has touched are never overwritten.

## 6. Review states

`suggested -> in_review -> approved | rejected | snoozed | escalated`

| Action | Effect |
|---|---|
| Open | Claims a `suggested` item for the reviewer (limited by `matchmakerDailyCapacity`, counted per IST day) |
| Approve | Needs a confirmation and a valid why-text. Sets `releaseAt = now + cooloffMinutes`. |
| Undo | Allowed until release; returns the item to `in_review` and clears approvals |
| Reject | Reason code + note. The pair is never proposed again. |
| Snooze | 1 to 30 days; returns to `suggested` automatically |
| Escalate | Another reviewer must decide; the person who escalated cannot close it |

**Two-person rule:** if either member is flagged (moderators set it, or a past restriction exists), the first approval leaves the item `in_review`; a *different* reviewer must approve before it is scheduled.

**Queue order:** highest plan first (Concierge, Premium, Essential, Free), then longest waiting. Items past `reviewSlaHours` are marked as breached. Staff see a fit band (strong, good, possible), not a percentage.

## 7. Release

A job (every minute) releases approved matches whose cool-off has ended. Immediately before creating the `introduction` it re-checks that:

- neither member has blocked the other or been suspended, paused or left matching;
- the pair has not already been introduced;
- neither member has filled their open slots (the item returns to review instead of being lost).

A pair can only ever produce one introduction (unique pair key). The introduction's lifecycle (accept, decline, expiry, unlock) is Phase 9.

## 8. Manual introductions

A matchmaker can pair two members directly. Safety exclusions still apply (blocked, already introduced, not matchable) but unmet must-haves are allowed and **recorded as overrides** on the suggestion, with a mandatory reason. The two-person rule applies.

## 9. Configuration

Admin Settings (`settings.manage`): weights, `minScore`, `topN`, `maxOpenIntroductions`, `fairnessMaxBoost`, `fairnessAfterDays`, complementary dimensions, openness rule; and review settings: `cooloffMinutes`, `introExpiryDays`, `matchmakerDailyCapacity`, `reviewSlaHours`. Every change is audited with before and after.

## 10. Known limits

- The run is O(n^2) in the pool size with an in-memory pool. Fine to a few thousand members; see `docs/SCALING.md` for the pre-filtering plan before 100k.
- Match-quality feedback (Phase 14) is not yet fed into the weights.
- No geocoded distance: location is city/state equality.

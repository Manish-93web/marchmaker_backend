# Compatibility assessments

Six short assessments (8 to 11 questions each): `values`, `communication`, `family`, `finances`, `lifestyle`, `faith`.
Results are written in words. Numbers exist only as internal dimension vectors used by matching and staff views.

## Data

| Collection | Purpose |
|---|---|
| `assessmentdefinitions` | Versioned question banks. Editing publishes a new version; nothing is mutated in place. Seeded from `@marchmaker/shared` (`ASSESSMENT_BANKS`). |
| `assessmentresponses` | One document per attempt. Holds answers, internal `dimensionScores` (0..1), `bands`, the written `narrative`, `completedAt`, `retakeAvailableAt`. A partial unique index allows one in-progress attempt per member and assessment. |

A member who started on version N keeps answering version N even if N+1 goes live. Completed results keep the version they were answered against.

## Question types

| Type | Scoring |
|---|---|
| `likert` (1 to 5) | `(a-1)/4` on the question's dimension; `reverse: true` flips it |
| `single_choice` | The chosen option's internal `value` (0..1) |
| `ranking` | Each item's dimension gets `1 - position/(n-1)`: higher rank, higher score |

A dimension's score is the mean of its contributions, rounded to two decimals. Bands: low below 0.34, mid below 0.67, otherwise high.

## What a member can see

`GET /assessments/:key` returns prompts and options only. `value`, `dimension` and `reverse` are stripped (`toPublicQuestion`, tested).
`GET /assessments/:key/result` returns title, summary, sections (heading and body), closing and dates. There are no scores, bands or dimension keys, and a test asserts the written text contains no digits.

Staff and matching read vectors through `dimensionVectors(userId)` only. The data export includes answers and the written result, but not scores.

## Narrative engine

`buildNarrative(key, scores)` selects a sentence per dimension from `NARRATIVE_TEXT[assessment][dimension][band]`.
Copy rules: second person, warm, no numbers, no judgement, neither end of a spectrum framed as better.

### Optional LLM rewriting (off by default)

Enabled only when the `llm_narratives` feature flag is on and `OPENAI_API_KEY` is set.

- Only the template paragraph, its heading and the assessment title are sent. No member id, name, answers or scores.
- The system prompt forbids new facts, advice, comparison and numbers.
- Every returned paragraph passes `isSafeRewrite`: length within 0.4x to 1.6x, no digits, no rating or comparison words, no markup. A paragraph that fails keeps its template text; a provider error falls back to the full template.
- The stored narrative records `source: "template" | "rewritten"`.

## Retake

`retakeAvailableAt` is set to 90 days after completion (`DEFAULTS.assessmentRetakeDays`). Answering before then returns 409 `RETAKE_NOT_AVAILABLE` with the date. After it, a new attempt starts; the latest completed attempt is the one in use.

## Editing question banks

Admin editing arrives in Phase 7 (content management). Until then banks change by seeding a new version.

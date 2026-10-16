# Safety, moderation and support

## Reports and moderation

A member report creates a `Report` with a severity taken from its category and a response deadline (SLA): critical 1 h, high 4 h, medium 24 h, low 72 h. Critical reports also emit `safety.critical_report`, which emails the on-call address immediately (Phase 11).

**Queue** (`moderation.view`): open and investigating reports sorted by severity, then overdue first, then oldest. Each row shows how many *different* people have reported the same member.

**Case** shows: the reporter's words, the reported member's summary, signals (distinct reporters, other reports, earlier warnings and suspensions), earlier actions, and the frozen conversation copy (last 30 messages).

- The conversation is only returned to people with `messages.view_reported`. Everyone else sees that it exists. **Each view is written to the audit log.**
- A report is claimed atomically (`moderation.act`); nobody else can act on it while it is claimed.

**Actions** (reason always required, recorded in `ModerationAction` and the audit log):

| Action | Effect |
|---|---|
| dismiss | Report closed. The reporter is told only that it was reviewed. |
| warn | Member sees the written message (kind, specific, no reporter detail) in Help and as a critical notification. |
| suspend | Uses the audited status path: account suspended, all sessions ended. Needs `member.suspend`. |
| ban | Same, needs `member.ban`. Staff accounts cannot be banned here. |
| escalate | Back to the queue flagged. Whoever escalated cannot close it. |

The reporter's follow-up (`report.resolved`) is always the same neutral sentence, whatever the outcome.

## Appeals

A suspended or banned member cannot sign in, so `POST /appeals` is public (rate limited, honeypot). The answer is identical whether or not the email belongs to an account, so it cannot be used to discover members. An appeal is recorded only for suspended or banned accounts and only one can be pending.

A reviewer cannot be the person who took the original action. **Overturn** restores the account through the normal status path and emails the member; **uphold** emails the decision. Both write to the audit log and moderation history.

## Support tickets

- Created by members (`/support/tickets`) and by the public contact form (general, support, grievance topics). Grievances start as high priority.
- Numbered `T-000001` from a counter; first-response target 24 h (normal) or 4 h (high); billing and safety start as high.
- Staff (`support.view` / `support.reply`) get an inbox with views for mine, unassigned, overdue and all; internal notes are never returned to the member; saved replies speed up common answers.
- A reply notifies a signed-in member in-app (grouped by ticket); a visitor without an account gets it by email.
- Housekeeping: resolved tickets close after 7 days, tickets waiting on a member after 14.

## Safety guidance for members

The Help page shows short safety tips (never send money, stay in the app, meet in public, report anything wrong). The report and block controls from Phase 9 remain on every introduction.

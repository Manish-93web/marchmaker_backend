# Admin console

Separate app (`marchmaker_frontend/apps/admin`, `noindex`) calling `/api/v1/admin/*`. Every endpoint needs a TOTP-verified session and a specific permission.

| Area | Permission | Notes |
|---|---|---|
| Dashboard | `metrics.view` | Queue sizes, oldest waiting profile |
| Members search | `member.search` | Name, email prefix, phone, city, id; status/verified filters; cursor paging; staff never listed |
| Member detail | `member.view_basic` or `member.view_full` | Basic: overview, verification summary. Full: profile, preferences, **internal assessment scores**, photos (access audited) |
| Suspend / pause / restore | `member.suspend` | Reason required; ends sessions on suspend; remembers where the member was |
| Ban | `member.ban` | Separate permission |
| Notes | `member.notes` | Author or moderator can edit or delete |
| View as member | `member.impersonate_view` | Read-only, issues no session, audited |
| Profile review | `profile.review` | Approve, request changes (with step hints), reopen approved |
| Photo review | `photo.review` | Approve or reject with a reason; main photo reassigned |
| Verification | `verification.view_evidence` / `verification.decide` | See docs/KYC.md; every evidence view audited |
| Match review | `match.review` / `match.approve` / `match.create_manual` | Queue by plan then waiting time; side-by-side compare; approve with an editable why-text, reject, snooze, escalate; undo inside the cool-off; two-person rule; manual pairing. See docs/MATCHING.md |
| Matching settings | `settings.manage` | Weights, limits, undo window, SLA. Audited with before/after |
| Audit log | `audit.view` | Filters, paging, CSV export (formula-safe, and the export itself is audited) |
| Team | `admin_users.manage` | Invite by single-use link; only a super admin grants admin roles; last super admin protected |
| Roles | `roles.manage` | Matrix editor; takes effect within seconds; `super_admin` fixed |
| Feature flags | `flags.manage` | Audited |
| Question banks | `content.manage` | Publishes a new immutable version |

## Keyboard

- `Ctrl/Cmd+K`: command palette (jump to a page, or search members for the typed text)
- Profile review: `a` approve, `c` request changes
- Photo review: focus a photo, then `a` approve or `r` reject
- Match review: `a` approve, `r` reject, `s` snooze, `e` escalate (each opens a confirmation)

## Not yet in the console

Introductions monitor (Phase 9), billing, plans and coupons (10), notification templates (11), reports and support inbox (12), referrals and wallet (13), content CMS, success stories and legal documents editors (15), job queue viewer (16). The member data export and deletion approvals screen is also pending.

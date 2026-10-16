# Growth and insight

## Two kinds of numbers

1. **Operational metrics** (funnel, review times, revenue, retention, backlogs) are computed from data we already hold to run the service: journey transitions, introductions, payments, reports, tickets. They are aggregates for staff and need no consent. They are cached for 5 minutes.
2. **Behavioural analytics** (page views, clicks, experiment exposure) exist only for people who said yes to analytics.

## Behavioural analytics

- The browser calls `track()`, which does nothing unless the visitor's consent choice allows analytics. Declining also deletes the browser's anonymous id.
- `POST /analytics/events` requires `consent: true` and a known event name. **Signed-in members' stored consent is checked on the server**, so withdrawing it takes effect immediately.
- Only an allow list of property keys (`path`, `step`, `plan`, `interval`, `cta`, `variant`, `experiment`, `feature`, `source`) with short, URL-safe values is stored. Anything else, including anything that looks like an email or free text, is dropped before storage.
- Page paths are stored without query strings, and 24-character ids are collapsed to `:id`.
- Events carry an anonymous browser id; for signed-in members a keyed hash of the member id (never the id). Events expire after 400 days (TTL index).
- Rate limited per IP; batches of at most 20.

## Metrics (`GET /admin/metrics`, `metrics.view`)

| Block | How it is computed |
|---|---|
| Funnel | Cohort = members registered in the range. Each step counts distinct cohort members with a matching journey transition, an introduction, or a payment. |
| Review times | Pairs a submission transition with the next decision for the same member: median and 90th percentile in hours. |
| Backlog | Live counts: profiles and verifications waiting, suggestions in queue, reports and tickets open and overdue. |
| Revenue | Captured payments in the range, minus refunds; paying members, average per payer, monthly recurring revenue from active subscriptions at plan price. |
| Introductions | Suggestion approval rate; introduction mutual, decline and expiry rates. |
| Retention | Weekly cohorts of members who became ready for introductions; share active in week 1, 2 and 4 (from `ActiveDay`, one row per member per India day, written at sign-in and refresh). Weeks that have not finished show no figure. |

## Feedback loop

- A week after an introduction unlocks, each member gets one check-in (`feedback.checkin`); a marker per member and introduction makes it once-only. The sheet asks for a 1 to 5 fit rating, up to four tags and an optional note. The other person never sees it.
- The member's own decline reasons are tallied. After three of the same reason (excluding "prefer not to say") the dashboard offers a **suggestion** to review preferences. Nothing changes automatically.
- Staff see the same tally, ratings and notes on `GET /admin/members/:id/feedback` to help a matchmaker choose better.

## Success stories

A member submits names, a few sentences and two confirmations (theirs and their partner's). The story stays private. Staff must confirm they spoke to the partner before publishing; staff may lightly edit wording, and the original is kept. Publishing sets the consent date the public endpoint requires. A member can withdraw at any time, which removes it from the site immediately.

## Experiments

An experiment has a key, 2 to 5 variants and weights. Assignment is a pure function (`FNV-1a(key:subject)`), so the same visitor or member always sees the same variant, nothing is stored per person, and different experiments do not correlate. Exposure is logged as an analytics event (so only consenting visitors are counted). Managed with `flags.manage`; every change is audited.

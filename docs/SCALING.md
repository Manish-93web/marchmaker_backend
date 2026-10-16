# Scaling notes

## Now (to a few thousand members)

One API process, one worker, one MongoDB. Matching loads the whole eligible pool in memory and ranks every pair.

## Towards 100k members

| Area | Plan |
|---|---|
| API | Stateless replicas behind a load balancer. Move rate-limit and attempt counters to Redis (interfaces already exist). |
| Database | Atlas scale-up, replica reads for analytics and the audit explorer, indexes already declared on every query path used so far. |
| Matching | Pre-filter candidates in the database by gender, birth-year window and the must-have fields (the filter builder in `services/preferences.ts` already maps dimensions to document paths), shard the run by city or state, process in batches. Keep the pure scoring function unchanged. |
| Queues | BullMQ with several worker replicas; the outbox relay claims rows atomically so replicas do not double-publish. |
| Assets | Photos and evidence are served only by short-lived signed URLs from object storage, so the API never proxies bytes. |
| Caching | Redis for reference data (plans, flags, permission mapping). |
| Archiving | Move old `outbox`, `stateTransitions` and `webhookEvents` to cold storage after 90 days. |

## Load tests

k6 scripts for matching and the admin queues are written in Phase 16.

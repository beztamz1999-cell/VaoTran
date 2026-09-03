# Recovery Drill and Configuration Checklist

Before a production recovery drill, execute `npm run ops:validate-production-config`. Development and test environments may retain their documented actor simulation and deterministic analytics fallback; production may not. The validator requires database connectivity configuration, internal-operation token and allowlist, a non-development analytics salt, and `ALLOW_DEV_ACTOR_HEADER` not set to `true`.

| Drill | Expected result | Stop condition |
|---|---|---|
| Readiness | `/health/ready` reports database readiness. | Database unavailable. |
| Compatibility | `python3 scripts/ci/validate-m14-contract-compatibility.py` reports no removed protected paths/events. | Any `missing_paths` or `missing_events`. |
| Replay safety | Dry-run returns the event without mutation; execute only queues retryable/dead-letter events and writes audit evidence. | State is not eligible or event scope is uncertain. |
| Consumer recovery | A pre-recorded delivery is not handled twice after replay. | Consumer behavior cannot prove idempotency. |

> If data integrity is uncertain, stop automatic recovery. Preserve correlation IDs, event IDs, audit rows, and worker logs for incident review; do not force completion, capacity, attendance, reliability, or ranking changes.

# Outbox Replay Runbook

Replay is a **bounded operational command**, not a way to alter canonical business data. The utility only queues an event whose persisted state is `FAILED_RETRYABLE` or `DEAD_LETTER`; all other states receive an audited `NOT_ACTIONABLE` result.

| Step | Required action | Evidence |
|---|---|---|
| 1. Identify | Capture event ID, event type, aggregate, error, consumer and correlation ID. | Incident/ticket reference. |
| 2. Dry-run | Run `pnpm ops:replay-event -- --event-id <id> --operator-id <operator>`. | Output says whether persisted state is executable. |
| 3. Approve | Confirm consumer fix and scope; do not modify payload or source facts. | Named approved operator. |
| 4. Execute | Add `--execute`; production also requires `--confirm-production`. | `internal_operation_audits` record with operator and correlation. |
| 5. Verify | Run worker and confirm consumer delivery/de-duplication evidence. | Event reaches `PUBLISHED` or is re-triaged. |

The command defaults to dry-run. It never creates a new domain event, changes Room/Application/Participant state, or deletes a dead-letter record.

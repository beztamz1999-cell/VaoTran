# Ownership, SLO, and Escalation

M14-D assigns operational responsibility without changing application authorization, Room lifecycle, capacity, ranking, or reliability rules. The **service owner** owns configuration and deployment health; the **on-call operator** triages outbox/replay alerts; the **domain owner** approves any action that could require a product-policy decision.

| Signal | Baseline objective | First response | Escalate when |
|---|---|---|---|
| Outbox lag | Pending events remain within the configured worker interval under normal load. | Inspect worker health and event correlation. | Lag persists across two worker intervals. |
| Dead letter | Every dead-letter event has a triage record before replay. | Identify producer, consumer, aggregate and error. | Affected lifecycle completion or repeated consumer failure. |
| Replay | Every execute-mode replay has operator, correlation and audit evidence. | Use dry-run first and replay only eligible state. | Event is not retryable or scope requires policy change. |
| Readiness | `/health/ready` remains available before traffic is shifted. | Validate database and deployment config. | Readiness is unavailable or data integrity is in doubt. |

> Operators may restart workers and queue an eligible outbox event. They may not edit payloads, force Room transitions, bypass attendance/rating eligibility, or change capacity facts.

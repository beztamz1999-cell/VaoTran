# Lifecycle Event Registry

This registry protects the v1 event names emitted through the transactional outbox. Consumers must treat delivery as **at-least-once** and use `event_id` for de-duplication. Payload additions are additive; removing or reinterpreting a named event requires a versioned migration plan.

| Event | Aggregate | Operational contract |
|---|---|---|
| `ROOM_PUBLISHED` | Room | Room became discoverable. |
| `JOIN_REQUEST_CREATED` | RoomApplication | Application request persisted. |
| `JOIN_REQUEST_ACCEPTED` | RoomApplication | Accepted membership and canonical participant write succeeded. |
| `ROOM_MANUALLY_STARTED` | Room | HOST start command completed. |
| `PLAYER_NO_SHOW` | RoomParticipant | Attendance state changed after canonical grace enforcement. |
| `ROOM_COMPLETED` | Room | Terminal completion command completed. |
| `RATING_SUBMITTED` | SkillRating | Eligible rating was stored. |

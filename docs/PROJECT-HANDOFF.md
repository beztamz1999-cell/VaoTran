# VàoTrận — Project Handoff

Snapshot: 2026-09-04 · Scope: private alpha

Tài liệu này là điểm bắt đầu cho người tiếp quản. Nó mô tả source hiện tại, API canonical, quy tắc nghiệp vụ, dữ liệu, client Expo, môi trường đang chạy và các việc cần lưu ý. Không chứa secret, token hay dữ liệu người dùng thật.

## 1. Tóm tắt sản phẩm

VàoTrận là ứng dụng tìm, tạo và quản lý trận thể thao cộng đồng, hiện ưu tiên cầu lông. Người dùng có thể tạo tài khoản, tìm trận, gửi yêu cầu tham gia; HOST duyệt người chơi, bắt đầu trận, điểm danh và hoàn tất trận. Hệ thống còn có party/friend/guest, độ tin cậy, xếp hạng kỹ năng, chia sẻ trận, notification và analytics vận hành.

Backend là modular monolith Node.js/Express/PostgreSQL. Client là Expo Router/React Native chạy Android, iOS và Expo Web. Backend luôn là authority cho capacity, eligibility, lifecycle và permission; client chỉ hiển thị DTO và gửi command.

## 2. Trạng thái hiện tại

| Thành phần | Trạng thái / phiên bản |
| --- | --- |
| Backend | TypeScript, Node >= 22, Express 5, PostgreSQL `pg`, Zod, Pino, Argon2 |
| Database | PostgreSQL 16, migrations `001` đến `014` |
| Authentication | Opaque Bearer session thực; token chỉ lưu hash SHA-256 tại DB |
| Client | Expo SDK 57, Expo Router, React Native 0.86, TypeScript |
| UI | Consumer sports UI xanh/trắng; design tokens và reusable components đã được tách |
| Private alpha runtime hiện tại | PostgreSQL `127.0.0.1:5434`, API `:3000`, Expo Web `:8081` |
| Web URL hiện tại | `http://localhost:8081/` |
| LAN API / Expo | API `http://192.168.1.68:3000`; Expo `exp://192.168.1.68:8081` |

Quy trình E2E backend dùng user/session thật đã xác nhận: register → `/me` → tạo/publish room → player request → host accept → start → attendance → complete → logout/revoke session. UI Web đã build/export và render được các màn auth mới.

## 3. Cấu trúc mã nguồn

```text
D:\APP VAOTRAN
├─ src/
│  ├─ server.ts                         # Composition root + HTTP server + worker/scheduler
│  ├─ platform/
│  │  ├─ core.ts                        # Environment config, logger, DomainError
│  │  ├─ http/app.ts                    # Express routes, DTO, Zod schemas, CORS
│  │  ├─ auth/context.ts                # Bearer session resolver/AuthContext
│  │  ├─ database/{db,migrate,seed}.ts
│  │  ├─ idempotency.ts
│  │  ├─ outbox/outbox.ts
│  │  ├─ observability/{metrics,readiness}.ts
│  │  └─ analytics, operations/
│  ├─ modules/
│  │  ├─ auth, identity, room, participation, search
│  │  ├─ reliability, ranking, party, notification
│  │  ├─ operations, analytics
│  └─ tests/                            # Unit + PostgreSQL integration tests
├─ migrations/                          # 001…014 up/down SQL
├─ docs/
│  ├─ openapi.yaml                      # API contract index canonical
│  ├─ events/LIFECYCLE-EVENT-REGISTRY.md
│  └─ operations/                       # Recovery/outbox/SLO runbooks
├─ mobile/
│  ├─ src/app/index.tsx                 # Current application shell/screens
│  ├─ src/lib/api.ts                    # Typed client adapter
│  ├─ src/lib/session.ts                # SecureStore native + in-memory web adapter
│  ├─ src/theme/index.ts                # UI tokens
│  └─ src/components/ui/app-ui.tsx      # Shared primitives
└─ docs/PROJECT-HANDOFF.md              # This document
```

The client still contains unreferenced Expo template artifacts such as `src/app/explore.tsx` and older themed components. They are not part of the active VàoTrận UI. Do not mistake them for production screens.

## 4. Architecture and runtime

### Request path

```text
Expo UI
  → mobile/src/lib/api.ts
  → HTTP /api/v1 + Bearer token + Idempotency-Key (mutations)
  → Express app / Zod validation / AuthContext
  → domain service + PostgreSQL transaction
  → event_outbox + read projections
  → background consumers / notification / analytics
```

Success responses use `{ "data": ... }`. Domain and validation errors use `{ "error": { "code", "message", "details" } }`. HTTP error code mapping lives in `src/platform/core.ts`.

### Server-owned background work

`src/server.ts` starts these workers in the same API process:

- outbox consumer every 2 seconds: notification + analytics projection;
- push delivery worker;
- automatic room start scheduler;
- refill expiry scheduler;
- notification reminder scheduler;
- reconciliation scheduler, detection-only;
- analytics validation scheduler, detection-only.

They stop before the HTTP server and database pool during `SIGINT`/`SIGTERM`. Do not run multiple API instances in production without first introducing an explicit worker lease/ownership strategy.

### Core config

Required/important environment variables:

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL; required to use the API |
| `PORT` | API port, default `3000` |
| `NODE_ENV` | Use `development` locally; `test` enables test behavior |
| `CORS_ALLOWED_ORIGINS` | Comma-separated exact browser origins, no wildcard |
| `ALLOW_DEV_ACTOR_HEADER` | Must be `false` for private alpha; compatibility mode only |
| `AUTH_SESSION_TTL_DAYS` | Opaque session expiry, default 30 |
| `IDEMPOTENCY_TTL_HOURS` | Response retention for critical mutation replay, default 24 |
| `INTERNAL_OPS_TOKEN` / `INTERNAL_OPS_ALLOWLIST` | Required pair for `/internal/*` operations |
| `ANALYTICS_HASH_SALT` | Stable secret required in production for HMAC pseudonyms |
| `*_INTERVAL_MS`, `SLOW_QUERY_MS` | Scheduler and observability tuning; see `.env.example` and `core.ts` |

For the currently running local private-alpha process, use this shape if it needs restarting:

```powershell
$env:DATABASE_URL='postgresql://vaotran_verifier@127.0.0.1:5434/vaotran_verification'
$env:PORT='3000'
$env:NODE_ENV='development'
$env:ALLOW_DEV_ACTOR_HEADER='false'
$env:CORS_ALLOWED_ORIGINS='http://localhost:8081,http://192.168.1.68:8081'
node dist/server.js
```

The root `.env` is deliberately absent/ignored. Do not commit passwords, tokens, local IP-specific config, `.verification-postgres`, `.expo`, export folders or logs.

## 5. Authentication, session, CORS

### Authentication contract

- `POST /api/v1/auth/register` accepts `email`, `password` (10–256 chars), `display_name`, `phone`; returns a user and opaque `access_token` with expiry.
- `POST /api/v1/auth/login` accepts email/password; returns the same session envelope.
- All private product routes require `Authorization: Bearer <opaque-token>`.
- Session lookup hashes the supplied token, rejects revoked/expired sessions and inactive users, then updates `last_used_at`.
- `POST /api/v1/auth/logout` revokes the current session and returns `204`.
- `X-Actor-User-Id` is disabled for private alpha. It is only a deliberately enabled development/test fallback, never a credential.

### Client storage

Native Android/iOS uses `expo-secure-store` via `mobile/src/lib/session.ts`. Expo Web has no compatible SecureStore implementation in this runtime: it stores the token only in memory. A browser refresh therefore requires login again; this intentionally avoids writing bearer tokens to plaintext web storage.

### CORS

The server only emits `Access-Control-Allow-Origin` when the request origin exactly occurs in `CORS_ALLOWED_ORIGINS`. It permits `GET, POST, PATCH, PUT, DELETE, OPTIONS` and `Content-Type, Authorization, Idempotency-Key, X-Correlation-Id`. This was required to fix Web register preflight from Expo Web to the LAN API. Keep the allowlist explicit; do not use `*`.

## 6. Product rules and lifecycle

### Capacity invariant

```text
host_slot = host_participates ? 1 : 0

available_public_slots =
  capacity - host_slot - reserved_external_count - active_accepted_app_participants
```

`REQUESTED` and `WAITLISTED` applications do not reserve a participant seat. Only acceptance creates active `room_participants`. Capacity is re-counted under lock inside the transaction; `room_availability_projections` is read-side data, never permission to bypass canonical checks.

### Room state

```text
DRAFT → OPEN ↔ FULL → IN_PROGRESS → COMPLETED
                    ↘ CANCELLED (before completion)
```

- A host creates `DRAFT`, then publishes it.
- Automatic/manual start is enforced by lifecycle service, not client time.
- `COMPLETED` is terminal.
- Completion requires the appropriate attendance/rating requirements from backend; UI must not guess.
- `repeat` is completed-room-only and produces a new DRAFT.

### Participation and HOST approval

1. Player creates an application, optionally for a party.
2. Application is `REQUESTED` or `WAITLISTED`; it may be withdrawn.
3. HOST accepts or rejects. Accept is capacity/schedule/party atomic and creates accepted participants.
4. Player/HOST may cancel/remove only through available backend actions.
5. During `IN_PROGRESS`, HOST marks each participant present/no-show.
6. Allowed skill rating and completion follow backend eligibility.

### Other invariants

- Party accept is all-or-none, with locks and revalidation for all registered members.
- A guest claim converts an existing guest seat; it never creates capacity.
- Reliability adjustments and raw skill rating evidence are immutable/auditable; profile is derived.
- Public share resolver returns a redacted live DTO, not private contact/audit data.
- Notification/push/analytics projection failure never rolls back the business transaction.
- Reconciliation and analytics quality scans detect/persist evidence only; they do not auto-repair canonical data.

## 7. API reference

`docs/openapi.yaml` is the canonical route index. Route DTO field names use `snake_case`; TypeScript domain code uses camelCase internally. Mutations should send `Idempotency-Key` unless explicitly excluded by the client for auth endpoints.

### Public health and auth

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health`, `/health/live` | No | Process liveness |
| GET | `/health/ready` | No | PostgreSQL readiness; 200/503 |
| POST | `/api/v1/auth/register` | No | Create credential/user/session; duplicate email/phone → 409 |
| POST | `/api/v1/auth/login` | No | Create session |
| POST | `/api/v1/auth/logout` | Bearer | Revoke active session, 204 |
| GET | `/api/v1/me` | Bearer | Current account/profile/reliability/sport profiles |
| PATCH | `/api/v1/me` | Bearer | Update allowed profile fields: display name, phone, avatar, birth year, gender, home area |

### Discovery and rooms

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/v1/search/rooms` | Search cards and exact availability/eligibility context |
| POST | `/api/v1/search/telemetry` | Product telemetry event |
| POST | `/api/v1/rooms` | Create DRAFT room with sport, venue, time, capacity, host participation, reserved external count, equipment and flags |
| GET | `/api/v1/rooms/:roomId` | Public/authenticated room detail; authenticated response has authoritative `viewer.available_actions` |
| PATCH | `/api/v1/rooms/:roomId` | HOST edits supported fields with optional expected version |
| POST | `/api/v1/rooms/:roomId/publish` | Publish DRAFT |
| POST | `/api/v1/rooms/:roomId/repeat` | Repeat eligible completed room into DRAFT |
| POST | `/api/v1/rooms/:roomId/reserved-external-count` | Update external reserved count |
| POST | `/api/v1/rooms/:roomId/cancel` | Cancel eligible room |
| POST | `/api/v1/rooms/:roomId/start` | Start according to lifecycle guard |
| POST | `/api/v1/rooms/:roomId/complete` | Complete once all gates hold |
| GET | `/r/:shareToken` | Public share resolver/redirect with redacted state |

### Participation and host operations

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/v1/rooms/:roomId/applications` | Request joining, optional party/waitlist input |
| POST | `/api/v1/applications/:applicationId/withdraw` | Withdraw own active request |
| POST | `/api/v1/applications/:applicationId/accept` | HOST accepts request/party atomically |
| POST | `/api/v1/applications/:applicationId/reject` | HOST rejects request |
| POST | `/api/v1/participants/:participantId/remove-by-host` | HOST removes allowed participant |
| POST | `/api/v1/participants/:participantId/cancel` | Participant cancellation flow |
| GET | `/api/v1/me/rooms` | Buckets: pending, upcoming, in-progress, completed, hosting |
| GET | `/api/v1/host/rooms/:roomId` | Full HOST manager DTO: room, pending/waitlisted, accepted participants, available actions |
| GET | `/api/v1/host/rooms/:roomId/applications` | HOST applications |
| GET | `/api/v1/host/rooms/:roomId/waitlist` | HOST waitlist |
| GET/POST | `/api/v1/host/rooms/:roomId/refill`, `/activate`, `/disable` | Emergency refill visibility/control |
| GET | `/api/v1/host/rooms/:roomId/attendance` | HOST attendance view |
| POST | `/api/v1/participants/:participantId/attendance/present` | Mark present |
| POST | `/api/v1/participants/:participantId/attendance/no-show` | Mark no-show |
| GET | `/api/v1/participants/:participantId/rating-eligibility` | Rating eligibility |
| POST | `/api/v1/participants/:participantId/skill-rating` | Submit one rating |
| POST | `/api/v1/rooms/:roomId/skill-ratings/batch` | Submit room rating batch |

### Identity, reliability, friendship, party

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/v1/me/reliability` | Current user reliability ledger/summary |
| GET | `/api/v1/users/:userId/host-profile` | Public host presentation |
| GET | `/api/v1/users/:userId/sports/:sportCode/profile` | Public sport profile |
| GET/POST | `/api/v1/friends`, `/friends/requests` | List friendships / send request |
| POST | `/api/v1/friends/requests/:friendshipId/accept` | Accept friendship |
| POST | `/api/v1/friends/requests/:friendshipId/decline` | Decline friendship |
| POST | `/api/v1/parties` | Create party for a sport |
| GET | `/api/v1/parties/:partyId` | Party detail |
| POST | `/api/v1/parties/:partyId/members` | Add registered or guest member |
| POST | `/api/v1/parties/:partyId/members/:partyMemberId/confirm` | Confirm member |
| POST | `/api/v1/parties/:partyId/members/:partyMemberId/decline` | Decline member |
| DELETE | `/api/v1/parties/:partyId/members/:partyMemberId` | Remove party member |
| POST | `/api/v1/party-guest-claims/:claimToken` | Claim an existing guest seat |

### Notifications

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/v1/notifications` | Notification feed |
| POST | `/api/v1/notifications/:notificationId/read` | Mark read |
| GET/PATCH | `/api/v1/me/notification-preferences` | Read/update preferences |
| POST | `/api/v1/me/push-devices` | Register device token |

The current Expo redesign displays notification navigation as non-interactive because the active private-alpha UI has not wired this API yet. Do not add a fake notification screen; wire the real endpoints first.

### Internal operations API

All `/internal/*` endpoints require: configured `INTERNAL_OPS_TOKEN`, matching `X-Internal-Ops-Token`, and a client IP in `INTERNAL_OPS_ALLOWLIST`. These are operational-only, not a public admin API.

- `GET /internal/metrics`: Prometheus metrics.
- `GET /internal/reconciliation/findings`: persisted discrepancies.
- `GET/POST /internal/users/:id`, `/rooms/:id`, `/applications/:id`, `/participants/:id`, `/parties/:id`: inspection and controlled suspension.
- `GET/POST /internal/outbox`, `/internal/push-deliveries`: inspect/retry retryable work.
- `GET /internal/reliability/:userId`, `/internal/skill-profiles/:userId/:sportId`: audit views.
- `GET /internal/analytics/health`, `/funnels`, `/host-performance`, `/player-retention`, `/marketplace-health`; `POST /internal/analytics/quality-check`: read-only analytics and detection checks.

## 8. Database and migrations

| Migration | Main data introduced |
| --- | --- |
| 001 foundation | users, sports, user profiles, outbox, event consumption, idempotency |
| 002 room core | rooms, equipment policy/options, change log, availability projection |
| 003 participation | applications, application members, participants |
| 004 lifecycle | attendance logs |
| 005 search | search telemetry |
| 006 reliability | cancellation, player/host stats, reliability adjustments, recovery/refill |
| 007 ranking | ranking rules, skill ratings |
| 008 social/party | friendships, parties, party members |
| 009 share/notifications | notification preferences, notifications, push devices/deliveries |
| 010 operations | reconciliation runs/findings, internal operation audits |
| 011 performance | hot-path indexes only |
| 012 analytics | derived `analytics_*` facts/profiles/experiments |
| 013 analytics hardening | consumer health, failure, validation, rebuild audit |
| 014 auth sessions | credentials and opaque server-side sessions |

Commands:

```powershell
npm.cmd run migrate:status
npm.cmd run migrate:up
npm.cmd run migrate:down       # use deliberately; it reverses only the last migration
npm.cmd run seed
```

Never reset, delete or recursively modify `D:\APP VAOTRAN\.verification-postgres`. It is the current verification cluster.

## 9. Expo client

### Active UX

`mobile/src/app/index.tsx` contains the active screen composition:

- green entry splash with Login/Register CTAs;
- Login and Register with friendly inline errors;
- Discovery with supported sport selection, room cards, filter presentation and room detail;
- viewer-authoritative Request/Withdraw/HOST manager actions;
- My Matches buckets and Hosting entry;
- two-step Create Room, publish and host management;
- HOST request accept/reject, start, attendance and complete actions;
- profile display/edit/logout;
- responsive centered web layout and bottom navigation.

The client API adapter currently wires these endpoints: register/login/logout/me/update, search/detail, request/withdraw, matches, create/publish, accept/reject, start, attendance, complete, host manager. Remaining backend APIs are not yet presented in the active UI.

### UI code boundaries

- `mobile/src/theme/index.ts`: colors, spacing, radius, shadow tokens.
- `mobile/src/components/ui/app-ui.tsx`: buttons, fields, chips, badges, cards, error/empty/loading, avatar.
- `mobile/src/lib/api.ts`: one API base, JSON envelope parsing, bearer injection, idempotency, friendly errors.
- `mobile/src/lib/session.ts`: native secure storage and web in-memory session.

Do not let the client calculate slot availability, lifecycle transitions, party acceptance, skill eligibility or reliability. Use DTO fields and `viewer.available_actions` from the API.

## 10. Validation and operations

### Backend

```powershell
npm.cmd run build
npm.cmd test
```

Backend regression was previously verified against the PostgreSQL verification database with 75/75 tests passing. Re-run when backend source, migrations or contracts change.

### Client

```powershell
Set-Location mobile
npx.cmd tsc --noEmit
npm.cmd run lint
npx.cmd expo export --platform web --output-dir .expo-export-handoff-check
npx.cmd expo-doctor
```

Current client TypeScript, ESLint and Expo Web export pass. Expo Doctor reports 20/21 because its local check cannot recognize `.expo` ignore in this workspace environment; it does not block runtime or export. Do not initialize/alter Git solely to silence that check.

### Local start

```powershell
# Backend, with a valid .env or the explicit environment shown in section 4
npm.cmd run build
node dist/server.js

# Client
Set-Location mobile
$env:REACT_NATIVE_PACKAGER_HOSTNAME='192.168.1.68'
npx.cmd expo start --lan --port 8081
```

`mobile/.env` is local and must point to a reachable backend, currently:

```dotenv
EXPO_PUBLIC_API_BASE_URL=http://192.168.1.68:3000
```

For a real device, both device and computer must be on the same LAN and inbound network policy must permit API/Metro ports. The existing Expo port range rule covers 8081 in this environment; backend port 3000 firewall permission was not elevated/verified, so do not claim device API access is open until tested on that network.

## 11. Important continuation work

1. Persist repeatable local/dev runtime configuration instead of relying on a manually launched process environment, while keeping secrets untracked.
2. Complete UI wiring for notification, friendship, party, reliability, skill/rating, share, refill and public host-profile APIs. Do not expose nonfunctional CTAs.
3. Split `mobile/src/app/index.tsx` further into route/screen components once feature work resumes; the current redesign already extracted tokens/primitives, but screen composition remains centralized.
4. Replace text glyph icons with a consistent Expo-compatible icon system before a public-quality visual release.
5. Implement production deployment prerequisites: real identity/credential operating procedures, secret provisioning, TLS/public ingress, CORS production origins, firewall review, backup/restore drill, internal-ops allowlist, and worker scaling/ownership.
6. Add device E2E coverage after the LAN firewall path is confirmed. Browser E2E must retain CORS preflight checks.

## 12. Reference documents

- `docs/openapi.yaml` — route index/canonical contract.
- `docs/events/LIFECYCLE-EVENT-REGISTRY.md` — event semantics.
- `PILOT-OPERATIONS-RUNBOOK.md` — pilot operations and recovery.
- `ANALYTICS-OPERATIONS-RUNBOOK.md` — analytics triage/rebuild.
- `PRODUCTION-AUTH-MIGRATION-PLAN.md` — production identity rollout.
- `docs/operations/OUTBOX-REPLAY-RUNBOOK.md` and `RECOVERY-DRILL.md` — operational safety.

When taking over, begin with: API `/health/ready`, migration status, the current server logs, `mobile/.env`, then a fresh authenticated register/login and one HOST/PLAYER lifecycle test. Never use a development actor header as evidence for private-alpha authentication.

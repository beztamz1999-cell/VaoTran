# VàoTrận Core Backend + Alpha Mobile — M0 đến M12

VàoTrận là backend modular monolith cho mô hình **“HOST mở trận, Player vào trận”**, không phải sản phẩm đặt sân. Repository triển khai Foundation M0, Room Core M1, Join Application M2, Lifecycle & Attendance M3, Search M4, Reliability M5, Skill/Ranking M6, Party/Friends/Guests M7, Share/Notifications/Repeat M8, **Pilot Hardening & Production Readiness M9**, **Pilot Growth Loop & Marketplace Learning M10**, **Analytics Operational Hardening & Production Readiness M11**, cùng **M12 Alpha Mobile Experience**. Nền tảng dùng Node.js, TypeScript strict, Express 5 và PostgreSQL; HTTP layer chỉ là boundary, còn lifecycle, capacity, authorization, idempotency, audit ledger và outbox luôn thuộc application/domain service. M12 bổ sung một Expo/React Native Alpha client gọi API thật để chứng minh vertical slice, không chuyển product rule sang frontend.

> **M9 không thêm product feature.** Milestone này tăng khả năng vận hành pilot qua observability, readiness, AuthContext, reconciliation chỉ phát hiện, internal inspection có bảo vệ, index hiệu năng, baseline có kiểm soát, runbook và kế hoạch chuyển đổi production authentication. Mọi invariant M0–M8 vẫn là source of truth.
>
> **M10 là read-side analytics.** Projection chỉ đọc `event_outbox`, chỉ lưu pseudonym/dimension aggregate, được rebuild từ event history và không thay đổi Room, Application, Participant, Reliability, Ranking hoặc Search. Experiment chỉ là stable assignment/exposure measurement; không chứa A/B product behavior.
>
> **M11 harden analytics vận hành.** Event/payload schema có version additive; consumer health, unknown/failure evidence, quality finding và before-after rebuild audit đều là metadata derived-only. Validation định kỳ chỉ phát hiện/report; không tự repair analytics projection hoặc canonical business data.
>
> **M12 là Alpha mobile experience.** Expo UI chỉ trình bày DTO và gửi command canonical; capacity, skill fit, trạng thái join và availability vẫn được backend tính/trả về. `X-Actor-User-Id` chỉ là development actor simulation cho Alpha, không phải production authentication.

## Core invariant

```text
host_slot = host_participates ? 1 : 0

available_public_slots
= capacity
- host_slot
- reserved_external_count
- active_accepted_app_participants
```

`REQUESTED` và `WAITLISTED` không tạo `RoomParticipant`, nên không chiếm slot. Chỉ `ACCEPTED` tạo `RoomParticipant(status=ACTIVE)` và được tính vào hạng tử cuối. `room_availability_projections` chỉ là read projection; mọi mutation capacity luôn re-count từ Room và participant state trong cùng transaction.

| Invariant / rule | Cách thực thi |
| --- | --- |
| Không vượt capacity | Accept lock `Room`, re-count participant active hiệu lực, revalidate công thức rồi mới tạo participant. |
| REQUESTED/WAITLISTED không giữ slot | Chỉ application `ACCEPTED` mới tạo participant `ACTIVE`; waitlist luôn cần HOST accept rõ ràng. |
| Lifecycle Room | `DRAFT → OPEN ↔ FULL → IN_PROGRESS → COMPLETED`; `COMPLETED` terminal; cancellation chỉ trước completion. |
| Party atomicity | Accept lock Room, advisory-lock các registered member, revalidate schedule/capacity, rồi tạo toàn bộ participant hoặc rollback toàn bộ. |
| Guest claim | Claim chuyển đúng guest seat thành registered identity; không tạo seat mới và không đổi capacity. |
| Rating/reliability audit | Raw skill evidence và reliability ledger là immutable/idempotent; derived profile không thay raw fact. |
| Public share privacy | `GET /r/:shareToken` resolve live state, DTO redacted không lộ identity/contact/audit/raw score. |
| Notification downstream | Projection/delivery failure không rollback business fact; worker không mutation Room, capacity hay participation aggregate. |
| Reconciliation M9 | Chỉ compare canonical fact với projection/evidence, persist finding và metric; **không tự repair** raw fact hoặc projection. |
| Internal operations M9 | Cần đồng thời token bí mật hợp lệ, `X-Internal-Ops-Token` và IP thuộc allowlist; không có admin frontend/public ingress. |
| Analytics M10 | Derived projection chỉ ghi `analytics_*` tables; consume/replay event idempotently từ outbox, không write canonical product table hoặc sửa business history. |
| Analytics privacy M10 | Không persist phone, email, token, raw address, private message hay raw user/room/application/participant identifier; user/room key được HMAC pseudonym hóa, area chỉ là bucket. |
| Analytics operations M11 | Event/payload version được xử lý backward-compatible; consumer health, projection failure, quality findings và rebuild before/after audit chỉ lưu evidence an toàn. Unknown contract và validation drift không kích hoạt auto-repair. |
| Replay an toàn | `Idempotency-Key`, request fingerprint và response persistence nằm cùng PostgreSQL transaction của critical command. |

## Thành phần đã triển khai

| Thành phần | Nội dung |
| --- | --- |
| Foundation M0 | Config, structured logging, request/correlation ID, canonical error envelope, transaction abstraction, transactional outbox và idempotency. |
| Room & participation M1–M3 | Room/equipment/change log/availability, HOST approval, participant lifecycle, attendance, manual/auto start và completion. |
| Search & reliability M4–M5 | Exact availability, schedule eligibility, progressive-radius discovery, stable ranking, telemetry, cancellation/reliability ledger, waitlist và controlled emergency refill. |
| Skill & ranking M6 | Immutable `skill_ratings`, eligibility, calibration, confidence, score rolling window, tier hysteresis và completion gate. |
| Party/Friends/Guests M7 | Friendship consent, Party READY gate, immutable application snapshot, all-or-none accept, guest claim và Party-aware search. |
| Share/notifications/repeat M8 | Stable public share capability, live redacted resolver, completed-only Repeat Room tạo DRAFT, notification feed/preferences/devices/delivery retry và non-mutating reminders. |
| Hardening M9 | Metrics registry Prometheus text export, correlation-aware structured logs, request/DB/worker instrumentation, Postgres readiness, AuthContext boundary, reconciliation detection-only, protected inspection/retry operations, performance indexes và operational documentation. |
| Analytics M10 | Event-driven, idempotent read projection cho HOST/PLAYER/share funnel, D1/D7/D30 retention, repeat participation, supply/demand/empty-search reporting, pseudonymous cohort và experiment assignment/exposure foundation. |
| Analytics hardening M11 | Additive event/payload versioning, consumer lag/failure/unknown metrics, persisted health and data-quality evidence, periodic single-flight validation, derived-only rebuild comparison và analytics operations runbook. |
| Alpha mobile M12 | Expo SDK 54 / React Native Alpha gồm Home, chọn môn, Search, Room detail, Join Request và My Matches. Client gọi API VàoTrận thật qua typed adapter; không dùng mock data hoặc tái tạo capacity, skill fit, availability hay application state. |

## M12 Alpha Mobile Experience

M12 chạy trong managed mobile project `vaotran-alpha-mobile`. Bốn tab **Trang chủ**, **Vào trận**, **Trận của tôi** và **Cá nhân** cung cấp flow Alpha tối thiểu: chọn sport, tìm Room, mở chi tiết, gửi Join Request với `Idempotency-Key`, rồi xem trạng thái chờ HOST duyệt. `lib/vaotran-api.ts` là một adapter typed cho các endpoint backend hiện hữu; frontend chỉ format DTO và hiển thị loading, empty, error hoặc state trả về.

| Màn hình / flow | API nguồn | Ranh giới bắt buộc |
| --- | --- | --- |
| Home và chọn môn | State phiên Alpha trong bộ nhớ | Chỉ chọn context tìm kiếm; không quyết định khả năng tham gia. |
| Search Room | `GET /api/v1/search/rooms` | Card hiển thị `available_public_slots`, badge và skill fit do backend trả về. |
| Room detail | `GET /api/v1/rooms/:roomId` | Capacity, equipment, lịch, giá và eligibility lấy từ DTO canonical. |
| Join Request | `POST /api/v1/rooms/:roomId/applications` | Mutation mang `Idempotency-Key`; backend quyết định duplicate, full, conflict và state. |
| My Matches / success state | `GET /api/v1/me/rooms` | `REQUESTED`/`WAITLISTED` được hiển thị từ backend, không phải local optimistic state. |

Development web preview dùng CORS allowlist giới hạn cho origin Expo phục vụ evidence. Điều này không thay đổi AuthContext, authorization, capacity formula, lifecycle hoặc domain command. Chi tiết acceptance evidence và giới hạn Alpha nằm trong `M12-DELIVERY-REPORT.md`.

## Cấu trúc mã nguồn

```text
src/
  platform/
    auth/context.ts                  # AuthContext và development actor resolver thay thế được
    observability/{metrics,readiness}.ts
    analytics/privacy.ts               # HMAC pseudonym và area bucket validation
    database/{db,migrate,seed}.ts
    http/app.ts                      # REST, health/readiness và protected internal endpoints
    idempotency.ts
    outbox/outbox.ts
  modules/
    identity/
    room/
    participation/
    party/
    notification/
    reliability/
    ranking/
    search/
    operations/{reconciliation-service,reconciliation-scheduler,operations-service}.ts
    analytics/{analytics-service,analytics-validation-scheduler}.ts # Read-side consumer, quality validation, rebuild audit
  tests/
    m0-m1.test.ts ... m11-integration.test.ts
migrations/
  001_foundation.{up,down}.sql ... 009_share_notifications_repeat.{up,down}.sql
  010_pilot_hardening_operations.{up,down}.sql
  011_pilot_performance_indexes.{up,down}.sql
  012_pilot_growth_analytics.{up,down}.sql
  013_analytics_operational_hardening.{up,down}.sql
scripts/
  m9-performance-baseline.ts
  m11-analytics-rebuild.ts
PILOT-OPERATIONS-RUNBOOK.md
PRODUCTION-AUTH-MIGRATION-PLAN.md
M9-PERFORMANCE-BASELINE.json
M10-DELIVERY-REPORT.md
M11-DELIVERY-REPORT.md
ANALYTICS-OPERATIONS-RUNBOOK.md
```

Migration `010_pilot_hardening_operations` thêm các persistence record vận hành: `reconciliation_runs`, `reconciliation_findings` và `internal_operation_audits`. Migration `011_pilot_performance_indexes` thêm partial index cho hot path schedule-conflict; không đổi data model hoặc product semantics. Migration `012_pilot_growth_analytics` chỉ thêm các `analytics_*` projection/fact/assignment tables và index của chúng; paired down chỉ drop derived analytics tables, không đụng dữ liệu nghiệp vụ. Migration `013_analytics_operational_hardening` thêm event/payload version additive, provenance, consumer health, failure/quality/rebuild audit; paired down chỉ gỡ metadata analytics M11.

## HTTP contract và bảo mật vận hành

Base path product là `/api/v1`. Trong development, mutation dùng `X-Actor-User-Id` placeholder cùng `Idempotency-Key`. M9 đóng gói actor vào `AuthContext`; header resolver chỉ là adapter development và phải được thay bằng middleware authentication production theo `PRODUCTION-AUTH-MIGRATION-PLAN.md`. Actor không được lấy từ request body.

| Nhóm | Endpoint | Hành vi |
| --- | --- | --- |
| Liveness | `GET /health`, `GET /health/live` | Xác nhận process đang phục vụ; không khẳng định database sẵn sàng. |
| Readiness | `GET /health/ready` | Probe PostgreSQL bằng `SELECT 1`; trả `200 ready` hoặc `503 not_ready` cùng database status và thời điểm check. |
| Metrics | `GET /internal/metrics` | Prometheus text exposition, không có PII/identifier; áp dụng guard internal đầy đủ. |
| Reconciliation | `GET /internal/reconciliation/findings` | List finding persisted để triage, có filter state/limit. |
| Inspection | `GET /internal/users/:userId`, `/rooms/:roomId`, `/applications/:applicationId`, `/participants/:participantId`, `/parties/:partyId` | Đọc aggregate/projection phục vụ điều tra, không công khai cho product user. |
| Audit inspection | `GET /internal/reliability/:userId`, `/skill-profiles/:userId/:sportId`, `/outbox`, `/push-deliveries` | Đọc ledger/profile và trạng thái worker delivery/outbox theo access guard. |
| Controlled operations | `POST /internal/users/:userId/suspend`, `/outbox/:eventId/retry`, `/push-deliveries/:deliveryId/retry` | Idempotent, ghi audit với correlation ID; retry chỉ requeue record retryable, không rewrite business fact. |
| Analytics M10 | `GET /internal/analytics/funnels`, `/host-performance`, `/player-retention`, `/marketplace-health` | Aggregate read-only theo window và sport/area bucket; kế thừa token + IP allowlist guard; không trả raw identity/PII. |
| Analytics operations M11 | `GET /internal/analytics/health`, `POST /internal/analytics/quality-check` | Consumer health và detection-only data-quality run; cùng token + IP allowlist guard, không public, không auto-repair và không trigger canonical mutation. |

Internal endpoints yêu cầu **cả ba** điều kiện: `INTERNAL_OPS_TOKEN` được cấu hình ở server, header `X-Internal-Ops-Token` khớp bằng timing-safe comparison, và IP client thuộc `INTERNAL_OPS_ALLOWLIST`. Thiếu một trong ba điều kiện phải bị từ chối; không expose các route này qua public ingress.

## Observability, reconciliation và scheduler

M9 chuẩn hóa correlation ID xuyên HTTP, command, database và worker log. `MetricsRegistry` giữ counter, gauge và histogram process-local, xuất Prometheus text với metric label không chứa PII. Instrumentation bao phủ API latency/error, query/transaction duration, DB error/rollback, idempotency replay/conflict, outbox claim/publish/failure/lag, notification lag/retry, search latency/zero-result và worker duration.

`PostgresReadinessProbe` chỉ chịu trách nhiệm database readiness. Đây là tách biệt có chủ ý với liveness để deployment platform không route traffic vào process khi database không truy cập được.

`ReconciliationScheduler` chạy trong **cùng process API** theo lựa chọn MVP Runtime A, có single-flight guard. Nó kiểm tra availability/status Room, skill evidence/derived profile, reliability ledger và notification dedupe/delivery state; mỗi discrepancy được persist thành finding để người vận hành đánh giá. Scheduler tuyệt đối không auto-repair projection hoặc raw business fact.

Các worker M8/M9/M11 vẫn chạy cùng API process: outbox, notification consumer, push delivery, reminder, auto-start/refill-expiry, reconciliation và analytics quality validation. Analytics validation chạy theo interval với single-flight guard, persist evidence và không auto-rebuild. Worker claim dùng transactional lock/`SKIP LOCKED` khi phù hợp; shutdown `SIGINT`/`SIGTERM` dừng timer/scheduler trước khi đóng HTTP server và PostgreSQL pool. Khi scale ngang, cần architecture worker/lease riêng trước khi chạy nhiều instance.

## Chạy cục bộ

Máy local cần PostgreSQL; không commit `.env` thật.

```powershell
Copy-Item .env.example .env
# Thiết lập DATABASE_URL và các config Search/scheduler cần thiết.
# Với internal operations: đặt INTERNAL_OPS_TOKEN và INTERNAL_OPS_ALLOWLIST rõ ràng.
& 'C:\Program Files\nodejs\npm.cmd' install
& 'C:\Program Files\nodejs\npm.cmd' run migrate:up
& 'C:\Program Files\nodejs\npm.cmd' run seed
& 'C:\Program Files\nodejs\npm.cmd' run dev
```

Các biến M9 gồm threshold slow query, interval metrics/reconciliation, `INTERNAL_OPS_TOKEN`, `INTERNAL_OPS_ALLOWLIST` và cờ development actor header. M10/M11 bổ sung `ANALYTICS_HASH_SALT` (production phải provision secret ổn định để pseudonym không đổi giữa deploy) và `ANALYTICS_VALIDATION_INTERVAL_MS` (mặc định 15 phút). Các biến này chỉ điều chỉnh quan sát/vận hành; không được dùng để thay đổi lifecycle, capacity formula, reliability penalty hay ranking policy. Xem `PILOT-OPERATIONS-RUNBOOK.md` cho backup/restore, `ANALYTICS-OPERATIONS-RUNBOOK.md` cho triage/rebuild analytics và `PRODUCTION-AUTH-MIGRATION-PLAN.md` cho rollout authentication provider.

## Quality gates đã chạy

| Gate | Kết quả |
| --- | --- |
| Strict TypeScript | `tsc -p tsconfig.json` pass với source M11. |
| PostgreSQL migration | Migration `001` đến `013` apply thành công trên PostgreSQL 16 test database. |
| Rollback migration | `013_analytics_operational_hardening` down rồi reapply thành công; trạng thái cuối có đủ `001`–`013` APPLIED. |
| M11 integration | **4/4 pass**: legacy/version-safe event handling; failure/health evidence; privacy/provenance quality validation cùng rebuild comparison; token + allowlist guard cho health/quality endpoints. |
| Full regression | `vitest run --no-file-parallelism`: **66/66 pass** gồm 8 M0/M1, 9 M2, 7 M3, 5 M4, 7 M5, 5 M6, 7 M7, 6 M8, 4 M9, 4 M10 và 4 M11. |
| Performance baseline | Controlled PostgreSQL dataset M9: 12 searchable Rooms, 20 concurrent applicants; search p50 **6.61 ms**, p95 **8.20 ms**, max **11.21 ms**; concurrent accept 20/20, active participants 20, total **139.22 ms**. Artifact: `M9-PERFORMANCE-BASELINE.json`. Đây không phải cam kết capacity production. |

## Ranh giới còn lại

M9 không triển khai OTP, OAuth/OIDC, session management hay production identity provider; chỉ cung cấp boundary để thay thế development header mà không viết lại domain service. M9 cũng không có admin frontend, không auto-repair qua reconciliation, không tách worker thành deployment riêng và không thay đổi bất kỳ product rule M0–M8 nào.

M10/M11 không triển khai recommendation/ML ranking, dynamic pricing, ads attribution, payment/booking analytics, social graph analytics, raw session identity bridge hay A/B product behavior. Share funnel vì vậy báo cáo `share_view`, `USER_REGISTERED` và join request cho share-enabled Room như các aggregate riêng; không suy diễn causal attribution cho anonymous view.

Các phần ngoài phạm vi MVP hiện tại vẫn gồm authenticated public landing/UI, email/SMS provider, production push-provider credentials, saved/recurring Party, HOST follow, automatic waitlist/Party admission, deposits/payment và court booking. Trước multi-instance deployment hoặc production launch, phải hoàn thành authentication rollout, secret/allowlist deployment review, backup-restore drill theo runbook và worker scaling policy.

# VT-M13-A — Backend API Contract Audit

## Kết luận điều hành

**Trạng thái: PARTIAL — audit-only, không có thay đổi chức năng.** Backend hiện đã bao phủ phần lớn luồng Room → Application → Participant → Lifecycle → Rating mà Alpha cần. Các rủi ro còn lại chủ yếu là **drift contract HTTP/projection** (không phải thiếu domain rule): Room detail thiếu context người xem, My Matches không có bucket `history`/`hosting` như hợp đồng, host-room manager hiện là stub, và một số mã lỗi/đường dẫn không trùng tên trong spec.

> **Phạm vi.** Bảng dưới đây audit các contract được yêu cầu trong brief M13: Room, Search, Application, Participant, lifecycle, Rating, My Matches và cross-cutting error/idempotency/concurrency. Friends, Party, Guest Claim, notification, analytics và internal operations vẫn tồn tại trong router nhưng nằm ngoài danh sách cần phân hạng của brief này.

## Phương pháp và bằng chứng

Audit đối chiếu contract và state model với HTTP composition root, service layer và test suite hiện tại. `Idempotency-Key` được đưa vào `commandMeta` cho command route; gate được thực thi trong transaction ở service. Acceptance khóa application/Room và revalidate availability trước khi tạo participant. [1][2][3][4]

| Nguồn | Vai trò audit |
|---|---|
| VT-API-001 | Path, request/response DTO, HTTP/error contract và idempotency kỳ vọng. |
| VT-STATE-001 | Transition Room, Application, Participant, Attendance và Rating không được bypass. |
| VT-DATA-001 | Nhận diện aggregate, projection, capacity và relationship bắt buộc. |
| `src/platform/http/app.ts` | Inventory route, HTTP status, DTO mapping và error envelope thực tế. |
| `src/modules/participation/service.ts` | Lock, availability revalidation, schedule conflict, Application/Participant state. |
| `src/modules/room/lifecycle-service.ts` | Start/auto-start/complete và transition terminal. |
| `src/modules/ranking/service.ts` | Eligibility, uniqueness và atomicity của rating. |

## Phân loại

| Nhãn | Ý nghĩa |
|---|---|
| **Implemented** | Endpoint và hành vi cốt lõi đáp ứng contract/state rule; khác biệt DTO nhỏ được nêu rõ nếu có. |
| **Partially implemented** | Endpoint chạy nhưng thiếu projection/filter/pagination hoặc chỉ đáp ứng một phần output cần thiết. |
| **Behavior mismatch** | Domain capability có mặt nhưng path, error code, response DTO hoặc semantic công khai khác VT-API-001. |
| **Missing** | Không có endpoint/projection contract tương ứng trong HTTP API. |

## API coverage matrix

### Room và Search

| Contract | Kết quả | Bằng chứng implementation | Khoảng cách / nhận xét |
|---|---|---|---|
| Tạo Room | **Implemented** | `POST /api/v1/rooms` trả `201`, `room_id`, `status`, `version`; dùng command idempotent. | Response là command acknowledgement tối giản; client cần GET detail nếu cần aggregate đầy đủ. |
| Publish Room | **Implemented** | `POST /api/v1/rooms/:roomId/publish`; trả availability, share token/path, publish time và version. | Khớp lifecycle `DRAFT → OPEN/FULL`; expected version được nhận. |
| Update Room | **Implemented** | `PATCH /api/v1/rooms/:roomId`; command idempotent, trả version và availability. | Cần ghi rõ `PATCH` là canonical client method nếu spec/client cũ kỳ vọng `PUT`. |
| Cập nhật external reservation | **Implemented (bổ sung)** | `POST /api/v1/rooms/:roomId/reserved-external-count`; service bảo vệ accepted participant và recompute availability. | Không phải contract chính trong brief, nhưng đúng data rule về capacity. |
| Cancel Room | **Implemented** | `POST /api/v1/rooms/:roomId/cancel`; trả status, cancellation time, version. | Cần API integration test riêng chứng minh tất cả accepted/pending/waitlisted application được đóng theo projection ngoài command acknowledgement. |
| Room detail | **Partially implemented / behavior mismatch** | `GET /api/v1/rooms/:roomId` trả room, venue, schedule, capacity derived, equipment, price, skill preference và lifecycle fields. | DTO trả `host_user_id`, **không** có nested `host` và **không** có `viewer_context`/application context. Đây là nguyên nhân mapper Alpha phải fallback. |
| Host Room Manager detail | **Missing (full projection)** | `GET /api/v1/host/rooms/:roomId` có route và authorization. | `manager.accepted_participants`, `pending_applications`, `waitlisted_applications` hiện trả mảng rỗng; đây là stub, không phải manager projection usable. |
| Search Room | **Behavior mismatch** | Search server-side trả availability, skill fit, ranking metadata, host, distance và badge. | Path đang là `GET /api/v1/search/rooms`, trong khi VT-API-001 nêu `GET /rooms/search`. Cần chọn một canonical path hoặc duy trì adapter/versioning; không được coi đây là thay đổi domain. |
| Search telemetry | **Implemented (bổ sung)** | `POST /api/v1/search/telemetry` trả `204` cho card-view/detail-open. | Ngoài core contract Room nhưng phù hợp analytics read-side. |
| Repeat completed Room | **Implemented (bổ sung)** | `POST /api/v1/rooms/:roomId/repeat`, chỉ cho `COMPLETED`. | Không thay thế `complete`; là capability hậu completion. |

### Application và Participant

| Contract | Kết quả | Bằng chứng implementation | Khoảng cách / nhận xét |
|---|---|---|---|
| Create Join Application | **Implemented** | `POST /api/v1/rooms/:roomId/applications` trả `201`; hỗ trợ solo/Party snapshot, `REQUESTED`/`WAITLISTED`, duplicate active application và capacity check. | Đúng rule: request/waitlist không giữ slot. |
| Withdraw Application | **Implemented** | `POST /api/v1/applications/:applicationId/withdraw`; transition về `WITHDRAWN`, atomic outbox event. | Chỉ actionable application được withdraw; conflict trả domain error ổn định. |
| Host query applications | **Partially implemented** | `GET /api/v1/host/rooms/:roomId/applications` trả request và member snapshot/skill/reliability. | Chỉ pending list; chưa có `status` filter, pagination/cursor hoặc query resolved history nếu spec cần. |
| Accept Application | **Implemented** | `POST /api/v1/applications/:applicationId/accept`; locks, schedule locks, capacity revalidation, participant creation, overlap withdrawal và `OPEN ↔ FULL`. | Trong emergency-refill mode service có thể accept hợp lệ khi `IN_PROGRESS`; đây phải được client coi là policy-backed, không phải bypass lifecycle. |
| Reject Application | **Implemented** | `POST /api/v1/applications/:applicationId/reject`; HOST-only, resolves request, persists reason and outbox. | Response chỉ `{ status: REJECTED }`; sufficient command acknowledgement. |
| Player cancel participant | **Implemented** | `POST /api/v1/participants/:participantId/cancel`; reliability service phân loại cancellation, impact và recompute availability. | Thuộc reliability foundation; cần client contract rõ về `reliability_impact` shape. |
| HOST remove participant | **Implemented** | `POST /api/v1/participants/:participantId/remove-by-host`; state `REMOVED_BY_HOST`, no player penalty, slot reopen. | Đúng rule HOST protection/capacity; idempotency và transition guard áp dụng. |
| Waitlist/refill | **Implemented (bổ sung)** | Waitlist query, refill query, activate/disable routes hiện có. | Không có auto-admission; HOST vẫn accept, đúng MVP state rule. |

### Attendance, lifecycle và rating

| Contract | Kết quả | Bằng chứng implementation | Khoảng cách / nhận xét |
|---|---|---|---|
| Host attendance list | **Implemented** | `GET /api/v1/host/rooms/:roomId/attendance` trả participant, attendance, no-show time và rating eligibility. | Projection giàu hơn contract cơ bản; authorization nằm service. |
| Mark PRESENT | **Implemented** | `POST /api/v1/participants/:participantId/attendance/present`; trả corrected flag và no-show threshold. | Chỉ ACTIVE participant, transition protected. |
| Mark NO_SHOW | **Implemented** | `POST /api/v1/participants/:participantId/attendance/no-show`; enforced grace window. | Sau completion, code hiện là `ROOM_TERMINAL` thay vì tên `ATTENDANCE_FINALIZED` mà spec dùng — **behavior mismatch về error code**, không phải sai transition. |
| Manual start | **Implemented / behavior mismatch** | `POST /api/v1/rooms/:roomId/start`; host-only, early-start boundary, idempotent replay; auto-start dùng cùng lifecycle service. | Lỗi được expose là `START_TOO_EARLY`, spec gọi `MANUAL_START_TOO_EARLY`. Chuẩn hóa alias/migration error code trước public client rộng hơn. |
| Complete Room | **Partially implemented / behavior mismatch** | `POST /api/v1/rooms/:roomId/complete`; chặn attendance/rating chưa đầy đủ và idempotently accepts already-completed. | Response thiếu `repeat_room_available`; failure attendance tách `ATTENDANCE_INCOMPLETE` khỏi `ROOM_COMPLETION_INCOMPLETE` tổng hợp của spec. |
| Rating eligibility | **Implemented** | `GET /api/v1/participants/:participantId/rating-eligibility`; trả `eligible`, `rating_submitted`, `reason`. | Các lý do ineligible thường map vào `RATING_NOT_ALLOWED` + details, thay vì các code granular trong spec. |
| Submit individual rating | **Behavior mismatch** | `POST /api/v1/participants/:participantId/skill-rating`; validates present/host eligibility/one rating, persists raw + effective rating. | Contract name dùng `skill-rating`; nếu VT-API-001 công bố `/rating`, cần canonical alias hoặc versioned migration. |
| Submit batch rating | **Implemented (bổ sung)** | `POST /api/v1/rooms/:roomId/skill-ratings/batch`; atomic batch. | Stronger operational capability than individual contract; document batch error behavior. |

### User / My Matches

| Contract | Kết quả | Bằng chứng implementation | Khoảng cách / nhận xét |
|---|---|---|---|
| Pending matches | **Implemented** | `GET /api/v1/me/rooms` trả `pending` với application/participation status. | Alpha dùng được để hiển thị Join Request state từ backend. |
| Upcoming matches | **Implemented** | Cùng endpoint trả `upcoming`. | Có start/end time và status cơ bản. |
| In-progress matches | **Implemented (extension)** | Cùng endpoint trả `in_progress`. | Extension hợp lý theo lifecycle. |
| History / completed | **Behavior mismatch** | Backend dùng bucket `completed`, không phải `history`. | `history` contract không tồn tại như named bucket; client phải map hoặc backend cung cấp alias. |
| Hosting list | **Missing** | Không có bucket `hosting` trong `/me/rooms`. | Host must dùng endpoint khác/stub manager; cần priority cao trước Host mobile manager. |
| Match row detail/action context | **Partially implemented** | DTO có type, room status, times, participation/application status. | Thiếu richer room/host/venue snapshot và permitted actions nếu VT-API-001 yêu cầu client orchestration. |

## Cross-cutting contract audit

| Concern | Kết quả | Audit finding |
|---|---|---|
| Error envelope | **Implemented** | Canonical envelope `{ "error": { "code", "message", "details" } }`; request correlation id được trả qua header. |
| HTTP status mapping | **Implemented, with code drift** | 400 validation/value; 401 unauthenticated; 403 authorization; 404 resource; 409 invalid transition/conflict/capacity/idempotency. Một số semantic code lệch tên spec: `START_TOO_EARLY`, `ROOM_TERMINAL`, `ATTENDANCE_INCOMPLETE`, `RATING_NOT_ALLOWED`. |
| Idempotency | **Implemented for core domain commands** | Room commands, application commands, participant actions, start/complete/rating dùng persistent idempotency gate và replay status/body. | Audit tiếp theo nên xác nhận cùng policy cho profile/preferences/push mutation hoặc document chúng là non-command updates. |
| Concurrency / capacity | **Implemented** | Accept locks application/Room/user schedules, revalidates slots in transaction, uses unique constraint fallback and derives OPEN/FULL. Room version checks protect editable capacity updates. |
| Transactional outbox | **Implemented** | Application, Participant, Room lifecycle and rating events are appended in command transaction. |
| Development authentication | **Partial by design** | `X-Actor-User-Id` remains only development resolver for Alpha; it is not production auth. This is recorded risk, not a domain mismatch. |

## Missing endpoints and material contract gaps

| Priority | Gap | Impact | Recommended contract action |
|---|---|---|---|
| **P0** | Full `GET /api/v1/host/rooms/:roomId` manager projection is a stub. | HOST cannot operate accepted/pending/waitlisted queue from one trusted projection. | Implement projection from existing authoritative Room/Application/Participant records; do not add new domain rules. |
| **P0** | `/api/v1/me/rooms` lacks `hosting` and named `history` compatibility. | Mobile Host/History surfaces need client-side workaround or incomplete UX. | Version/add aliases; preserve existing `completed`/`in_progress` for backward compatibility. |
| **P1** | Room detail misses host public presentation and viewer context. | Clients must issue extra reads or implement fragile fallbacks; duplicate application CTA risk. | Enrich read projection only: `host`, current viewer application/participation context, permitted actions. |
| **P1** | Canonical search path differs from VT-API-001. | SDK/client integration and documentation drift. | Declare one versioned canonical path; keep redirect/compatibility adapter during migration. |
| **P1** | Lifecycle/attendance/rating error-code nomenclature differs from spec. | Typed clients cannot rely on one stable code vocabulary. | Adopt backward-compatible aliases or update and version VT-API-001 explicitly. |
| **P2** | Host application query has no status/history/pagination contract. | Larger rooms and host decision audit become harder to navigate. | Add read-model query parameters without changing state transitions. |
| **P2** | Complete response lacks repeat indication. | Client requires a follow-up check to offer repeat affordance. | Add derived `repeat_room_available` response field if retained in spec. |

## Recommended implementation order

1. **M13-B: Read-model contract alignment.** Replace host-room manager stub; add My Matches `hosting` and `history` compatibility; enrich Room detail viewer/host projection. This is read-side work and must not recreate capacity or eligibility in a client.
2. **M13-C: Public API normalization.** Decide/version canonical Search, Rating and error-code names; publish a compatibility map and contract tests before breaking existing Alpha client paths.
3. **M13-D: Contract test matrix.** Add route-level tests asserting response DTO/envelope/status for every row above, including pagination/filter defaults and idempotency replays.
4. **M13-E: Production auth migration.** Replace development actor header outside Alpha runtime while preserving service-level authorization unchanged.

## Verification and limitations

| Check | Result |
|---|---|
| Backend regression (prior M12 verification) | **66/66 passing** on PostgreSQL 16. |
| Alpha client tests (prior M12 verification) | **5/5 passing**; flow uses real backend. |
| Audit execution | Static source/spec review only; no endpoint behavior was modified and no new migration ran. |

## Product-rule confirmation

The audited implementation retains server authority for capacity, availability, skill fit, eligibility and state transitions. In particular, accepted active participants alone consume app capacity; requests and waitlist do not. No new feature, endpoint implementation, database schema change, or domain redesign was made for M13-A.

## References

[1]: `src/platform/http/app.ts` — current HTTP routes, DTOs, middleware and error envelope.
[2]: `src/modules/participation/service.ts` — application/participant transition, locking and availability behavior.
[3]: `src/modules/room/lifecycle-service.ts` — start, auto-start and completion behavior.
[4]: `src/modules/ranking/service.ts` — rating eligibility, uniqueness and batch semantics.
[5]: `VT-API-001_Core-API-Contracts-and-Commands_v0.1.md` — approved API contract.
[6]: `VT-STATE-001_Room-and-Participation-State-Machine_v0.1.md` — approved state model.
[7]: `VT-DATA-001_Core-Data-Model-and-Relationships_v0.1.md` — approved data model.

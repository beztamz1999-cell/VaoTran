# M14-A — Marketplace Lifecycle Audit

**Dự án:** VàoTrận MVP  
**Phạm vi:** Audit-only — Room, Application, Participant, Attendance, Rating, Reliability, API/read model, event/outbox và test coverage  
**Ngày audit:** 21-08-2026  
**Tác giả:** Manus AI

> **Kết luận điều hành.** Core marketplace lifecycle đã có nền tảng domain tương đối hoàn chỉnh: capacity được bảo vệ trong transaction, idempotency và outbox được dùng xuyên các command trọng yếu, lifecycle Room có start/attendance/rating/complete, và reliability có cancellation/no-show/refill. Không tìm thấy **P0 domain-safety blocker** trong phạm vi evidence đã đọc. Tuy nhiên, trạng thái “ready để mở rộng beta” chưa đồng nghĩa “production-ready”: các kịch bản lifecycle liên hoàn vẫn chủ yếu được chứng minh bởi nhiều integration suite tách rời, authentication runtime còn là development actor simulation, và participant completion chưa có state riêng mà được suy ra từ Room `COMPLETED`.[1] [2] [3]

## 1. Phạm vi, phương pháp và giới hạn

Audit đối chiếu state machine, API/data contract đã công bố, service/runtime composition, integration tests M2–M7/M13 và contract artifacts M13-C/D. Mục tiêu là đánh giá **behavior đã có**, không thiết kế lại product hay sửa code. Các nhận định “đã triển khai” chỉ được ghi khi có evidence trong service, composition root, API registry hoặc suite test; nhận định “chưa chứng minh” không đồng nghĩa chắc chắn thiếu code mà là **chưa có evidence end-to-end đủ mạnh trong phạm vi audit**.[1] [4] [5]

| Ký hiệu | Ý nghĩa dùng trong báo cáo |
|---|---|
| **Implemented** | Có command/read path và evidence test hoặc runtime wiring trực tiếp. |
| **Composed-ready** | Các bước tồn tại và đã được kiểm thử theo module, nhưng chưa có một test narrative liên hoàn đại diện. |
| **Gap** | Không thấy behavior/state/contract cần thiết, hoặc semantics chưa được khóa rõ cho consumer. |
| **P0/P1/P2** | P0: có thể phá invariant hoặc gây mất dữ liệu; P1: chặn beta/lifecycle vận hành tin cậy; P2: nợ hợp đồng, observability hoặc UX cần đóng trước production. |

## 2. Tóm tắt lifecycle readiness

| Lifecycle | Trạng thái | Evidence chính | Nhận định audit |
|---|---|---|---|
| Tạo, sửa, publish và cancel Room | **Implemented** | Room command service và M0/M1 test coverage | Room state và public availability được giữ ở backend; cancel có cascade participation qua reliability integration.[4] [6] |
| Capacity, OPEN/FULL và cạnh tranh slot cuối | **Implemented** | M2 integration | Accept chạy trong transaction/lock; chỉ accepted participant giữ slot; race last-slot được kiểm thử.[7] |
| Application `REQUESTED/WAITLISTED/ACCEPTED/REJECTED/WITHDRAWN/EXPIRED` | **Implemented** | Participation service, M2/M4, lifecycle service | `EXPIRED` có evidence khi Room bắt đầu hoặc bị huỷ; pending/waitlisted không tiêu thụ public slot.[2] [7] |
| Participant `ACTIVE/CANCELLED/REMOVED_BY_HOST` | **Implemented** | Participation/reliability services và M2/M5/M7 | Cancel, host removal và owner-linked guest release đều có side effect capacity/reliability phù hợp.[3] [8] |
| Participant `COMPLETED` | **Gap — semantics** | Completion chỉ đổi Room thành `COMPLETED` | Không thấy transition ghi `RoomParticipant.status = COMPLETED`; consumer hiện suy theo Room terminal state và attendance. Đây là gap contract/state rõ ràng, không phải evidence về capacity violation.[2] |
| Manual/auto start và expiry | **Implemented** | Lifecycle service, M3 | `OPEN/FULL → IN_PROGRESS`, manual host-only, auto-start idempotent và pending applications bị expire trong cùng transaction.[2] [9] |
| Attendance và no-show correction | **Implemented** | M3, reliability service | Attendance chỉ hợp lệ với active participant trong Room đang diễn ra; no-show có grace và correction đảo reliability impact.[3] [9] |
| Rating, eligibility và completion gate | **Implemented at runtime** | Ranking service, server composition, M6 | Runtime inject `SkillCompletionRequirements`; Room không complete khi PRESENT participant còn thiếu rating hợp lệ.[5] [10] |
| Reliability, cancellation và emergency refill | **Implemented** | Reliability service, M5 | Early/late/material-change waiver, no-show, host removal và slot loss có ledger/event/refill paths.[3] [8] |
| Read models cho Player/HOST | **Implemented** | M13-B/C/D artifacts | `viewer_context`, host manager, `history`/`hosting`, pagination/action fields và typed Alpha client đã được contract-lock theo hướng additive.[11] [12] |

## 3. State-transition audit

### 3.1 Room và application lifecycle

Room có các transition vận hành cần thiết cho marketplace: pre-start `OPEN/FULL`, `IN_PROGRESS`, `COMPLETED` và cancellation. Lifecycle service khóa Room trong command transaction, kiểm tra quyền HOST ở manual start/complete, cập nhật availability projection và append outbox event trong cùng transaction. Khi start, hệ thống expire các application đang pending và phát `JOIN_REQUEST_EXPIRED`; điều này bảo vệ việc không để join request chưa resolve tồn tại qua thời điểm trận đã bắt đầu.[2]

Application có đủ state phục vụ core join marketplace. Application mới không giữ slot; accept mới tạo participant active và thay đổi status/public availability. Điều này phù hợp với capacity rule đã được giữ từ M2: slot thực chỉ thuộc accepted participant, vì vậy requested/waitlisted không thể làm capacity bị giảm sai.[7]

| Transition/kịch bản | Verdict | Evidence/gap |
|---|---|---|
| `OPEN/FULL → IN_PROGRESS` manual | **Pass** | HOST-only; reject start quá sớm; M3 kiểm thử OPEN và FULL.[2] [9] |
| `OPEN/FULL → IN_PROGRESS` auto | **Pass** | System command có deterministic idempotency key theo Room/scheduled time; race manual-auto phát một start event.[2] [9] |
| Start → expire pending/waitlisted | **Pass** | Repository expiry và outbox `JOIN_REQUEST_EXPIRED` trong start transaction.[2] |
| `IN_PROGRESS → COMPLETED` | **Pass, gated** | Chặn khi attendance unset hoặc requirement rating chưa đạt; runtime inject policy skill/rating.[2] [5] |
| Room cancel → participant/application cascade | **Pass** | Active participants được cancel, pending application expire, refill dừng và host cancellation metric được ghi.[3] |
| `ACTIVE → COMPLETED` participant | **Needs decision** | Không có state participant terminal riêng trong evidence. M14-B cần quyết định: thêm state/projection explicit, hoặc chính thức chuẩn hóa “Room terminal state là completion marker”. |

### 3.2 Participant, attendance và reliability lifecycle

Player cancel trước khi Room start được phân loại `EARLY`, `LATE` hoặc `MATERIAL_CHANGE_WAIVER`. Late cancel áp dụng reliability adjustment, trả capacity, có thể tạo refill, và phát event; cancellation của owner cũng giải phóng các guest seat chưa claimed. No-show áp dụng adjustment nặng hơn, tạo slot-loss/refill khi phù hợp, và reversal `NO_SHOW → PRESENT` đảo penalty đồng thời void loss record liên quan.[3]

Điểm mạnh đáng chú ý là availability không được frontend tự tính: service lấy active participant/no-show count và gọi canonical availability calculator trước upsert projection. Điều này tiếp tục bảo toàn invariant capacity cả khi cancellation/no-show/replacement tạo side effect.[3]

## 4. API và read-model audit

M13-B/C/D đã chuyển read-side từ “frontend tự suy diễn” sang server projection. Detail Room có host/viewer context; Host Manager có accepted/pending/waitlisted projections; My Matches có `pending`, `upcoming`, `in_progress`, `completed`, additive `history`, và `hosting`; Host Applications có cursor/filter xác định. Contract registry và OpenAPI hiện đóng envelope, error codes, idempotency, actor boundary và action semantics cho mobile/web integration.[11] [12]

| API family | Lifecycle support | Audit verdict |
|---|---|---|
| Room create/update/publish/detail/search/cancel/start/complete | Room lifecycle và authoritative availability | **Đủ core**; cần E2E narrative test HTTP dài hơn. |
| Application create/withdraw/list/accept/reject | Join lifecycle | **Đủ core**; waitlist/party/emergency refill cần chứng minh liên hoàn. |
| Participant cancel/remove/attendance | Participation lifecycle | **Đủ core**; semantic “completed participant” cần chốt. |
| Rating eligibility/submit/batch | In-progress rating trước completion | **Đủ runtime enforcement**; vẫn cần host UX flow production. |
| My Matches/Room Detail/Host Manager | Read-side contract | **Đủ cho Alpha current flow**; action fields đã canonicalized additive. |

## 5. Event, outbox và transaction audit

Các command có rủi ro cao được gắn Postgres idempotency gate và append outbox trong cùng transaction. Ví dụ, lifecycle start append `ROOM_MANUALLY_STARTED` hoặc `ROOM_AUTO_STARTED` và mọi `JOIN_REQUEST_EXPIRED`; completion append `ROOM_COMPLETED` trước khi gọi skill/reliability hooks; cancellation/no-show append reliability/capacity events. Runtime khởi tạo một outbox consumer composite cho notification và analytics, cùng scheduler cho auto start, refill expiry, reminders, reconciliation và analytics validation.[2] [3] [5]

| Nhóm event | Coverage audit | Nhận định |
|---|---|---|
| Join/capacity | `JOIN_REQUEST_*`, participant creation/removal, Room full/reopen | Có core event và test race/idempotency. |
| Start/attendance/complete | `ROOM_*_STARTED`, attendance, `ROOM_COMPLETED` | Có transactional evidence trong M3. |
| Reliability/refill | late/early cancel, no-show adjustment, slot loss/recovery, refill lifecycle | Có service orchestration và M5 coverage. |
| Rating/ranking | valid rating, calibration, score/tier/outlier events | Có append logic; cần consumer-facing event schema/version contract chặt hơn trước partner integration. |
| Operational delivery | outbox worker, notification/analytics consumers | Runtime wiring tồn tại; production liveness, retry budget và dead-letter runbook vẫn cần operational drill. |

## 6. Scenario E2E audit

| Scenario yêu cầu | Assessment | Evidence | Gap còn lại |
|---|---|---|---|
| A. Solo request → accept → full → start → attendance → rating → complete | **Composed-ready** | M2 covers request/accept/capacity; M3 covers start/attendance/complete; M6 covers rating gate.[7] [9] [10] | Chưa có một HTTP/actor journey duy nhất khóa toàn bộ chuỗi. |
| B. Player cancel → capacity/reliability/refill | **Implemented** | M5 và reliability service cover classification, capacity reopen, ledger/refill.[3] [8] | Cần chaos/concurrency check ở runbook production. |
| C. Waitlist/replacement đầy Room | **Partially composed** | Waitlist/party/replacement paths có M4/M5/M7 evidence. | Cần narrative test: FULL → loss → candidate/accept → slot recovery, gồm action/read model. |
| D. No-show → reliability + refill | **Implemented service-level** | M3 grace/correction và reliability slot loss/refill hooks.[3] [9] | Cần E2E test scheduler/refill expiry với actor separation. |
| E. HOST cancel Room | **Implemented** | Room-cancel cascade và M5/M7 participant cancellation evidence.[3] [8] | Cần gửi/quan sát notification delivery trong acceptance environment. |
| F. Party/friend/guest participation | **Implemented core** | M4/M7 cover party-aware acceptance, ownership và guest release. | Cần UX/read-model narrative cho mobile/host manager nếu đưa pilot rộng. |

## 7. Gaps, blockers và risk classification

Không có P0 phát hiện từ audit artifact. Điều này không thay thế security/performance penetration test hoặc production load test.

| Priority | Gap / risk | Tác động | Recommended owner / next action |
|---|---|---|---|
| **P1** | Chưa có test narrative độc lập bao trùm A–F qua HTTP actors, outbox assertion và projection assertions trong một lifecycle fixture. | Regression có thể bỏ sót interaction giữa module dù từng module pass. | M14-B: lifecycle acceptance suite. |
| **P1** | Semantics participant completion chưa được explicit: Room complete không transition `RoomParticipant` sang `COMPLETED`. | Consumer có thể suy diễn khác nhau về “trận đã hoàn tất” của participant. | M14-B: quyết định state/read-model contract; chỉ migration khi quyết định yêu cầu. |
| **P1** | Acceptance trong `IN_PROGRESS` được cho phép để emergency refill nhưng chưa có narrative E2E đã đọc cho attendance/reliability sau replacement. | Edge case live-match có nguy cơ contract/read model drift. | M14-B: test accept/refill in-progress và policy boundary. |
| **P1** | Runtime authentication production chưa thay development `X-Actor-User-Id` simulation. | Không phù hợp public pilot/production security boundary. | M14-D: identity/auth rollout, không bypass authorization. |
| **P2** | Event schema cho partner/consumer chưa được versioned/documented ở mức machine-readable tương đương OpenAPI. | Khó tích hợp consumer ngoài và đánh giá breaking change. | M14-C: event contract registry/schema compatibility gate. |
| **P2** | HOST không complete Room: có auto-start nhưng không có auto-complete/escalation policy được xác nhận từ evidence. | Room có thể tồn tại `IN_PROGRESS` quá lâu, ảnh hưởng rating/reliability closure. | M14-C: product decision + scheduler/runbook; không tự động đổi transition trước khi chốt policy. |
| **P2** | Operational proof cho scheduler/outbox retry/DLQ/reconciliation mới là code-level, chưa phải drill có metric/SLO. | Pilot incident recovery chưa được chứng minh vận hành. | M14-D: fault-injection/reconciliation drill và runbook. |
| **P2** | Payment/refund không thuộc lifecycle hiện có. | Không nên biểu diễn cancellation như financial refund trong client/ops. | Product scope decision riêng, không gộp vào M14-B. |

## 8. Lộ trình khuyến nghị

### M14-B — Lifecycle contract closure và acceptance suite

M14-B nên ưu tiên đóng các ambiguity **trước khi** thêm UX mới. Deliverable là một suite lifecycle HTTP/integration có seed fixture cố định, cover đầy đủ A–F; assertions cần kiểm Room/Application/Participant/attendance/rating/reliability, outbox events, idempotency replay và M13 read projections. Cùng phase này cần chốt formal decision cho `participant_completed`: hoặc bổ sung canonical read-only completion marker/state, hoặc tài liệu hóa Room `COMPLETED` là marker duy nhất và bổ sung field projection explicit để frontend không suy diễn.

### M14-C — Pilot operational workflow và event contract

M14-C nên đưa event catalog/schema versioning, notification delivery acceptance, HOST Manager workflow cho attendance/rating/refill, và policy cho Room kẹt `IN_PROGRESS` vào phạm vi product/ops. Phase này chỉ nên bắt đầu sau M14-B để UI không đóng lên state semantics chưa thống nhất.

### M14-D — Production security và resilience gate

M14-D nên thay development actor simulation bằng authentication production, đóng authorization integration tests, thêm CI OpenAPI/event breaking-change gates, scheduler/outbox failure drills, SLO dashboards, backup/restore rehearsal và load/concurrency baseline. Đây là checkpoint phù hợp để ra quyết định public pilot, thay vì suy từ số lượng unit/integration tests hiện có.

## 9. Quyết định readiness

| Đích sử dụng | Verdict | Điều kiện |
|---|---|---|
| Internal development / controlled Alpha | **Go** | Existing regression và M13 contract artifacts hỗ trợ flow core. |
| Closed beta có HOST vận hành thực | **Conditional Go** | Hoàn thành M14-B P1 lifecycle suite và chốt completion semantics. |
| Public pilot / production | **No-Go hiện tại** | Cần production auth, operational drills, monitoring/SLO, event contract discipline và policy xử lý Room `IN_PROGRESS` kéo dài. |

## 10. Thay đổi thực hiện trong M14-A

M14-A **không thay đổi code product, database migration, API behavior, domain invariant hoặc state transition**. Chỉ tạo artifact audit này và cập nhật backlog theo dõi công việc.

## References

[1]: file:///home/ubuntu/upload/VT-STATE-001_Room-and-Participation-State-Machine_v0.1.md "VT-STATE-001 — Room and Participation State Machine"
[2]: file:///home/ubuntu/vaotran-m9-verify/src/modules/room/lifecycle-service.ts "RoomLifecycleService"
[3]: file:///home/ubuntu/vaotran-m9-verify/src/modules/reliability/service.ts "ReliabilityService"
[4]: file:///home/ubuntu/vaotran-m9-verify/src/modules/room/service.ts "RoomService"
[5]: file:///home/ubuntu/vaotran-m9-verify/src/server.ts "Runtime composition root"
[6]: file:///home/ubuntu/vaotran-m9-verify/src/tests/m0-m1.test.ts "M0/M1 integration and invariant tests"
[7]: file:///home/ubuntu/vaotran-m9-verify/src/tests/m2-integration.test.ts "M2 join application and HOST approval tests"
[8]: file:///home/ubuntu/vaotran-m9-verify/src/tests/m5-integration.test.ts "M5 reliability and cancellation tests"
[9]: file:///home/ubuntu/vaotran-m9-verify/src/tests/m3-integration.test.ts "M3 lifecycle and attendance tests"
[10]: file:///home/ubuntu/vaotran-m9-verify/src/tests/m6-integration.test.ts "M6 rating and ranking tests"
[11]: file:///home/ubuntu/vaotran-m9-verify/docs/api/API-REGISTRY.md "M13-C API registry"
[12]: file:///home/ubuntu/vaotran-m9-verify/docs/openapi.yaml "OpenAPI integration contract"

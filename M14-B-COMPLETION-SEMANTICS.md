# M14-B — Completion Semantics

**Phạm vi.** Tài liệu này chốt lại hành vi đang được thực thi và được kiểm chứng bởi acceptance suite M14-B. Đây không phải thay đổi policy hoặc đề xuất migration dữ liệu.

## Kết luận ngắn

Một Room chỉ được xem là hoàn tất khi aggregate Room đạt trạng thái `COMPLETED`. Attendance, reliability adjustment và rating là các khái niệm liên kết với completion nhưng không phải là trạng thái thay thế cho Room. Dữ liệu authoritative vẫn là Room, RoomParticipant, attendance log, rating records và reliability ledger; read model chỉ phục vụ trình bày.

| Khái niệm | Canonical source | Semantics đã kiểm chứng | Hệ quả cho client/worker |
|---|---|---|---|
| Room completion | `rooms.status = COMPLETED` cùng timestamp lifecycle | Terminal; không thể quay lại `OPEN`, `FULL` hoặc `IN_PROGRESS`. | Dùng Room status để xác định trận đã kết thúc, không tự suy diễn từ thời gian lịch. |
| Participant completion | `room_participants` ACTIVE accepted kết hợp attendance | Chỉ participant accepted/ACTIVE thuộc lifecycle Room; attendance được chốt trước terminal transition. | Không tự xây danh sách "đã hoàn thành" từ application hoặc search result. |
| Attendance | Attendance log của participant | `PRESENT`/`NO_SHOW` chỉ hợp lệ ở lifecycle window và được sửa trước completion. | Sau completion, UI không phát hành action chỉnh attendance thường. |
| Rating eligibility | Room completion + participant/rating eligibility policy | Rating có eligibility sau khi Room hoàn tất; duplicate/rating ngoài tư cách bị chặn. | Client chỉ hiển thị action khi server trả allowed state/action; không dùng suy luận UI. |
| Reliability | Reliability ledger/stat + cancellation/no-show command | No-show và cancellation tạo side effect canonical riêng; không phải mọi attendance state đều là penalty. | Worker/read model dùng event/ledger đã committed, không tái tính penalty ở client. |

> **Định nghĩa vận hành:** “Completed participant” không là aggregate mới. Đây là một participant đã được accepted vào Room và nằm trong Room đã `COMPLETED`, với attendance được canonical service ghi nhận. Khi cần presentation, projection phải truy xuất từ authoritative data thay vì duy trì một cờ frontend riêng.

## Thứ tự lifecycle được xác nhận

| Bước | Precondition thực thi | Command/effect | Event hoặc invariant kiểm chứng |
|---|---|---|---|
| 1. Khám phá và join | Room publish/joinable, player không có application active trùng | Search → create application → HOST accept | Capacity chỉ bị giữ khi accepted; duplicate active application bị chặn. |
| 2. Khởi tranh | Room `OPEN` hoặc `FULL`, manual-start đúng time window hoặc auto-start đúng schedule | Start Room | Một transition start canonical; retry không nhân bản outcome. |
| 3. Attendance | Participant accepted/ACTIVE; no-show chỉ sau grace window | Present / no-show / correction trước completion | Attendance constraint và no-show rule được enforce server-side. |
| 4. Completion | Room đã `IN_PROGRESS`; completion policy services được inject ở composition root | Complete Room | Room terminal `COMPLETED`, outbox transactional ghi side effect. |
| 5. Rating/reliability hậu trận | Participant và Room thỏa eligibility riêng | Submit rating; reliability consumer/ledger xử lý events | Duplicate rating và rating không eligible bị từ chối; reliability không bị client tự tính. |

## Event, retry và consistency

Acceptance tests xác nhận commands lifecycle quan trọng ghi transactional outbox trong cùng boundary với state canonical. Case retry dùng idempotency contract, do đó retry cùng command không tạo participant, cancellation record hay lifecycle event thứ hai. Tên event được assertion ở mức aggregate/outbox như implementation hiện hành; consumer phải tiếp tục dựa vào identity của event để deduplicate.

| Area | Kết luận M14-B | Guard cần giữ ở M14-C/D |
|---|---|---|
| Completion and rating | Completion precedes rating eligibility; rating không là tín hiệu độc lập thay Room state. | Version/payload contract cho events rating-completion. |
| No-show | Marking chỉ sau grace rule, tạo reliability side effect ở server. | Operational policy cho room kẹt `IN_PROGRESS` và replay an toàn. |
| Host cancellation | Cancel cascade chạm application/participant liên quan theo authoritative transaction. | HOST operational runbook và event observability. |
| Capacity recovery | Cancellation/removal làm projection slot cập nhật theo canonical capacity formula. | Reconciliation alarm cho projection drift. |

## Nguồn evidence

Các kết luận trên được kiểm chứng trực tiếp trong `src/tests/m14-marketplace-lifecycle.integration.test.ts`, đồng thời đối chiếu service lifecycle, reliability và ranking hiện hành. Suite M14-B không thêm state, API command, event type hay policy mới.

## References

[1]: file:///home/ubuntu/vaotran-m9-verify/src/tests/m14-marketplace-lifecycle.integration.test.ts "M14-B marketplace lifecycle acceptance suite"
[2]: file:///home/ubuntu/vaotran-m9-verify/src/modules/room/lifecycle-service.ts "Room lifecycle service"
[3]: file:///home/ubuntu/vaotran-m9-verify/src/modules/reliability/service.ts "Reliability service"
[4]: file:///home/ubuntu/vaotran-m9-verify/src/modules/ranking/service.ts "Ranking service"

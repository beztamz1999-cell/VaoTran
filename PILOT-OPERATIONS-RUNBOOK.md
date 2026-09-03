# VàoTrận — Pilot Operations Runbook

**Phiên bản:** M9  
**Trạng thái:** Sẵn sàng cho closed pilot  
**Phạm vi:** PostgreSQL, migration, transactional outbox, notification delivery, reconciliation findings và internal operations. Tài liệu này không thay đổi product rules hoặc tự khôi phục business data.

## 1. Mục tiêu vận hành

Pilot dùng PostgreSQL là nguồn dữ liệu chuẩn cho Room, Application, Participant, Party, Reliability, Ranking và notification projection. Hệ thống có transactional outbox; vì vậy recovery phải phục hồi cả bảng nghiệp vụ lẫn `event_outbox`, `event_consumptions` và delivery records trước khi worker tiếp tục chạy. Không được tái tạo participant, availability, ledger hoặc rank bằng script tự phát trong lúc incident.

| Mục tiêu pilot | Target | Cách kiểm chứng |
| --- | ---: | --- |
| **RPO** | Tối đa 24 giờ; tối đa thời điểm backup thành công gần nhất. | Kiểm tra timestamp manifest mỗi ngày và lưu output backup bất biến. |
| **RTO** | Tối đa 4 giờ từ lúc quyết định khôi phục đến khi readiness xanh. | Thực hiện restore drill hàng tháng trên database cô lập. |
| Backup logic | Mỗi ngày một full logical backup PostgreSQL. | `pg_restore --list` phải đọc được archive; checksum manifest phải khớp. |
| Retention | Tối thiểu 14 bản hằng ngày và 4 bản hằng tuần. | Job dọn retention chỉ xóa bản quá hạn sau khi kiểm tra backup mới nhất thành công. |
| Recovery correctness | Không mất migration, outbox, audit hoặc reconciliation evidence trong phạm vi RPO. | So sánh migration ledger, count kiểm soát và chạy reconciliation detect-only. |

> **Nguyên tắc:** Backup là snapshot point-in-time, không phải replication. RPO chỉ được công bố khi backup thành công, mã hóa và manifest đã được xác nhận.

## 2. Chuẩn bị và security boundary

Backup job chạy bằng database role chỉ có các quyền cần thiết để đọc schema/data. Archive và manifest được mã hóa khi lưu tại kho lưu trữ riêng tư, áp dụng quyền tối thiểu; không ghi `DATABASE_URL`, `INTERNAL_OPS_TOKEN`, device token hoặc secret vào log. Mỗi backup có manifest gồm thời điểm UTC, môi trường, PostgreSQL version, app release, migration version cao nhất, filename archive, SHA-256 và người/job tạo.

Trước khi thao tác production hoặc pilot, operator phải ghi incident ticket, correlation ID và thời điểm bắt đầu. Internal inspection chỉ dùng qua mạng private với `INTERNAL_OPS_TOKEN` và `INTERNAL_OPS_ALLOWLIST`; không đưa endpoint `/internal/*` ra public ingress.

## 3. Quy trình backup hằng ngày

Tại host worker hoặc runner được phép, tạo archive custom format để có thể kiểm tra và restore có chọn lọc. Thay các biến bằng secret injection của môi trường; không dán secret vào shell history.

```bash
set -euo pipefail
export PGPASSWORD="$POSTGRES_BACKUP_PASSWORD"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="vaotran-${ENVIRONMENT}-${STAMP}.dump"
MANIFEST="${ARCHIVE}.manifest.json"

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file "$ARCHIVE" \
  "$DATABASE_URL"

pg_restore --list "$ARCHIVE" > /dev/null
SHA256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
```

Sau khi archive được kiểm tra, tạo manifest không chứa credentials, upload archive và manifest vào kho riêng tư đã mã hóa, rồi xác minh checksum sau upload. Chỉ đánh dấu backup thành công khi cả archive, manifest và checksum đều tồn tại. Nếu bất kỳ bước nào thất bại, cảnh báo operator và giữ lại backup gần nhất; không chạy retention cleanup trong ngày đó.

## 4. Migration deployment và rollback

Migration là forward-only theo cặp `.up.sql` / `.down.sql`. Trước release, tạo full backup, chạy migration trên database staging bản sao, sau đó xác nhận migration ledger và readiness trên pilot. Migration M9 gồm `010_pilot_hardening_operations` và `011_pilot_performance_indexes`; hai migration này chỉ thêm tables/audit/index, không sửa product facts.

| Tình huống | Hành động bắt buộc |
| --- | --- |
| Migration chưa bắt đầu | Dừng deploy, sửa migration ở branch chưa phát hành và kiểm tra lại staging. |
| Migration thành công nhưng release app lỗi | Ưu tiên rollback application. Chỉ chạy paired down migration khi migration đó chưa được dùng để tạo dữ liệu cần giữ và đã có backup. |
| Migration lỗi giữa chừng | Đặt API vào maintenance/read-only theo ingress, kiểm tra transaction state và schema, sau đó restore hoặc chạy script khắc phục đã review. Không chạy DDL ngẫu hứng. |
| Cần quay về release trước | Khôi phục app version tương thích trước; schema chỉ rollback sau assessment về data loss và duyệt incident owner. |

Sau mỗi deploy, chạy `healthz`, `readyz`, test command smoke có idempotency key, và xác nhận worker scheduler khởi tạo một lần. Không khởi động nhiều API instance trong pilot Runtime A vì reconciliation/reminder chạy cùng process.

## 5. Restore drill hàng tháng

Restore drill luôn thực hiện trên database cô lập, không dùng production URL và không cho worker connect vào database drill.

1. Chọn archive mới nhất, tải về vùng làm việc private và xác minh SHA-256 đối chiếu manifest.
2. Tạo database drill rỗng với role hạn chế; ghi thời điểm bắt đầu để đo RTO.
3. Chạy `pg_restore --clean --if-exists --no-owner --dbname "$DRILL_DATABASE_URL" "$ARCHIVE"`.
4. Chạy migration runner ở chế độ kiểm tra để xác nhận schema version có thể reapply; không giả định archive luôn đúng phiên bản code hiện tại.
5. Chạy `SELECT 1`, readiness probe, và các count kiểm soát cho `users`, `rooms`, `room_applications`, `room_participants`, `event_outbox`, `notifications`, `reconciliation_runs`.
6. Chạy `ReconciliationService.runOnce()` trên database drill. Findings có thể tồn tại nhưng phải được lưu như evidence; không auto-repair.
7. Kiểm tra `event_outbox` và `event_consumptions` để xác nhận recovery không bỏ qua event chưa publish và không làm mất consumption record.
8. Ghi lại archive ID, checksum, thời gian restore, migration version, readiness, reconciliation summary và kết quả RTO. Hủy database drill sau khi report được phê duyệt.

## 6. Event outbox và notification recovery

Outbox là cầu nối duy nhất từ transaction nghiệp vụ sang notification projection. Nếu worker dừng hoặc deployment bị gián đoạn, không replay event bằng cách gọi lại command nghiệp vụ.

| Triệu chứng | Kiểm tra | Thao tác an toàn |
| --- | --- | --- |
| Pending lag tăng | `GET /internal/outbox?status=PENDING` và internal metrics. | Khôi phục worker/API process; worker claim dùng lock/idempotent consumption. |
| Event dead-letter | Inspect event, error và aggregate context qua internal endpoint. | Sau khi nguyên nhân được sửa, dùng retry internal endpoint cho đúng event; audit bắt buộc được ghi. |
| Delivery dead-letter | Inspect delivery không lộ token thiết bị. | Chỉ retry delivery khi adapter/config đã khắc phục; retry được audit. |
| Projection nghi sai | Chạy reconciliation. | Tạo finding và incident; không sửa projection tự động trong M9. |

Sau restore thật, tạm dừng consumer/delivery scheduler, đánh giá backup age so với RPO, xác nhận app release/schema tương thích, rồi bật lại worker. Theo dõi `vaotran_outbox_pending`, `vaotran_outbox_lag_seconds`, `vaotran_notification_retry`, `vaotran_notification_dead_letter` và error rate cho tới khi ổn định.

## 7. Reconciliation và internal operations

Reconciliation chạy theo interval trong cùng API process của pilot, có single-flight guard. Nó kiểm tra Room availability/status, skill evidence, reliability ledger score, notification preference/dedupe, delivery stuck state và lag gauges. Kết quả được lưu tại `reconciliation_runs` và `reconciliation_findings`; scheduler **không sửa dữ liệu**.

Internal inspection dành cho operator được phép kiểm tra User, Room, Application, Participant, Party, Reliability, Skill Profile, outbox, delivery, findings và metrics. Các thao tác mutate bị giới hạn vào suspend user hoặc retry record retryable/dead-letter; mọi lần gọi ghi `internal_operation_audits` với correlation ID. Operator phải tạo incident và lưu lý do trước khi suspend/retry.

## 8. Incident severity và escalation

| Severity | Ví dụ | Hành động trong pilot |
| --- | --- | --- |
| **P1** | Database không ready, data corruption finding CRITICAL, capacity/state không khớp. | Stop harmful writes nếu cần, tạo backup, giữ evidence, thông báo owner, bắt đầu recovery assessment. |
| **P2** | Outbox/dead-letter tăng, notification delivery lỗi, reconciliation WARNING kéo dài. | Xác định root cause, retry có audit sau khi sửa, theo dõi lag và document outcome. |
| **P3** | Chỉ số latency vượt baseline nhưng không mất dữ liệu. | Thu EXPLAIN/metric không chứa PII, tối ưu theo review, chạy lại benchmark. |

Mọi thay đổi data thủ công sau incident cần migration/script được review, backup ID, correlation ID, operator, justification và verification query. Không dùng internal API như một cơ chế sửa dữ liệu hàng loạt.

## 9. Checklist go/no-go cho pilot

| Điều kiện | Go khi |
| --- | --- |
| Secrets | `DATABASE_URL` và `INTERNAL_OPS_TOKEN` được inject an toàn, không có trong log/repository. |
| Internal boundary | Allowlist private và token đã test deny/allow; ingress không expose `/internal/*`. |
| Backup | Có backup thành công mới nhất, manifest/checksum và owner rõ ràng. |
| Restore | Restore drill đạt RTO target, readiness pass, reconciliation report được lưu. |
| Workers | Chỉ một API process runtime A hoạt động; outbox/notification/reconciliation/reminder intervals đã quan sát. |
| Observability | Metrics, correlation logs, readiness và alert thresholds có dashboard/owner. |
| Regression | Toàn bộ integration suite và migration up/down/reapply pass cho release candidate. |

## 10. Ownership và review

Runbook được review trước mỗi pilot release và sau mỗi incident P1/P2. Các thay đổi RPO/RTO, retention, hạ tầng worker hoặc production authentication phải cập nhật tài liệu này, auth migration plan và deployment checklist cùng lúc.

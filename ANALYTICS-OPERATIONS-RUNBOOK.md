# VàoTrận — Analytics Operations Runbook

**Phiên bản:** M11  
**Phạm vi:** Analytics read-side, event outbox versioning, consumer health, data-quality validation và rebuild derived-only. Tài liệu này **không** cho phép thay đổi canonical product data hoặc tự động khôi phục business state.

> **Nguyên tắc bất biến:** `users`, `rooms`, applications, participants, attendance, reliability, ranking và `event_outbox` là nguồn dữ liệu nghiệp vụ. Các bảng `analytics_*` chỉ là projection để đo lường. Một finding hay rebuild mismatch là evidence để điều tra, không phải lệnh tự động sửa dữ liệu.

## 1. Vận hành thường ngày

Analytics consumer chạy trong cùng API process theo Runtime A, cùng lifecycle với outbox consumer. Quality scheduler cũng chạy cùng process, có single-flight guard và mặc định kiểm tra mỗi 15 phút qua `ANALYTICS_VALIDATION_INTERVAL_MS`. Không chạy nhiều API process cho pilot Runtime A nếu không có cơ chế điều phối scheduler ngoài phạm vi M11.

| Tín hiệu | Kiểm tra | Ngưỡng xử lý pilot | Hành động an toàn |
| --- | --- | --- | --- |
| Consumer lag | `vaotran_analytics_consumer_lag_seconds` và `GET /internal/analytics/health` | Lag tăng liên tục qua nhiều interval hoặc không có `lastProcessedEventTime` dù outbox có work. | Kiểm tra API/worker, database readiness và outbox; không phát lại command nghiệp vụ. |
| Projection failures | `vaotran_analytics_failed_projections_total`, `failedProjectionCount`, `lastFailureCode`. | Bất kỳ failure mới nào cần ticket; failure lặp lại là P2. | Đối chiếu `analytics_projection_failures` và correlation-safe logs, rồi sửa code/schema trước khi retry worker. |
| Unknown contract | `vaotran_analytics_unknown_events_total`, `unknownEventCount`. | Bất kỳ version/event type không hỗ trợ. | Dừng rollout producer mới hoặc deploy projector tương thích trước; event được ghi nhận idempotently nhưng không suy diễn projection. |
| Data quality | `POST /internal/analytics/quality-check`. | Trạng thái khác `PASSED`, hoặc finding `ERROR`. | Lưu run ID/evidence, phân loại drift và điều tra source/projection; không auto-repair. |
| Rebuild comparison | `analytics_rebuild_runs`. | `DRIFT` hoặc `ERROR`. | Giữ before/after metrics, điều tra trước khi quyết định rerun derived projection. |

Tất cả endpoint `/internal/analytics/*` yêu cầu **đồng thời** `INTERNAL_OPS_TOKEN`, header `X-Internal-Ops-Token` khớp token và client IP thuộc `INTERNAL_OPS_ALLOWLIST`. Không expose các route này qua public ingress hoặc dashboard trình duyệt công khai.

## 2. Kiểm tra health và quality

Health là snapshot operational không có PII; quality check tạo immutable validation run cùng findings aggregate. Operator chỉ chạy qua private network sau khi mở incident/ticket, có correlation ID và lý do truy vấn.

```bash
# Chạy từ mạng private; lấy secret bằng secret injection, không đưa vào shell history.
curl --fail --silent --show-error \
  -H "X-Internal-Ops-Token: $INTERNAL_OPS_TOKEN" \
  "$INTERNAL_BASE_URL/internal/analytics/health"

curl --fail --silent --show-error -X POST \
  -H "X-Internal-Ops-Token: $INTERNAL_OPS_TOKEN" \
  "$INTERNAL_BASE_URL/internal/analytics/quality-check"
```

Validation kiểm tra idempotency evidence, event-source provenance của derived facts và dấu hiệu raw identifier trong analytics storage. Response/report chỉ là aggregate; không dùng raw table dump, event payload hoặc logs làm dashboard analytics.

| Validation outcome | Ý nghĩa | Quyết định |
| --- | --- | --- |
| `PASSED` | Không có finding trong các check được M11 hỗ trợ tại thời điểm chạy. | Ghi ticket/check timestamp; tiếp tục theo dõi lag và failures. |
| `WARNING` | Có dấu hiệu cần đối chiếu nhưng không kết luận canonical data sai. | Mở ticket P2/P3, giữ run ID và phân tích version/consumer lag. |
| `FAILED` | Ít nhất một integrity hoặc privacy check phát hiện mismatch. | Dừng rollout analytics mới; giữ evidence, backup trước mọi thao tác derived và escalation. |

## 3. Event contract versioning

`event_version` và `payload_schema_version` được thêm dạng additive vào `event_outbox`; historic rows được đọc là `v1/v1`. Projector M11 chỉ xử lý contract được hỗ trợ. Với version chưa hỗ trợ, nó tăng unknown counter/health, ghi idempotency evidence và **không** biến đổi projection theo giả định.

Khi rollout event schema mới, deploy theo thứ tự sau: (1) deploy projector chấp nhận version mới nhưng vẫn đọc version cũ; (2) kiểm tra quality và unknown counter; (3) bật producer phát version mới; (4) theo dõi lag/failure; (5) chỉ ngừng hỗ trợ version cũ sau retention/replay assessment được duyệt. Không đổi nghĩa payload của cùng một version.

## 4. Triage projection failure hoặc integrity drift

1. Ghi incident/ticket, environment, release, time UTC và correlation ID. Đặt severity P2 nếu failure lặp hoặc quality `FAILED`; P1 chỉ khi phát hiện nguy cơ privacy/corruption vượt ranh giới analytics.
2. Xác minh `GET /health/ready`, outbox lag, `GET /internal/analytics/health` và quality-check. Không gọi lại Create/Accept/Complete Room để “tạo lại” analytics event.
3. Đọc `analytics_projection_failures`, `analytics_validation_runs`, `analytics_validation_findings` và `analytics_rebuild_runs` theo run/event ID. Không export payload có định danh thô vào ticket/chat.
4. Phân loại nguyên nhân: schema-version chưa hỗ trợ, deploy mismatch, consumer/database availability, event ordering, hoặc data-quality drift. Sửa nguyên nhân bằng code/migration đã review và kiểm tra trên database cô lập trước.
5. Chỉ sau khi nguyên nhân được chấp thuận mới thực hiện manual rebuild derived-only theo mục 5. Chạy quality check sau rebuild, lưu before/after metrics và kết luận incident.

## 5. Manual rebuild và before-after validation

Rebuild là thao tác **manual**, không được scheduler gọi. Nó chỉ truncate và replay các bảng analytics derived, không chạm canonical tables hay `event_outbox`. Script có guard rõ ràng để tránh chạy nhầm.

```bash
# Bắt buộc chạy trên staging/restore drill trước. Chỉ operator được phê duyệt thực hiện trên pilot.
export DATABASE_URL="$APPROVED_PRIVATE_DATABASE_URL"
export ANALYTICS_REBUILD_CONFIRM='derived-only'
./node_modules/.bin/tsx scripts/m11-analytics-rebuild.ts
```

Script ghi một row `analytics_rebuild_runs` gồm source/applied count, before metrics, after metrics, drift JSON và error code. `DRIFT` không đồng nghĩa canonical data sai: nó thường phản ánh projection trước rebuild bị thiếu/stale. `ERROR` nghĩa rebuild không hoàn tất; không tiếp tục retry mù quáng. Sau script, quality validation bắt buộc phải `PASSED` trước khi ticket được đóng.

| Trạng thái rebuild | Ý nghĩa | Bước tiếp theo |
| --- | --- | --- |
| `PASSED` | Before/after derived metrics khớp. | Chạy quality check, theo dõi consumer lag sau khi worker tiếp tục. |
| `DRIFT` | Metrics khác nhau trước và sau replay. | Giữ `drift_json`, xác minh source version/failure; quality sau rebuild quyết định projection có nhất quán hay không. |
| `ERROR` | Replay/validation bị dừng. | Giữ error code và logs an toàn; khắc phục nguyên nhân, kiểm tra database cô lập rồi mới rerun. |

## 6. Restore drill và backup

Analytics tables và M11 audit metadata được backup cùng PostgreSQL, nhưng restore drill phải chứng minh hai điều riêng biệt: canonical data khôi phục được và analytics projection có thể validate/rebuild từ outbox. Trên database drill cô lập, sau restore hãy apply migrations, kiểm readiness, chạy quality-check, sau đó chỉ khi được phê duyệt chạy manual rebuild. So sánh `analytics_rebuild_runs` và validation result, rồi hủy database drill sau khi evidence được lưu.

Không xóa `analytics_validation_runs`, `analytics_validation_findings`, `analytics_projection_failures` hoặc `analytics_rebuild_runs` để làm dashboard “xanh”. Đây là audit evidence operational; retention thay đổi phải qua policy/migration được review.

## 7. Handoff và go/no-go

| Điều kiện | Go khi |
| --- | --- |
| Security | Internal token + allowlist deny/allow đã được test; ingress không public `/internal/*`. |
| Versioning | Projector hỗ trợ producer event/payload version đang phát; unknown counter bằng 0 sau rollout window. |
| Consumer | Health có timestamp mới, lag ổn định và không có failure chưa triage. |
| Quality | Scheduled/manual quality run gần nhất `PASSED`; findings được lưu audit. |
| Rebuild | Restore drill/manual rebuild có before-after report và quality hậu rebuild `PASSED`. |
| Regression | Migration `013` down/up/reapply, strict TypeScript và M0–M11 regression đều pass trên PostgreSQL. |

Runbook này được review trước release analytics mới và sau mỗi incident analytics P1/P2. Mọi thay đổi worker topology, retention, event contract hay privacy model yêu cầu cập nhật đồng thời documentation, migration plan và test coverage.

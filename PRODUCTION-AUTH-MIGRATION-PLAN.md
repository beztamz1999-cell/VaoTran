# VàoTrận — Production Authentication Migration Plan

**Phiên bản:** M9  
**Trạng thái:** Kế hoạch migration; không triển khai OTP, OAuth hoặc social login trong M9.

## 1. Mục tiêu và giới hạn

M9 tạo đường biên `AuthContext`, `CurrentUserProvider` và `ActorResolver` tại HTTP boundary. Domain services tiếp tục nhận `actorUserId` như một giá trị đã được xác thực bởi boundary; chúng không biết header development, JWT, OTP hay provider bên ngoài. Điều này cho phép thay authentication mà không sửa Room, Participation, Party, Reliability, Ranking hay Notification business rules.

> **Không phải phạm vi M9:** phát hành identity provider, OTP delivery, OAuth callback, đăng ký tài khoản mới, thay đổi model User, hoặc coi bất cứ claim chưa xác minh nào là actor hợp lệ.

## 2. Trạng thái hiện tại

| Thành phần | Hiện trạng M9 | Quy tắc an toàn |
| --- | --- | --- |
| HTTP actor | `X-Actor-User-Id` development header được resolve qua `ActorResolver`. | Chỉ dùng cho local/controlled pilot; không được tin cậy tại public production ingress. |
| Context | `AuthContext` mang identity đã resolve và correlation metadata. | Không đưa raw credential, token hoặc PII vào log/metric. |
| Domain command | Nhận actor ID đã có từ HTTP boundary. | Không sửa chữ ký business service khi thay provider. |
| Internal operations | `INTERNAL_OPS_TOKEN` + IP allowlist là boundary vận hành riêng. | Không thay thế end-user auth; không dùng token nội bộ để impersonate user. |
| Idempotency | Binding với actor/command/request hash vẫn giữ nguyên. | Migration auth không được làm replay cross-user. |

## 3. Kiến trúc mục tiêu

Production provider thực thi một interface ở transport boundary:

```ts
interface CurrentUserProvider {
  resolve(request: RequestContext): Promise<AuthContext | null>;
}

interface ActorResolver {
  requireActor(request: RequestContext): Promise<AuthContext>;
}
```

`AuthContext` tối thiểu gồm stable `userId`, authentication method, issued/expiry metadata cần thiết để policy boundary quyết định, và correlation ID. JWT raw, refresh token, OTP, external access token, phone number và social profile không đi qua domain command payload hoặc observability pipeline.

Provider production cần xác minh chữ ký/issuer/audience/expiry của credential ở server. Identity mapping từ provider subject sang `users.id` phải được xử lý transactionally, có unique constraint và audit riêng khi implementation authentication được phê duyệt. Không map theo display name hoặc client-supplied UUID.

## 4. Lộ trình rollout không gián đoạn

| Giai đoạn | Thay đổi | Điều kiện qua giai đoạn | Rollback |
| --- | --- | --- | --- |
| **0. Chuẩn bị** | Giữ `HeaderCurrentUserProvider` tại development; đo actor resolution success/failure và đảm bảo logs redacted. | M9 regression + security tests pass. | Không có data migration. |
| **1. Shadow validation** | Thêm production provider ở chế độ verify-only sau ingress; so sánh mapping với header trong pilot kín, không thay actor. | Sai lệch mapping bằng 0 trên sample đã review. | Tắt shadow flag, giữ header provider. |
| **2. Dual-read** | Ưu tiên credential production nhưng vẫn cho phép header development chỉ ở private/test allowlist; metric hóa loại provider. | Auth success/error-rate đạt baseline và no cross-user idempotency conflict. | Chuyển precedence về header trong closed environment. |
| **3. Controlled enforcement** | Tắt header actor ở public ingress; chỉ production provider được `requireActor`. Test client/service account riêng dùng credential hợp lệ. | Incident-free canary theo cửa sổ pilot; on-call đã xác nhận recovery. | Re-enable dual-read feature flag trong thời gian giới hạn và điều tra. |
| **4. Full enforcement** | Xóa acceptance header ở production, giữ implementation chỉ cho test/local. Rotate bootstrap/internal secrets và review audit. | Security review, privacy review, load baseline và backup drill pass. | Rollback app version tương thích; không xóa identity mapping hay audit evidence. |

## 5. Authorization migration

Authentication xác thực ai đang gọi; authorization quyết định họ được làm gì. M9 không được tự suy diễn roles sản phẩm. Khi product policy được phê duyệt, middleware/authorization service phải kiểm tra action-specific permission trước route handler, ví dụ HOST ownership, party ownership hoặc internal operator scope. Không truyền client-supplied `role` xuống domain.

Các service-to-service background jobs không dùng end-user `AuthContext`. Chúng dùng system actor định danh rõ trong audit/event metadata hoặc `null` khi schema đã cho phép, tách khỏi user action. Internal operation token chỉ cấp route scope cụ thể; suspend/retry vẫn yêu cầu audit reason và correlation ID.

## 6. Dữ liệu, privacy và audit

Identity mapping và credentials không được lưu trong `event_outbox.payload_json`, `notifications.params_json`, metrics labels, request logs, reconciliation findings hay internal-operation metadata. Audit chỉ lưu stable actor ID, action, target, outcome, timestamp và correlation ID cần thiết cho trace. Retention/erasure policy của authentication phải được thiết kế cùng legal/privacy spec riêng, không tự thêm trong M9.

Nếu migration thêm bảng identity mapping, migration phải additive, forward-only, có unique constraint provider-subject, foreign key tới `users`, index lookup, và down migration được đánh giá theo khả năng mất evidence. Backfill cần idempotent, chunked, có dry-run/report và không làm downtime dài.

## 7. Test và go/no-go authentication

| Nhóm kiểm thử | Bằng chứng bắt buộc trước enforcement |
| --- | --- |
| Credential validation | Chữ ký, expiry, issuer, audience, malformed token và revoked/unknown subject bị reject an toàn. |
| Identity binding | Một subject luôn map một `users.id`; không thể claim UUID user khác từ client. |
| Authorization | Cross-user / non-HOST / internal-token misuse bị deny; policy không dựa vào client headers. |
| Idempotency | Cùng key khác actor bị reject/replay-safe sau provider switch. |
| Observability | Không có credential/phone/PII trong metric, log hoặc error response; correlation vẫn trace được request. |
| Rollout | Feature flag, canary, rollback rehearsed và on-call runbook đã review. |
| Resilience | Provider timeout/error fail-closed cho protected operation; readiness/alerts phản ánh dependency theo policy đã chốt. |

## 8. Điều kiện rollback

Rollback authentication phải ưu tiên giữ an toàn và không đổi business facts. Có thể rollback provider precedence hoặc app release; không xóa user mapping, auth audit hoặc idempotency records. Nếu provider incident, đặt public writes vào maintenance/read-only khi cần hơn là chấp nhận header/claim không xác thực. Sau rollback, lưu correlation IDs, impact window, authenticated actor evidence và quyết định recovery trong incident record.

## 9. Quyết định cần có trước implementation auth thật

Trước milestone authentication riêng, product/security owner phải phê duyệt: provider (OTP/OAuth/identity platform), account-linking policy, recovery flow, token/session lifetime, device/session revocation, rate limits/anti-abuse, user lifecycle/erasure, role model, service accounts, consent/privacy notices, monitoring ownership và emergency access. Không phần nào trong danh sách này được ngầm coi là đã được M9 quyết định.

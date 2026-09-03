# VT-BUILD-001 — Implementation Note

Dự án cục bộ đang trống và không có `AGENTS.md`. Project đính kèm trong hệ thống hiện không mở được; vì vậy build này bootstrap trực tiếp tại `D:\APP VAOTRAN` theo đúng yêu cầu PostgreSQL thay vì thay đổi product rule hoặc thay thế database bằng MySQL.

## Kiến trúc kỹ thuật

Backend sử dụng **Node.js + TypeScript + Express + PostgreSQL (`pg`)** theo modular monolith. Các module đặt tại `src/modules`: `identity`, `sport`, `room`, và `platform` (lỗi, request context, idempotency, outbox). API REST đặt dưới `/api/v1` và route handler chỉ chuyển đổi HTTP/auth context sang command; mọi invariant nằm trong service/domain layer.

Migration là SQL thuần, phân tách theo đúng discipline của `VT-DATA-001`: foundation identity/sport/outbox/idempotency trước, sau đó room/equipment/change-log/projection. Các migration là additive và có `down` tương ứng để kiểm tra môi trường sạch. Runtime lấy `DATABASE_URL`; không ghi secret vào repository.

Vì authentication MVP có spec riêng, local/dev placeholder chỉ resolve actor từ header `X-Actor-User-Id`. Không endpoint nào nhận `actor_user_id` trong request body. Production adapter có thể thay placeholder bằng phone/OTP mà không tác động Room service.

## Invariant M1

```text
host_slot = host_participates ? 1 : 0
active_accepted_app_participants = 0 ở M1
occupied_slots = host_slot + reserved_external_count + active_accepted_app_participants
available_public_slots = capacity - occupied_slots
```

`RoomAvailabilityProjection` chỉ được cập nhật từ canonical Room data, không là source of truth. Tất cả cập nhật thay đổi `capacity`, `host_participates` hoặc `reserved_external_count` khóa row Room bằng `FOR UPDATE`, tái tính capacity server-side, và từ chối thay đổi làm vượt capacity.

## M1 state và event

Trước lúc bắt đầu, trạng thái publish được derive từ public slots: `OPEN` nếu lớn hơn 0, `FULL` nếu bằng 0. Status terminal (`COMPLETED`, `CANCELLED`) không thể update; cancel chỉ hợp lệ từ `DRAFT`, `OPEN`, `FULL`.

Business mutation, RoomChangeLog, availability projection, IdempotencyKey response và EventOutbox đều được ghi trong cùng transaction. M1 phát sinh các fact: `ROOM_CREATED`, `ROOM_PUBLISHED`, `ROOM_UPDATED`, `ROOM_MATERIAL_CHANGED`, `ROOM_BECAME_FULL`, `ROOM_REOPENED`, và `ROOM_CANCELLED` khi thích hợp.

Material change được audit theo spec: `scheduled_start_at`, `scheduled_end_at`, venue, `price_amount`, `currency`, `equipment policy/options`. Không tự áp dụng material-change waiver ở M1 vì participant/cancellation thuộc milestone sau.

## Khả năng kiểm thử cục bộ

Máy cục bộ hiện có Node.js nhưng chưa cài PostgreSQL client/server, Docker hay Git. Do đó test unit/API dùng fake transactional repository để xác minh công thức capacity, transition, event, audit, error envelope và replay idempotency. Bộ migration runner được sẵn sàng để chạy clean up/down trên PostgreSQL ngay khi `DATABASE_URL` được cung cấp; validation database thực sẽ được ghi rõ là chưa chạy nếu không có database.

## Không thay đổi product rule

Không có capacity cache/client-side counter làm truth; Room không có permanent HOST role; price là integer VND; time lưu UTC; không triển khai join/accept/participant trong M1.

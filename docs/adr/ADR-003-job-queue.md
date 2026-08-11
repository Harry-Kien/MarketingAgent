# ADR-003 — Job queue và durable execution

- **Trạng thái**: ACCEPTED
- **Ngày**: 2026-08-11
- **Nguồn**: Blueprint rev 2 §5 #7, §3.4

## Bối cảnh

Agent run là tác vụ dài, cần checkpoint, retry, timeout, cancellation và dead-letter. Blueprint cũng yêu cầu **transactional outbox**: domain event quan trọng phải được ghi trong cùng transaction với thay đổi domain.

Ứng viên đã xác minh: `pg-boss@12.27.0` (MIT), `graphile-worker@0.17.3` (MIT), `bullmq@6.0.11` (MIT), `temporalio/sdk-typescript@1.22.0` (MIT), `trigger.dev` (Apache-2.0), `inngest` (SSPL-1.0).

## Quyết định

**`pg-boss@12`, pin exact version.** Không thêm Redis. Không thêm workflow server riêng.

## Lý do

1. **Chạy trong chính PostgreSQL đã có.** Không thêm hạ tầng phải vận hành, backup, giám sát. Đây là quyết định vận hành quan trọng nhất cho một người.
2. **Transactional outbox trở nên tự nhiên**: enqueue job và ghi domain change nằm trong cùng một transaction Postgres. Với BullMQ (Redis) điều này bất khả thi — hai hệ thống lưu trữ khác nhau, không có transaction chung.
3. **License MIT sạch.** Inngest dùng SSPL-1.0, §13 buộc công khai Service Source Code nếu cung cấp dưới dạng dịch vụ — chưa kích hoạt ở D1 nhưng mâu thuẫn với D1-7.
4. **Temporal quá nặng**: cần Temporal Server, thêm một hệ thống stateful phải vận hành. Chỉ hợp lý khi đã có đội vận hành.

## Đánh đổi chấp nhận

pg-boss không có UI quản trị và không có tính năng workflow cao cấp (child workflow, signal, versioning của workflow definition) như Temporal. Ta bù bằng:
- State machine tự viết trong `packages/domain` (blueprint §11.4) — chỉ ~11 state, không cần workflow engine tổng quát.
- Agent Control Center tự xây làm UI quản trị.

**Điều kiện xét lại**: nếu throughput vượt khả năng của Postgres, hoặc nếu cần workflow versioning phức tạp. Không xét lại vì lý do thẩm mỹ.

## Hệ quả

- Không có Redis trong M0/M1 (bất biến #17).
- Schema pg-boss nằm trong migration của ta, được backup cùng database.
- Dead-letter là bảng Postgres, query được bằng SQL thường.

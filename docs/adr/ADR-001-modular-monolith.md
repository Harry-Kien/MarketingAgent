# ADR-001 — Integration-first modular monolith

- **Trạng thái**: ACCEPTED
- **Ngày**: 2026-08-11
- **Nguồn**: Blueprint rev 2 §6, phương án A

## Bối cảnh

Một Founder duy nhất vận hành hệ thống. Blueprint yêu cầu mọi hành động ra ngoài (publish, gửi email, trả lời công khai) phải đi qua một cổng approval cưỡng chế ở tầng domain.

Ba phương án đã cân nhắc: (A) modular monolith tự sở hữu domain, (B) n8n làm workflow engine với webapp là UI mỏng, (C) ghép các OSS suite có sẵn.

## Quyết định

**Một deployable modular monolith**: `apps/web` (Next.js) + `apps/worker`, chia sẻ `packages/domain`, một PostgreSQL. Hệ thống ngoài kết nối qua typed adapter trong `packages/integrations`.

**Không tách microservice trong M0/M1.**

## Lý do

1. **Approval Center là giá trị khác biệt của sản phẩm.** Nó chỉ cưỡng chế được nếu mọi hành động ra ngoài đi qua một domain layer ta sở hữu. Phương án B đặt business logic vào JSON của n8n — không test được bằng TDD, không code review được, audit trail phụ thuộc bên thứ ba. Phương án C phân mảnh domain model nên approval xuyên hệ thống gần như không làm được.
2. **Chi phí vận hành cho một người.** A cần 1 database + 2 process. C cần ≥4 hệ thống phải backup và nâng cấp.
3. **License.** A không có ràng buộc copyleft hay chống-SaaS trong đường dẫn quan trọng, giữ D1-7 mở. C cần Dify vào đúng vai trò mà license của Dify cấm.

## Hệ quả

- Boundary được giữ bằng **package**, không bằng network. Ràng buộc dependency giữa package cưỡng chế trong CI.
- `packages/domain` không phụ thuộc framework, không phụ thuộc ORM (xem ADR-002 M2).
- File lớn là tín hiệu sai boundary — review mỗi milestone (R9).
- n8n giữ ở mức **optional adapter** qua REST + signed webhook; business logic không nằm trong n8n.
- Tách microservice sau này vẫn khả thi vì boundary đã rõ, nhưng chỉ làm khi có bằng chứng cần thiết.

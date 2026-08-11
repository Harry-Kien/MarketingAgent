# ADR-002 — ORM và migration tool

- **Trạng thái**: ACCEPTED
- **Ngày**: 2026-08-11
- **Người quyết định**: Founder (phê duyệt blueprint rev 2) + Claude Code (phân tích)
- **Gate**: V5 — `docs/research/prisma-vs-drizzle-verification.md`
- **Liên quan**: ADR-001 (modular monolith), ADR-003 (pg-boss), ADR-007 (RLS)

## Bối cảnh

Solo Marketing OS dùng PostgreSQL làm source of truth. Blueprint đặt ba yêu cầu mà tầng truy cập dữ liệu **phải** đáp ứng, không phải tuỳ chọn:

1. **Row-Level Security** trên mọi bảng thuộc workspace (D1-2).
2. **Trigger append-only** chặn UPDATE/DELETE trên `audit_log` (T11).
3. **CHECK constraint** cưỡng chế bất biến approval: `PUBLICATION.approval_decision_id NOT NULL`, và `APPROVAL_DECISION.actor_user_id` không được là principal agent (§12, §13).

Cộng thêm: `pgvector` cho RAG (§5 #9), transactional outbox chia sẻ transaction với `pg-boss` (§5 #7), và monorepo nhiều package cùng dùng schema.

Ứng viên: Prisma và Drizzle. Cả hai đã được xác minh version và license bằng cách **đọc file LICENSE gốc**, theo R15.

## Quyết định

**Dùng `drizzle-orm@0.45.2` (Apache-2.0) + `drizzle-kit@0.31.10` (MIT), pin exact version.**

## Lý do

Chấm theo tám tiêu chí Founder chỉ định: **Drizzle thắng 5, hoà 2, thua 1** (bảng đầy đủ trong V5).

Ba lý do quyết định, xếp theo trọng số:

1. **Migration là SQL thuần.** Ba yêu cầu bắt buộc ở trên — RLS, trigger, CHECK constraint — không biểu diễn được trong Prisma Schema Language. Với Prisma, ta vẫn phải viết SQL tay trong migration, tức **mất đúng lợi thế chính của Prisma** trong khi vẫn trả chi phí codegen. Với Drizzle, chúng là công dân hạng nhất.

2. **Không có bước codegen.** Schema là TypeScript thường, import trực tiếp giữa các package. Với monorepo, `prisma generate` phải chạy trước typecheck của mọi package phụ thuộc — thêm một mắt xích có thể hỏng trong CI.

3. **Zero runtime dependency và là lớp mỏng trên `pg`.** Quan trọng cho transactional outbox: enqueue job pg-boss **trong cùng transaction** với domain write cần chia sẻ connection, việc này trực tiếp hơn nhiều so với đi qua driver adapter của Prisma.

Bổ sung: `vector` column type và index HNSW là native trong Drizzle (đã xác minh); license của cả hai package sạch, không điều khoản bổ sung.

**Popularity không được tính.** Prisma phổ biến hơn đáng kể. Quyết định dựa trên yêu cầu đã ghi trong blueprint.

## Đánh đổi chấp nhận

**Drizzle vẫn là 0.x — API chưa cam kết ổn định.** Đây là điểm duy nhất Prisma thắng và là rủi ro thật, không được che giấu.

Giảm thiểu, bắt buộc cưỡng chế trong implementation plan:

| # | Biện pháp | Cưỡng chế bằng |
|---|---|---|
| M1 | Pin exact version, cấm `^` và `~` | Lint dependency trong CI |
| M2 | **Type của Drizzle không được rò vào `packages/domain`** — domain khai báo repository interface bằng type của chính nó | Ràng buộc dependency giữa package trong CI |
| M3 | Migration là SQL thuần đã commit — sống sót qua việc đổi ORM | Review |
| M4 | Nâng version là task riêng, có đọc changelog và chạy test | Quy trình |

M2 là kiến trúc đúng bất kể ORM nào, nên không phải chi phí phát sinh vì chọn Drizzle. Nó cũng làm cho quyết định này **đảo ngược được**: đổi sang Prisma sau này là thay một tầng hạ tầng, không phải viết lại domain.

## Phương án đã cân nhắc và loại

**Prisma 7.9.1** — Apache-2.0, sạch về license, và v7 đã gỡ Rust engine nên deployment complexity giảm mạnh so với v6. Loại vì tiêu chí 1 (migration reliability cho nhu cầu cụ thể của ta) và vì tín hiệu churn: Prisma vừa hoàn tất breaking change lớn ở v7 và trong repo đã có một rearchitecture kế tiếp đang phát triển, với ADR nội bộ ghi "feature parity with Prisma 7 is not guaranteed". Với một người vận hành, đó là chi phí bảo trì thật.

**Raw SQL không ORM** — không cân nhắc nghiêm túc: mất type safety trên toàn bộ domain, chi phí quá lớn.

## Hệ quả

- `packages/domain` khai báo repository interface thuần TypeScript, không import Drizzle.
- Tầng hạ tầng implement interface đó bằng Drizzle.
- Migration nằm ở `infra/migrations`, là SQL thuần, gồm cả `CREATE EXTENSION vector;` viết tay.
- RLS policy, trigger append-only, CHECK constraint đều viết trong migration SQL và **có test cưỡng chế** (E3, E4, E14).
- CI có bước lint chặn bảng thuộc workspace mà thiếu `workspace_id`.

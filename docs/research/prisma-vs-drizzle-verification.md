# V5 — Xác minh Prisma và so sánh ORM cho ADR-002

- **Trạng thái**: ✅ **VERIFIED**
- **Ngày thực hiện**: 2026-08-11, ~11:20–11:35 ICT (UTC+7)
- **Gate liên quan**: V5 trong blueprint §Phụ lục B — chặn ADR-002 ở M0
- **Kết luận**: Prisma đã được xác minh đầy đủ. **ADR-002 chọn Drizzle** — xem `docs/adr/ADR-002-orm-and-migrations.md`.

---

## 1. Vì sao V5 tồn tại

Ở bản blueprint đầu tiên, `prisma` là package duy nhất không lấy được metadata — lỗi parse timestamp trong script của tôi, và tôi đã ghi `[NOT VERIFIED]` thay vì đoán. V5 là việc trả nợ đó.

## 2. Prisma — dữ kiện đã xác minh

`[SOURCE-CHECKED — registry.npmjs.org/prisma/latest, 2026-08-11 11:22 ICT]`

| Hạng mục | Giá trị |
|---|---|
| `prisma` (CLI) | **7.9.1** |
| `@prisma/client` | **7.9.1**, publish 2026-07-27 |
| `@prisma/adapter-pg` | **7.9.1**, publish 2026-07-27 |
| License (trường npm) | `Apache-2.0` |
| `engines.node` | `^20.19 \|\| ^22.12 \|\| >=24.0` |
| Repository | `https://github.com/prisma/prisma.git` |
| Runtime dependencies của `prisma` | 6 (`mysql2`, `postgres`, `@prisma/dev`, `@prisma/config`, `@prisma/engines`, `@prisma/studio-core`) |

### License đọc từ file gốc, không tin trường tổng hợp

`[SOURCE-CHECKED — raw.githubusercontent.com/prisma/prisma/main/LICENSE, 2026-08-11 11:26 ICT]`

**Apache License, Version 2.0.** Không có điều khoản bổ sung. Không có hạn chế thương mại, multi-tenant hay hosting. Không có file `LICENSE-*` thứ hai.

Đây là quy trình bắt buộc theo **R15** — bài học từ việc đọc sai license AutoGen.

### Compatibility với môi trường hiện tại

`[SOURCE-CHECKED — máy local, 2026-08-11 11:26 ICT]`

| | Giá trị | Thoả `prisma@7`? |
|---|---|---|
| Node.js local | **v24.14.0** | ✅ (`>=24.0`) |
| npm local | 11.9.0 | ✅ |

### Breaking change của Prisma 7

`[SOURCE-CHECKED — prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7, 2026-08-11 11:30 ICT]`

- **Rust query engine đã bị gỡ bỏ.** Client "Rust-free", ship dưới dạng ES module. Đây là cải thiện lớn về deployment complexity so với Prisma 6.
- **Driver adapter là bắt buộc** cho mọi database. `@prisma/adapter-pg` không còn là tuỳ chọn.
- **ESM bắt buộc**: `"type": "module"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`.
- Node tối thiểu 20.19.0.
- `prisma-client-js` provider deprecated, thay bằng `prisma-client`; trường `output` nay bắt buộc.
- File `prisma.config.ts` mới ở project root.
- **Biến môi trường không còn được nạp tự động** — phải nạp tường minh.
- Client middleware bị gỡ, thay bằng Client Extensions.
- Auto-seeding bị gỡ khỏi migration.
- CLI flag `--skip-generate`, `--skip-seed` bị gỡ.

### Tín hiệu churn kiến trúc

`[SOURCE-CHECKED — context7 /prisma/prisma, 2026-08-11 11:28 ICT]`

Truy vấn tài liệu Prisma trả về nội dung của một hướng kiến trúc **kế tiếp nữa** đang phát triển trong cùng repo: package đổi từ `@prisma-next/*` sang `@prisma/orm-postgres`, một runtime factory mới (`postgres<Contract>({contractJson, url})`), và **PSL bỏ hỗ trợ block `datasource`** — trình thông dịch phát mã lỗi `PSL_UNSUPPORTED_TOP_LEVEL_BLOCK` cho block `datasource` cổ điển. ADR nội bộ của họ ("Thin Core Fat Targets") ghi rằng "feature parity with Prisma 7 is not guaranteed".

Nghĩa là: Prisma vừa hoàn tất một breaking change lớn (v7) và **đã đang xây dựng một thay đổi lớn tiếp theo**. Với một người vận hành, đây là chi phí bảo trì thật, không phải suy đoán.

## 3. Drizzle — dữ kiện đã xác minh

`[SOURCE-CHECKED — registry.npmjs.org, 2026-08-11 11:22 ICT]`

| Hạng mục | Giá trị |
|---|---|
| `drizzle-orm` | **0.45.2**, publish 2026-03-27 |
| `drizzle-kit` | **0.31.10**, publish 2026-03-17 |
| License `drizzle-orm` | `Apache-2.0` — **đọc từ file gốc**, không điều khoản bổ sung |
| License `drizzle-kit` | `MIT` |
| **Runtime dependencies của `drizzle-orm`** | **0** |
| peerDependencies liên quan | `pg >=8`, `postgres >=3`, `@opentelemetry/api ^1.4.1`, `@electric-sql/pglite >=0.2.0` |

`[SOURCE-CHECKED — raw.githubusercontent.com/drizzle-team/drizzle-orm/main/LICENSE, 2026-08-11 11:26 ICT]` — Apache License 2.0, không điều khoản bổ sung.

### Migration

`[SOURCE-CHECKED — orm.drizzle.team/docs/migrations, 2026-08-11 11:30 ICT]`

- `drizzle-kit generate` — sinh **file SQL thuần**, so schema TypeScript với snapshot trước đó, hỏi developer khi phát hiện rename.
- `drizzle-kit migrate` — áp dụng migration, lưu lịch sử trong database để không chạy lại.
- `drizzle-kit push` — áp thẳng, dùng cho prototyping.
- `drizzle-kit pull` — database-first, sinh TypeScript từ schema có sẵn.
- Migration lưu dưới dạng **plain SQL trong thư mục có timestamp**, kèm `snapshot.json` theo dõi trạng thái schema.

### pgvector

`[SOURCE-CHECKED — orm.drizzle.team/docs/guides/vector-similarity-search, 2026-08-11 11:33 ICT]`

Drizzle hỗ trợ **native**: column type `vector('embedding', { dimensions: 1536 })` từ `drizzle-orm/pg-core`, và index HNSW khai báo qua API index có sẵn: `index('embeddingIndex').using('hnsw', table.embedding.op('vector_cosine_ops'))`.

Lưu ý đã ghi nhận: `CREATE EXTENSION vector;` phải tự viết trong một migration — Drizzle không tự sinh.

Khả năng tương đương của Prisma với pgvector: **`[NOT VERIFIED]`** — trang tài liệu tôi truy cập (TypedSQL) không đề cập. Quyết định ADR-002 **không** dựa trên điểm này ở phía Prisma; nó dựa trên năng lực đã xác minh của Drizzle.

## 4. Chấm theo tám tiêu chí Founder yêu cầu

| # | Tiêu chí | Prisma 7.9.1 | Drizzle 0.45.2 | Thắng |
|---|---|---|---|---|
| 1 | **Migration reliability** | Migration engine trưởng thành, drift detection qua shadow DB. Nhưng schema DSL (PSL) **không biểu diễn được** RLS policy, trigger, hay CHECK constraint phức tạp — những thứ blueprint bắt buộc | Migration là **SQL thuần đọc và sửa được**. RLS, trigger append-only, CHECK constraint là công dân hạng nhất | **Drizzle** |
| 2 | **Type safety** | Rất mạnh, nhưng qua bước codegen `prisma generate` | Rất mạnh, **suy ra trực tiếp từ schema TypeScript**, không codegen | Hoà, nghiêng Drizzle |
| 3 | **Transaction support** | `$transaction` đầy đủ | `db.transaction()` đầy đủ; là lớp mỏng trên `pg` nên **chia sẻ connection với pg-boss trong cùng transaction dễ hơn** | **Drizzle** |
| 4 | **PostgreSQL support** | Tốt | Tốt + **pgvector native đã xác minh** | **Drizzle** |
| 5 | **Monorepo ergonomics** | Bước codegen phải chạy trước typecheck ở mọi package phụ thuộc; thêm một mắt xích vào CI | Schema là TypeScript thường, import trực tiếp giữa package | **Drizzle** |
| 6 | **Deployment complexity** | Cải thiện lớn ở v7 (bỏ Rust engine), nhưng vẫn có 6 runtime dep, ESM bắt buộc, `prisma.config.ts`, driver adapter bắt buộc | **0 runtime dependency** | **Drizzle** |
| 7 | **License** | Apache-2.0, đọc từ file gốc, sạch | Apache-2.0 + MIT, đọc từ file gốc, sạch | **Hoà** |
| 8 | **Long-term maintenance** | Công ty có vốn, lịch sử dài. Nhưng vừa breaking v7 và **đã đang xây rearchitecture tiếp theo** | **Vẫn 0.x — API chưa cam kết ổn định.** Đây là điểm yếu thật của Drizzle | **Prisma** |

**Kết quả: Drizzle thắng 5, hoà 2, thua 1.**

Tiêu chí quyết định không phải popularity (Prisma phổ biến hơn nhiều) mà là **tiêu chí 1** — blueprint bắt buộc RLS (D1-2), trigger append-only cho audit (T11), và CHECK constraint cưỡng chế bất biến approval (§12). Với Prisma, cả ba thứ này đều phải viết SQL tay trong migration, tức là **mất đúng cái lợi thế chính của Prisma** trong khi vẫn phải trả chi phí codegen và ESM migration.

## 5. Rủi ro của quyết định và cách giảm thiểu

Rủi ro thật: **Drizzle vẫn 0.x**. Minor bump có thể mang breaking change.

Giảm thiểu, sẽ được cưỡng chế trong plan:

1. **Pin exact version** — không dùng `^` hay `~` cho `drizzle-orm` và `drizzle-kit`.
2. **Không để type của Drizzle rò vào `packages/domain`.** Domain định nghĩa repository interface bằng type của chính nó; implementation Drizzle nằm ở tầng hạ tầng. Đổi ORM là đổi một tầng, không phải viết lại domain.
3. Migration là **SQL thuần đã commit** — chúng sống sót qua việc đổi ORM.
4. Đọc changelog trước mỗi lần nâng version; nâng version là một task riêng có test.

Điểm 2 là kiến trúc đúng bất kể chọn ORM nào, nên đây không phải chi phí phát sinh vì Drizzle.

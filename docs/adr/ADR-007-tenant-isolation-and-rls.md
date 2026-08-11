# ADR-007 — Tenant isolation và phạm vi RLS

- **Trạng thái**: ACCEPTED
- **Ngày**: 2026-08-11
- **Nguồn**: Quyết định D1 của Founder (blueprint rev 2 §2.1), T6, R17

## Bối cảnh

Founder chốt: single-workspace-first **là trạng thái dữ liệu**, không phải giả định trong code. Domain model, authorization, audit, agent context và credential reference phải multi-tenant-ready ngay từ Slice 1.

T6 (cross-workspace leak) là P0 và đắt gấp bội nếu thêm sau.

## Quyết định

**Phòng thủ ba lớp**, không lớp nào được coi là đủ một mình:

| Lớp | Cơ chế | Chặn được gì |
|---|---|---|
| 1 — Ứng dụng | Tenant-scoped context bắt buộc; cấm truy cập DB không qua context này | Lỗi lập trình thông thường |
| 2 — Database | **PostgreSQL Row-Level Security** trên mọi bảng thuộc workspace | Query quên `WHERE workspace_id` |
| 3 — Schema | `workspace_id NOT NULL` + FK; migration lint từ chối bảng thuộc workspace mà thiếu cột | Bảng mới quên tenancy |

Phạm vi RLS: **mọi bảng thuộc workspace**. Bảng toàn cục (ví dụ `agent_definition` dùng chung, bảng migration) được liệt kê tường minh trong một allowlist có review, không phải mặc định.

Ứng dụng kết nối bằng DB role **không có** `BYPASSRLS`. Migration chạy bằng role riêng.

## Lý do

- RLS là lớp chặn cuối ở nơi dữ liệu thực sự nằm. Nó vẫn hoạt động khi code ứng dụng sai — mà code ứng dụng **sẽ** sai ở đâu đó trong vòng đời dự án (R17).
- Chỉ dựa vào tầng ứng dụng nghĩa là mọi endpoint mới là một cơ hội rò rỉ.
- Chi phí thêm RLS ở ngày đầu là một migration; chi phí thêm sau khi có 40 bảng và dữ liệu thật là một dự án.

## Bất biến kèm theo

1. **Không hard-code `workspace_id`** ở bất kỳ đâu trong domain, policy hay agent runtime.
2. **`AgentRun` mang `workspace_id`**; tool call tới resource khác workspace bị runtime từ chối và ghi `policy.violation` (D1-3).
3. **`AuditLog.workspace_id` bắt buộc**; không query audit nào chạy được thiếu tenant scope (D1-4).
4. **`Integration` và `CredentialReference` mang `workspace_id`**; resolve secret bắt buộc nhận tenant context; log của lần resolve thất bại không chứa phần nào của secret (D1-5).
5. `AuditLog` là append-only, cưỡng chế bằng trigger **và** REVOKE quyền UPDATE/DELETE trên DB role của app.

## Bằng chứng bắt buộc

| Gate | Nội dung |
|---|---|
| **E14** | Mọi endpoint đọc/ghi: request tenant B trên resource A trả 404/403 và **không rò rỉ sự tồn tại** của resource |
| **E15** | `AgentRun` tenant B không đọc được `KnowledgeChunk`/`ContentItem`/`ResearchFinding` của A |
| **E16** | Resolve `CredentialReference` của A từ context B ⇒ fail; log không chứa secret |

Ba test này chạy trên **mọi** endpoint và **mọi** tool, không phải trên mẫu đại diện.

## Điều KHÔNG thuộc ADR này

Tenant isolation **không phải** SaaS provisioning. Billing, public signup, self-service provisioning, marketplace và white-label administration nằm ngoài phạm vi M0/M1 theo D1.b, và không tồn tại dưới bất kỳ hình thức nào kể cả nút disabled (E17).

# M0 + M1 — Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement each sub-plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Nguồn**: [Blueprint rev 3](../specs/2026-08-11-solopreneur-ai-marketing-os-design.md) · [ADR-001…008](../../adr/)
**Baseline commit**: `8a37a72` — `docs: approve Solo Marketing OS architecture baseline`
**Ngày lập**: 2026-08-11

---

## 1. Mục tiêu của M0 + M1

Đưa **Campaign Execution Spine** chạy end-to-end trên sandbox, truy vết được từ business goal tới bài đã đăng, với approval được cưỡng chế ở tầng domain và database.

Chuỗi phải chạy được:

```
Goal → Campaign → Brief → Task graph → Research → Content → QA
     → ApprovalRequest → Founder duyệt → Publication (sandbox)
     → Event → Report → Audit truy ngược đủ chuỗi
```

**Không** phải mục tiêu: Journey, CRM, Analytics đầy đủ, kênh thật, 11 agent còn lại.

## 2. Vì sao phân rã thành 5 plan

Spec bao trùm nhiều subsystem. Một plan khổng lồ sẽ không review được và không có điểm dừng an toàn. Mỗi plan dưới đây **tự tạo ra phần mềm chạy được và kiểm thử được tại boundary của nó** — reviewer có thể chấp nhận P1 mà từ chối P2.

| Plan | Deliverable độc lập có thể review | Tasks |
|---|---|---|
| **P0** | `npm run verify` xanh; Postgres + pg-boss + OTel + health endpoint chạy thật; CI gate hoạt động. Chưa có business feature nào | 10 |
| **P1** | Domain + schema + RLS + audit + state machine. Chứng minh được bằng test rằng cross-workspace bị chặn và approval không thể giả mạo | 13 |
| **P2** | 4 agent chạy với fake provider tất định; approval request sinh ra đúng; agent chưa activated bị từ chối | 12 |
| **P3** | 5 trang Founder dùng được bằng bàn phím, đủ 7 state, đạt WCAG 2.2 AA, tiếng Việt đúng C1/C2 | 11 |
| **P4** | Golden Sequence E2E xanh trên browser thật; trace OTel đầy đủ; Meta adapter sandbox có error taxonomy | 9 |

**Tổng: 55 task.**

## 3. Dependency graph

```
        ┌──────────────────────────────┐
        │ P0 — Platform Foundation     │
        │ monorepo · Postgres · pg-boss│
        │ OTel · CI gates              │
        └───────────────┬──────────────┘
                        │ (bắt buộc trước mọi thứ)
                        ▼
        ┌──────────────────────────────┐
        │ P1 — Workspace, Tenancy,     │
        │      Core Domain             │
        │ RLS · audit · state machine  │
        │ campaign aggregate · outbox  │
        └───────┬──────────────┬───────┘
                │              │
        ┌───────▼──────┐  ┌────▼─────────────────┐
        │ P2 — Agent   │  │ P3 — Web Experience  │
        │ runtime +    │  │ Sổ điều hành ·       │
        │ approval     │  │ Approval Center ·    │
        │ policy       │  │ State Ribbon         │
        └───────┬──────┘  └────┬─────────────────┘
                │              │
                └──────┬───────┘
                       ▼
        ┌──────────────────────────────┐
        │ P4 — Meta Sandbox, Telemetry │
        │      Golden Sequence E2E     │
        └──────────────────────────────┘
```

**P2 và P3 chạy song song được** sau khi P1 xong — chúng không chạm cùng file. P3 dùng dữ liệu seed cho tới khi P2 sẵn sàng; P4 nối hai nhánh lại.

**Không plan nào được bắt đầu trước khi plan phụ thuộc của nó đã pass toàn bộ acceptance criteria.**

## 4. Đường dẫn plan con

| | File |
|---|---|
| P0 | [`2026-08-11-p0-platform-foundation.md`](2026-08-11-p0-platform-foundation.md) |
| P1 | [`2026-08-11-p1-workspace-tenancy-domain.md`](2026-08-11-p1-workspace-tenancy-domain.md) |
| P2 | [`2026-08-11-p2-agent-runtime-approval.md`](2026-08-11-p2-agent-runtime-approval.md) |
| P3 | [`2026-08-11-p3-founder-web-experience.md`](2026-08-11-p3-founder-web-experience.md) |
| P4 | [`2026-08-11-p4-meta-sandbox-golden-sequence.md`](2026-08-11-p4-meta-sandbox-golden-sequence.md) |

## 5. Sai lệch so với repo structure trong blueprint §Phụ lục A

Blueprint liệt kê 9 package. Plan bổ sung **hai** package, cả hai đều bắt nguồn từ ADR đã duyệt chứ không phải phát sinh tuỳ tiện:

| Package thêm | Vì sao | ADR |
|---|---|---|
| `packages/db` | ADR-002 M2 yêu cầu **type của Drizzle không được rò vào `packages/domain`**. Cần một tầng riêng chứa schema Drizzle, repository implementation và migration runner | ADR-002 |
| `packages/model-gateway` | ADR-004 đặt tên gói này tường minh | ADR-004 |

`packages/ui` được gộp vào `apps/web/src/ui` **cho tới khi có consumer thứ hai**. Tách một package chỉ có một consumer là chi phí không có lợi ích (YAGNI). Khi có app thứ hai thì tách, và đó là task riêng.

## 6. Bất biến áp cho mọi plan

Sao chép nguyên văn từ chỉ đạo của Founder. Mọi task ngầm định bao gồm danh sách này.

1. Single workspace **không được hard-code**.
2. Mọi entity workspace-owned có `workspace_id`.
3. Authorization cưỡng chế ở **server**.
4. **Không dùng `quality_score` để cấp execution permission.**
5. Agent chưa activated không tạo `AgentRun` và không gọi model.
6. Chỉ **bốn** agent được activated trong M1: Orchestrator, Research, Content, QA/Brand Safety.
7. Mọi external action đi qua owned domain policy/approval layer.
8. Journey không được tạo stub, enum hoặc cột "để dành".
9. Billing/signup/provisioning/marketplace/white-label **không tồn tại** trong M0/M1.
10. n8n, Dify, AutoGen, Inngest, Temporal **không phải dependency** của Slice 1.
11. Meta chỉ sandbox/dry-run.
12. Không đọc hoặc nhập dữ liệu thật từ AIAGENTSME trong M0/M1.
13. Không tạo fake-success integration.
14. Không gọi hệ thống là production-ready nếu chưa có production evidence.
15. Không tách microservice trong M0/M1.
16. PostgreSQL và OpenTelemetry có mặt từ nền tảng đầu tiên.
17. Không thêm Redis nếu pg-boss đáp ứng.
18. UI theo hướng **Sổ điều hành** và **State Ribbon** đã duyệt.

## 7. Phiên bản chốt — dùng exact, cấm `^` và `~`

Đã xác minh trên npm registry ngày 2026-08-11.

| Package | Version | License |
|---|---|---|
| `next` | `16.3.0` | MIT |
| `react` / `react-dom` | `19.2.8` | MIT |
| `typescript` | `7.0.2` | Apache-2.0 |
| `drizzle-orm` | `0.45.2` | Apache-2.0 |
| `drizzle-kit` | `0.31.10` | MIT |
| `pg-boss` | `12.27.0` | MIT |
| `ai` | `7.0.59` | Apache-2.0 |
| `@ai-sdk/anthropic` | `4.0.37` | Apache-2.0 |
| `better-auth` | `1.6.26` | MIT |
| `zod` | `4.4.3` | MIT |
| `@opentelemetry/sdk-node` | `0.221.0` | Apache-2.0 |
| `tailwindcss` | `4.3.3` | MIT |
| `vitest` | `4.1.10` | MIT |
| `@playwright/test` | `1.62.1` | Apache-2.0 |

Runtime: Node **24.14.0**, npm **11.9.0**, PostgreSQL **17** + `pgvector`.

## 8. Bằng chứng E1–E17 ánh xạ sang plan

| Bằng chứng | Plan sở hữu |
|---|---|
| E1 lint + typecheck | P0 |
| E2 state machine transitions | P1 |
| E3 `APPROVED` không có `ApprovalDecision` ⇒ fail ở DB | P1 |
| E4 actor agent tạo `ApprovalDecision` ⇒ fail | P1 |
| E5 contract test domain ↔ sandbox adapter | P4 |
| E6 E2E Golden Sequence trên browser thật | P4 |
| E7 screenshot desktop + mobile, visual critique | P4 |
| E8 cross-workspace | P1 |
| E9 prompt injection regression | P2 |
| E10 secret scan | P0 |
| E11 accessibility + keyboard | P3 |
| E12 audit truy ngược `publication_id` → `goal_id` | P1 (schema) · P4 (chuỗi đầy đủ) |
| E13 render tiếng Việt | ✅ đã xong ở V6; P3 kiểm lại trên UI thật |
| E14 tenant isolation mọi endpoint | P1 (nền) · P3 (route) |
| E15 tenant-aware agent context | P2 |
| E16 tenant-aware credential | P1 (schema) · P4 (adapter) |
| E17 không có D1.b trong repo | P0 (CI gate) |

## 9. Điều kiện ra của M0 + M1

Chỉ khi **toàn bộ** E1–E17 pass với bằng chứng chạy được. Khi đó tuyên bố duy nhất được phép là:

> "Campaign Execution Spine chạy end-to-end trên sandbox có bằng chứng."

**Không** dùng: `production-ready`, `hoàn thành`, `ổn định`, `an toàn`.

## 10. Gate còn treo, không chặn M0/M1

V1 (Zalo), V2 (GA4 quota), V3 (GSC quota), V4 (benchmark Journey/Analytics), V7 (license Dify). Chặn M4/M5, đã ghi trong blueprint §Phụ lục B.

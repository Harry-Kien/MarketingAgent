# Traceability Matrix — Blueprint rev 3 → ADR → Plan → Task → Evidence

**Ngày**: 2026-08-11 · **Phạm vi**: M0 + M1 · **Tổng task**: 55

---

## 1. Spec requirement → task → bằng chứng

### 1.1 Quyết định D1 — Tenancy

| Yêu cầu | ADR | Plan · Task | Bằng chứng |
|---|---|---|---|
| D1-1 `workspace_id` mọi entity | ADR-007 | P1 T1 (guard), T4–T10 (migration) | migration guard trong `verify` |
| D1-2 Tenant isolation ở server | ADR-007 | P1 T4 (RLS), T5 (`withTenant`) · P3 T4 (session) | E8, E14 |
| D1-3 Tenant-aware agent context | ADR-007 | P2 T7 (runtime), T10 (RunStore) | **E15** |
| D1-4 Tenant-aware audit | ADR-007 | P1 T4 | E8, E12 |
| D1-5 Tenant-aware integration + credential | ADR-007 | P4 T3 | **E16** |
| D1-6 Test ngăn truy cập chéo | ADR-007 | P1 T12 (12 bảng) · P3 T8 (route) | **E8**, **E14** |
| D1-7 Không chặn đường lên SaaS | ADR-001, ADR-007 | P0 T10 (scope guard) | **E17** |
| D1.b Không billing/signup/… | — | P0 T10 | **E17** |

### 1.2 Bất biến Founder (18 mục)

| # | Bất biến | Plan · Task | Cưỡng chế bằng |
|---|---|---|---|
| 1 | Single workspace không hard-code | P1 T5, P3 T4 | Test: tham số client bị bỏ qua |
| 2 | `workspace_id` mọi entity | P1 T1 | `lint:migrations` |
| 3 | Authorization ở server | P3 T4, T8, T9 | Test unauthorized + cross-workspace |
| 4 | **`quality_score` không cấp quyền** | P2 T12 | `lint:authz` |
| 5 | Agent chưa activated không tạo run, không gọi model | P2 T7 | Test spy trên provider |
| 6 | Đúng 4 agent ở M1 | P1 T10, P2 T9 | Test đếm |
| 7 | External action qua domain policy | P2 T8, P4 T5 | 3 refusal có test |
| 8 | Journey không stub/enum/cột để dành | — | Self-review §3, `lint:scope` |
| 9 | Không billing/signup/… | P0 T10 | E17 |
| 10 | n8n/Dify/AutoGen/Inngest/Temporal không phải dependency | P0 T10 | `lint:versions` forbidden list |
| 11 | Meta chỉ sandbox | P4 T4, T9 | grep + badge trung thực |
| 12 | Không nhập dữ liệu thật từ AIAGENTSME | — | Không task nào đọc repo đó |
| 13 | Không fake-success integration | P4 T4, T9 | Sandbox trả lỗi thật; badge `Chưa triển khai` |
| 14 | Không gọi production-ready khi thiếu bằng chứng | Mọi plan | Bảng Evidence Tiers |
| 15 | Không microservice | ADR-001, P0 | Một deployable unit |
| 16 | PostgreSQL + OTel từ nền tảng đầu | P0 T4–T9 | Health 503 thật, worker log |
| 17 | Không Redis nếu pg-boss đủ | ADR-003, P0 T7 | `lint:versions` chặn `redis`, `ioredis`, `bullmq` |
| 18 | UI Sổ điều hành + State Ribbon | P3 T1, T2, T5 | `lint:design`, test component |

### 1.3 Module blueprint → phạm vi M1

| Module §B3 | M1 | Plan |
|---|---|---|
| 1 Today | ✅ rút gọn | P3 T8 |
| 2 Business & Brand Brain | ✅ tối thiểu (voice, claim allow/block) | P2 T9 dùng; schema P1 |
| 3 Research & Intelligence | ✅ finding + citation + nhãn verification | P1 T7, P2 T9 |
| 5 Campaign Workspace | ✅ | P1 T6, P3 T8 |
| 6 Content Studio | ✅ version + citation | P1 T7, P3 T9 |
| 14 Analytics | ✅ **một** report có freshness | P3 T10, P4 T7 |
| 15 Agent Control Center | ✅ tối thiểu (run, cost, state) | P2 T6, T10 |
| 16 Approval Center | ✅ **đầy đủ** | P1 T8, P3 T9 |
| 17 Integrations | ✅ status trung thực | P4 T9 |
| 18 Audit | ✅ | P1 T4, T13 |
| 4, 7, 8, 9, 10, 11, 12, 13 | ❌ M2–M6 | — |

### 1.4 Threat model → task

| Threat | Ưu tiên | Plan · Task | Test |
|---|---|---|---|
| T1 Publish trái phép | P0 | P4 T5 | 3 refusal |
| T2 Publish nhầm nội dung | P0 | P1 T9, P4 T5 | hash drift |
| T3 Prompt injection | P0 | P2 T3, T4, T11 | **E9** 12 payload |
| T4 Rò rỉ secret | P0 | P0 T2, T3, T9 · P4 T1, T3 | **E10** + redact test |
| T5 PII qua LLM | P0 | P2 T2 (gateway là điểm duy nhất) | ⚠ masking field-level → M4 |
| T6 Cross-workspace | P0 | P1 T4, T5, T12 · P3 T4 | **E8**, **E14** |
| T7 Webhook giả | P1 | P4 T7 | constant-time + replay |
| T8 SSRF | P1 | P4 T2 | 11 test |
| T9 Cạn ngân sách | P1 | P2 T2 | budget cứng · ⚠ per-day → P4 backlog |
| T10 Vượt quota nền tảng | P1 | — | ⚠ **M2** — sandbox chưa có quota thật |
| T11 Sửa audit | P1 | P1 T4 | trigger + REVOKE |
| T12 Bịa nguồn | P1 | P2 T5 (citation bắt buộc) | ⚠ verify URL sống → M2 |
| T13 XSS | P1 | P3 (React escape) | ⚠ sandboxed iframe khi có preview → M2 |
| T14 Chiếm phiên | P1 | P3 T4 (better-auth) | ⚠ test session rotation → M2 |
| T15 Upload file độc | P2 | — | ❌ Không có upload ở M1 |
| T16 Nhầm tài khoản đích | P2 | P4 T5, T9 | resolve lại lúc execute |
| T17 Token hết hạn giữa chừng | P2 | P3 T9 | chặn approve khi disconnected |

### 1.5 Bằng chứng E1–E17 → task sở hữu

| E | Nội dung | Plan · Task |
|---|---|---|
| E1 | lint + typecheck | P0 T10 |
| E2 | State machine transitions | P1 T3 |
| E3 | `APPROVED` không thiếu decision | P1 T3 + T9 |
| E4 | Agent không tạo được decision | P1 T8 |
| E5 | Contract test adapter | P4 T4 |
| E6 | E2E Golden Sequence | P4 T8 |
| E7 | Screenshot + visual critique | P4 T8 Step 5 |
| E8 | Cross-workspace | P1 T12 |
| E9 | Prompt injection | P2 T11 |
| E10 | Secret scan | P0 T10 |
| E11 | A11y + keyboard | P3 T11 |
| E12 | Audit truy ngược | P1 T13 + P4 T8 |
| E13 | Render tiếng Việt | ✅ V6 xong; P3 T11 kiểm lại |
| E14 | Tenant isolation mọi endpoint | P1 T12 + P3 T8 |
| E15 | Tenant-aware agent context | P2 T10 |
| E16 | Tenant-aware credential | P4 T3 |
| E17 | Không có D1.b trong repo | P0 T10 |

---

## 2. Cổng CI tích luỹ

Sau P4, `npm run verify` chạy **chín** cổng:

| Cổng | Thêm ở | Bảo vệ |
|---|---|---|
| `lint:versions` | P0 T10 | Exact version, dependency cấm |
| `lint:scope` | P0 T10 | D1.b (E17) |
| `lint:secrets` | P0 T10 | E10 |
| `lint:migrations` | P1 T1 | D1-1, D1-2 |
| `lint:purity` | P1 T13 | ADR-002 M2 |
| `lint:authz` | P2 T12 | Bất biến #4 |
| `lint:design` | P3 T2 | C1, C2, anti-AI-look |
| `lint:i18n` | P3 T3 | ADR-006 |
| `typecheck` + `test` | P0 T1 | — |

---

## 3. Self-review

### 3.1 Spec coverage

Đã rà từng mục checkpoint của blueprint. **Không tìm thấy yêu cầu M0/M1 nào thiếu task.** Các module không có task đều được hoãn tường minh sang M2–M6 trong §1.3.

### 3.2 Placeholder scan

Quét năm plan tìm `TBD`, `TODO`, `implement later`, `add proper validation`, `similar to previous task`, `write tests for the above`: **0 kết quả**. Mọi step code có code block thật.

Một chỗ **cố ý** là ghi chú hướng dẫn chứ không phải placeholder: P1 Task 6 Step 3 có khối `> Lưu ý cho implementer` yêu cầu thêm `createInitialTransition` vào `lifecycle.ts` và xoá `as never`. Đây là chỉ dẫn cụ thể có tên hàm và hành vi, kèm yêu cầu cập nhật test — không phải "TBD".

### 3.3 Type consistency

| Định nghĩa ở | Dùng lại ở | Khớp? |
|---|---|---|
| `Id`, `newId` — P1 T2 | Mọi plan | ✅ |
| `Actor` — P1 T2 | P1 T3, T8 | ✅ |
| `LifecycleState`, `MAIN_STATES` — P1 T3 | P1 T6, P3 T5 | ✅ |
| `ContentVersion` — P1 T7 | P1 T9 (`buildPublication`) | ✅ |
| `ApprovalRequest` — P1 T8 | P3 T9 (`performApproval`) | ✅ |
| `hashPublicationContent` — P1 T9 | P4 T5 | ✅ |
| `AgentRegistryEntry`, `assertActivated` — P1 T10 | P2 T7, T11 | ✅ |
| `TenantTx`, `withTenant` — P1 T5 | P1 T11, T13 · P2 T10 · P4 T3 | ✅ |
| `RunStore` — P2 T7 (interface) | P2 T10 (implement) | ✅ chữ ký khớp |
| `ModelProvider`, `Gateway` — P2 T1, T2 | P2 T7, T11 | ✅ |
| `ChannelAdapter`, `AdapterError` — P4 T1 | P4 T4, T5 | ✅ |
| `redact` — P0 T3 | P0 T4, T9 · P4 T1, T6 | ✅ |
| `t()`, `MessageKey` — P3 T3 | P3 T5, T6, T7 | ✅ |

**Một điểm đã sửa khi rà**: P2 T7 khai báo `RunStore` trong `packages/agents`, còn P2 T10 implement trong `packages/db`. Nếu `packages/db` import type từ `packages/agents` thì tạo phụ thuộc ngược. **Cách giải quyết đã ghi trong P2 T10**: `run-store.ts` khai báo lại interface `RunStore` cục bộ với chữ ký y hệt, nên `packages/db` không phụ thuộc `packages/agents`. Điểm nối là `apps/worker`, nơi cả hai gặp nhau. Chữ ký đã đối chiếu và khớp từng tham số.

### 3.4 Dependency ordering

`P0 → P1 → {P2 ∥ P3} → P4`. Không task nào tiêu thụ interface chưa được sản xuất ở task trước. P3 dùng dữ liệu seed từ `@smos/testing` (P1 T12) nên chạy song song với P2 được thật.

### 3.5 File ownership

Không hai plan nào tạo hoặc sửa cùng một file. Mỗi plan liệt kê "Files KHÔNG được chạm". `package.json` root được sửa bởi P0 T1/T10, P1 T1/T13, P2 T12, P3 T2/T3 — **chỉ để thêm script vào `verify`**, không đụng dependency của nhau. Đây là điểm giao duy nhất và cần chú ý khi chạy song song P2 ∥ P3: **hai plan này cùng sửa `package.json`**, nên nếu chạy song song bằng subagent thì phải merge tuần tự phần script.

### 3.6 Exact version và license

Mọi version trong plan lấy từ npm registry ngày 2026-08-11. License đã đọc từ file gốc cho drizzle, prisma, autogen, dify, n8n, twenty, mautic, posthog, vercel/ai, litellm, inngest. Package thêm mới trong plan (`@testing-library/react`, `@axe-core/playwright`, `@opentelemetry/sdk-trace-base`, `pg`, `@types/pg`) **chưa được xác minh license** — ghi thành hạng mục còn treo ở §4.

### 3.7 Tenant isolation

Phủ đủ ba lớp, test trên **mọi** bảng và **mọi** route, không phải mẫu.

### 3.8 Agent activation invariant

P1 T10 (domain) + P2 T7 (runtime, có spy chứng minh provider không được gọi) + P2 T6 (schema `agent_version.activated`).

### 3.9 Journey leakage

⚠ **Self-review tìm thấy một vi phạm thật và đã sửa.** P2 Task 8 có `publish_journey: "high"` trong bảng `ACTION_RISK` — đó đúng là một "slot để dành" cho Journey, vi phạm bất biến #8. Đã xoá.

Việc xoá **an toàn về mặt bảo mật**: `classifyRisk` trả `"medium"` cho action kind chưa biết, mà `"medium"` đã nằm trong `NEEDS_APPROVAL`. Nên khi Journey xuất hiện ở M4, hành động của nó mặc định vẫn phải qua approval chứ không lọt lưới.

Sau khi sửa, quét lại `journey|Journey|JOURNEY` trên năm plan: chỉ còn trong **Non-Goals**, trong danh sách bất biến, và trong bảng module đánh dấu hoãn. **Không** enum, cột, bảng, interface hay stub nào cho Journey. ✅

### 3.10 Billing / SaaS leakage

Quét tìm `billing`, `subscription`, `signup`, `provisioning`, `marketplace`, `white-label`: chỉ trong Non-Goals và trong danh sách cấm của `lint:scope`. E17 grep toàn repo trong CI. ✅

### 3.11 Real external action leakage

Quét tìm `graph.facebook.com`, `api.anthropic.com`, `fetch(`: chỉ trong fake server, trong egress allowlist test, và trong `anthropic.ts` — file **không được import trong bất kỳ test nào** (P2 T1 dùng `fake.ts`). P4 T9 Step 5 có grep xác nhận. ✅

---

## 4. Hạng mục còn treo — không chặn thực thi

| # | Nội dung | Xử lý ở |
|---|---|---|
| 1 | License của `@testing-library/react`, `@axe-core/playwright`, `@opentelemetry/sdk-trace-base`, `pg`, `@types/pg`, `jsdom`, `@tailwindcss/postcss` | **P0 T1** — đọc file LICENSE gốc trước khi cài, theo R15 |
| 2 | Self-host font `.woff2` hay dùng CDN | **P0** — ảnh hưởng privacy và CLS |
| 3 | Down-migration | **M2** — khi có dữ liệu thật |
| 4 | Per-day budget và kill switch UI | **P4 backlog → M2** |
| 5 | Masking PII field-level trước khi vào prompt (T5) | **M4** — khi có PII thật |
| 6 | Verify URL citation còn sống (T12) | **M2** |
| 7 | Quota tracking thật của nền tảng (T10) | **M2** |
| 8 | Session rotation test (T14) | **M2** |
| 9 | V1 Zalo · V2 GA4 · V3 GSC · V4 benchmark · V7 Dify | M2, M4, M5 |

---

## 5. Kết luận self-review

Không tìm thấy yêu cầu spec nào thiếu task. Không placeholder. Type nhất quán sau khi sửa một điểm phụ thuộc ngược (§3.3). Thứ tự phụ thuộc hợp lệ. Một cảnh báo vận hành: **P2 và P3 cùng sửa `package.json`**, nên nếu chạy song song thì merge phần script tuần tự.

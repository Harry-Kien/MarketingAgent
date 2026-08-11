# P3 — Founder Web Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Năm trang Founder dùng được thật — Sổ điều hành, Campaign Workspace, Content Studio, Approval Center, Analytics — theo hướng thiết kế "Sổ điều hành" với State Ribbon, đủ 7 state, điều hướng bàn phím, WCAG 2.2 AA, tiếng Việt tuân thủ C1/C2.

**Architecture:** Next.js App Router, server component mặc định; mọi truy cập dữ liệu đi qua tenant context ở server (D1-2), không có API công khai nào nhận `workspaceId` từ client. Design token là CSS custom properties sinh từ một nguồn TypeScript duy nhất, nên test có thể assert lên chính token. Chat **không** có vị trí cố định — chỉ là inspector gắn với entity.

**Tech Stack:** Next.js 16.3.0 · React 19.2.8 · Tailwind CSS 4.3.3 · better-auth 1.6.26 · vitest 4.1.10 · @playwright/test 1.62.1 · @axe-core/playwright

## Global Constraints

Kế thừa P0–P2, cộng thêm:

- **`line-height` tối thiểu 1.3** ở mọi nơi (ADR-008 C1). Cưỡng chế bằng Task 2.
- **Không dùng `·` (U+00B7) trong text render bằng Archivo** (ADR-008 C2). Cưỡng chế bằng Task 2.
- **Không chuỗi tiếng Việt hard-code trong JSX** — tất cả qua lớp i18n (ADR-006). Cưỡng chế bằng Task 3.
- **Không chat-first.** Không có route `/chat`, không có ô chat cố định trên layout.
- **Không AI-looking UI**: không neon gradient, không robot avatar, không quả cầu phát sáng, không glassmorphism, không bo góc > 6px.
- **Mọi trang có đủ 7 state**: loading · empty · error · partial-data · stale-data · unauthorized · disconnected-integration.
- **`workspaceId` không bao giờ đến từ client.** Luôn suy ra từ session ở server.
- Số liệu thiếu `freshness_at` / `attribution_model` / `confidence` ⇒ **không render số** (ADR-005).
- Approval request thiếu evidence hoặc kênh đích ⇒ **không render nút approve**.

---

## File Structure Map

| Path | Trách nhiệm | Public interface |
|---|---|---|
| `apps/web/src/ui/tokens.ts` | Nguồn duy nhất của design token | `tokens`, `toCssVars()` |
| `apps/web/src/ui/tokens.css` | Sinh từ `tokens.ts` | CSS custom properties |
| `apps/web/src/ui/StateRibbon.tsx` | Signature component | `<StateRibbon state duration />` |
| `apps/web/src/ui/DataTable.tsx` | Bảng dày, tabular nums | `<DataTable columns rows />` |
| `apps/web/src/ui/PageState.tsx` | 7 state dùng chung | `<PageState kind ... />` |
| `apps/web/src/ui/AppShell.tsx` | Rail trái, command bar, inspector | `<AppShell nav>` |
| `apps/web/src/i18n/vi.ts` | Chuỗi tiếng Việt | `messages` |
| `apps/web/src/i18n/index.ts` | Tra cứu + interpolation | `t(key, vars?)` |
| `apps/web/src/server/session.ts` | Tenant context từ session | `requireWorkspace()` |
| `apps/web/src/app/(app)/page.tsx` | Sổ điều hành | — |
| `apps/web/src/app/(app)/campaigns/[id]/page.tsx` | Campaign Workspace | — |
| `apps/web/src/app/(app)/content/[id]/page.tsx` | Content Studio | — |
| `apps/web/src/app/(app)/approvals/page.tsx` + `[id]` | Approval Center | — |
| `apps/web/src/app/(app)/analytics/page.tsx` | Analytics | — |
| `scripts/check-design-constraints.mjs` | C1, C2, i18n, anti-AI-look | exit code |
| `apps/web/e2e/*.spec.ts` | Playwright | — |

**Files KHÔNG được chạm:** `packages/domain/**`, `packages/agents/**`, `packages/policy/**`, `infra/migrations/**` (P1/P2/P4 sở hữu).

---

### Task 1: Design token là nguồn dữ liệu, không phải CSS rời

**Files:** Create `apps/web/src/ui/tokens.ts`, `tokens.css` · Test `apps/web/src/ui/tokens.test.ts`

**Interfaces:**
- Produces: `tokens: { color: { light: Record<string,string>; dark: Record<string,string> }; lineHeight: Record<string,number>; space: number[]; fontSize: number[]; radius: Record<string,number>; font: Record<string,string> }`; `toCssVars(mode: "light"|"dark"): string`

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/src/ui/tokens.test.ts
import { describe, expect, it } from "vitest";
import { tokens, toCssVars } from "./tokens.js";

describe("ADR-008 C1 line-height floor", () => {
  it("has no line-height below 1.3", () => {
    for (const [name, value] of Object.entries(tokens.lineHeight)) {
      expect(value, `lineHeight.${name}`).toBeGreaterThanOrEqual(1.3);
    }
  });
  it("sets heading to exactly the measured safe minimum", () => {
    expect(tokens.lineHeight.heading).toBe(1.3);
  });
});

describe("palette", () => {
  it("defines light and dark for every colour role", () => {
    expect(Object.keys(tokens.color.light).sort()).toEqual(Object.keys(tokens.color.dark).sort());
  });
  it("uses the approved cham accent in light mode", () => {
    expect(tokens.color.light.cham).toBe("#29406B");
  });
  it("does not reuse the light accent in dark mode", () => {
    expect(tokens.color.dark.cham).not.toBe(tokens.color.light.cham);
  });
});

describe("geometry", () => {
  it("caps border radius at 6px", () => {
    for (const v of Object.values(tokens.radius)) expect(v).toBeLessThanOrEqual(6);
  });
  it("uses a 4px spacing scale", () => {
    for (const v of tokens.space) expect(v % 4).toBe(0);
  });
});

describe("toCssVars", () => {
  it("emits custom properties for the requested mode", () => {
    const css = toCssVars("dark");
    expect(css).toContain("--color-cham: #7C9BD1");
    expect(css).toContain("--lh-heading: 1.3");
  });
});
```

- [ ] **Step 2: Chạy test** — `npx vitest run apps/web/src/ui/tokens.test.ts` → FAIL, không resolve `./tokens.js`.

- [ ] **Step 3: Implementation**

```ts
// apps/web/src/ui/tokens.ts
/**
 * Single source of truth for the design system. CSS is generated from here so
 * tests can assert on the tokens themselves, which is how ADR-008 C1 stays
 * enforced instead of drifting in a stylesheet.
 */
export const tokens = {
  color: {
    light: {
      paper: "#FBFBFA", surface: "#FFFFFF", ink: "#16181C", ink2: "#4A505C",
      rule: "#E3E5E9", cham: "#29406B", tho: "#A9701A", moss: "#2F6B4F",
      brick: "#9B3226", slate: "#445A78",
    },
    dark: {
      paper: "#101216", surface: "#181B21", ink: "#F2F4F7", ink2: "#A6AEBC",
      rule: "#262A32", cham: "#7C9BD1", tho: "#D9A047", moss: "#5FA37E",
      brick: "#D6705F", slate: "#8FA6C4",
    },
  },
  /** Measured in V6: below 1.3 Vietnamese diacritics collide. */
  lineHeight: { heading: 1.3, label: 1.3, table: 1.4, body: 1.5 },
  space: [4, 8, 12, 16, 24, 32, 48, 64],
  fontSize: [11, 12, 13, 14, 16, 18, 22, 28, 36],
  radius: { none: 0, sm: 2, md: 4, lg: 6 },
  font: {
    display: "'Archivo', system-ui, sans-serif",
    body: "'Be Vietnam Pro', system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace",
  },
} as const;

export function toCssVars(mode: "light" | "dark"): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(tokens.color[mode])) lines.push(`  --color-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.lineHeight)) lines.push(`  --lh-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.font)) lines.push(`  --font-${k}: ${v};`);
  for (const [k, v] of Object.entries(tokens.radius)) lines.push(`  --radius-${k}: ${v}px;`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Chạy test** → PASS 8 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): add design tokens with enforced line-height floor"`

---

### Task 2: Design constraint guard — C1, C2, anti-AI-look

**Files:** Create `scripts/design-constraints.mjs`, `scripts/check-design-constraints.mjs` · Modify `package.json` · Test `scripts/design-constraints.test.mjs`

- [ ] **Step 1: Viết failing test**

```js
// scripts/design-constraints.test.mjs
import { describe, expect, it } from "vitest";
import { findLineHeightViolations, findArchivoMiddot, findBannedVisuals } from "./design-constraints.mjs";

describe("C1 line-height", () => {
  it("flags a value below 1.3", () => {
    expect(findLineHeightViolations(`.x { line-height: 1.2; }`)).toEqual(["1.2"]);
    expect(findLineHeightViolations(`className="leading-[1.1]"`)).toEqual(["1.1"]);
  });
  it("allows 1.3 and above", () => {
    expect(findLineHeightViolations(`.x { line-height: 1.3; } .y { line-height: 1.5; }`)).toEqual([]);
  });
  it("ignores unitless 1 used for other properties", () => {
    expect(findLineHeightViolations(`.x { flex-grow: 1; }`)).toEqual([]);
  });
});

describe("C2 middot in Archivo", () => {
  it("flags a middot inside a display-font element", () => {
    const src = `<span className="font-display">Đã đăng · Bị chặn</span>`;
    expect(findArchivoMiddot(src)).toHaveLength(1);
  });
  it("allows a middot in body text", () => {
    expect(findArchivoMiddot(`<span className="font-body">a · b</span>`)).toEqual([]);
  });
});

describe("anti AI-look", () => {
  it("flags neon gradients and glassmorphism", () => {
    expect(findBannedVisuals(`background: linear-gradient(90deg,#0ff,#f0f);`)).toContain("gradient");
    expect(findBannedVisuals(`backdrop-filter: blur(12px);`)).toContain("backdrop-filter");
  });
  it("flags an oversized border radius", () => {
    expect(findBannedVisuals(`border-radius: 24px;`)).toContain("border-radius: 24px");
  });
  it("allows radius up to 6px", () => {
    expect(findBannedVisuals(`border-radius: 6px;`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation**

```js
// scripts/design-constraints.mjs
const LINE_HEIGHT = /(?:line-height:\s*|leading-\[)\s*(\d(?:\.\d+)?)/g;
const DISPLAY_ELEMENT = /<[^>]*font-display[^>]*>([^<]*)<\/[^>]+>/g;
const BANNED = [
  { name: "gradient", re: /linear-gradient|radial-gradient|conic-gradient/ },
  { name: "backdrop-filter", re: /backdrop-filter/ },
  { name: "text-shadow glow", re: /text-shadow:[^;]*\d{2,}px/ },
];

export function findLineHeightViolations(source) {
  const hits = [];
  for (const m of source.matchAll(LINE_HEIGHT)) {
    if (Number(m[1]) < 1.3) hits.push(m[1]);
  }
  return hits;
}

/** ADR-008 C2: Archivo has no U+00B7, so it silently falls back. */
export function findArchivoMiddot(source) {
  const hits = [];
  for (const m of source.matchAll(DISPLAY_ELEMENT)) {
    if (m[1].includes("·")) hits.push(m[0]);
  }
  return hits;
}

export function findBannedVisuals(source) {
  const hits = [];
  for (const b of BANNED) if (b.re.test(source)) hits.push(b.name);
  for (const m of source.matchAll(/border-radius:\s*(\d+)px/g)) {
    if (Number(m[1]) > 6) hits.push(m[0]);
  }
  return hits;
}
```

```js
// scripts/check-design-constraints.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findArchivoMiddot, findBannedVisuals, findLineHeightViolations } from "./design-constraints.mjs";

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(tsx|css)$/.test(p) && !/\.test\.tsx?$/.test(p) ? [p] : [];
  });
}

let failed = false;
for (const file of walk("apps/web/src")) {
  const src = readFileSync(file, "utf8");
  for (const v of findLineHeightViolations(src)) { console.error(`${file}: line-height ${v} is below the 1.3 floor (ADR-008 C1)`); failed = true; }
  for (const v of findArchivoMiddot(src)) { console.error(`${file}: middot inside display font (ADR-008 C2): ${v}`); failed = true; }
  for (const v of findBannedVisuals(src)) { console.error(`${file}: banned visual "${v}" (blueprint 9)`); failed = true; }
}
console.log(failed ? "design constraints FAILED" : "design constraints ok");
process.exit(failed ? 1 : 0);
```

`package.json`: thêm `"lint:design": "node scripts/check-design-constraints.mjs"`, chèn vào `verify`.

- [ ] **Step 4: Chạy test và guard** → 8 test PASS; `design constraints ok`.
- [ ] **Step 5: Commit** — `git commit -m "ci: enforce typography and anti-generic visual constraints"`

---

### Task 3: i18n layer và guard chống hard-code

**Files:** Create `apps/web/src/i18n/vi.ts`, `index.ts`, `scripts/check-i18n.mjs` · Test `apps/web/src/i18n/i18n.test.ts`, `scripts/i18n.test.mjs`

**Interfaces:**
- Produces: `t(key: MessageKey, vars?: Record<string, string|number>): string`; `messages` (nested object)

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/src/i18n/i18n.test.ts
import { describe, expect, it } from "vitest";
import { t } from "./index.js";

describe("t", () => {
  it("resolves a nested key", () => { expect(t("approval.pendingTitle")).toBe("Đang chờ bạn phê duyệt"); });
  it("interpolates variables", () => { expect(t("approval.pendingCount", { count: 3 })).toContain("3"); });
  it("throws on an unknown key so a missing string never ships as blank", () => {
    expect(() => t("nope.missing" as never)).toThrow(/unknown message key/i);
  });
  it("leaves an unmatched placeholder visible rather than silently empty", () => {
    expect(t("approval.pendingCount", {})).toContain("{count}");
  });
});
```

```js
// scripts/i18n.test.mjs
import { describe, expect, it } from "vitest";
import { findHardcodedVietnamese } from "./i18n-guard.mjs";

describe("findHardcodedVietnamese", () => {
  it("flags Vietnamese text sitting directly in JSX", () => {
    expect(findHardcodedVietnamese(`<h1>Sổ điều hành</h1>`)).toHaveLength(1);
  });
  it("allows text that goes through t()", () => {
    expect(findHardcodedVietnamese(`<h1>{t("home.title")}</h1>`)).toEqual([]);
  });
  it("allows plain ascii", () => {
    expect(findHardcodedVietnamese(`<h1>Dashboard</h1>`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL cả hai.

- [ ] **Step 3: Implementation**

```ts
// apps/web/src/i18n/vi.ts
export const messages = {
  nav: { today: "Sổ điều hành", campaigns: "Chiến dịch", content: "Nội dung", approvals: "Phê duyệt", analytics: "Kết quả" },
  home: { title: "Sổ điều hành", briefTitle: "Tóm tắt hôm nay", needsYou: "Cần bạn xử lý", atRisk: "Chiến dịch có rủi ro" },
  approval: {
    pendingTitle: "Đang chờ bạn phê duyệt",
    pendingCount: "{count} mục đang chờ bạn",
    approve: "Phê duyệt", reject: "Từ chối", requestChanges: "Yêu cầu chỉnh sửa",
    evidence: "Bằng chứng và nguồn", targetChannel: "Kênh đích", estimatedImpact: "Tác động ước tính",
    missingEvidence: "Thiếu bằng chứng nên chưa thể phê duyệt",
    disconnected: "Kênh đích đang ngắt kết nối nên chưa thể phê duyệt",
  },
  campaign: { title: "Chiến dịch", lifecycle: "Vòng đời", budget: "Ngân sách", conversion: "Chuyển đổi" },
  content: { title: "Nội dung", version: "Phiên bản", publicationContent: "Nội dung sẽ đăng", citations: "Nguồn trích dẫn" },
  analytics: { title: "Kết quả", freshness: "Cập nhật lúc", attributionModel: "Mô hình quy thuộc", confidence: "Độ tin cậy", missingData: "Thiếu dữ liệu" },
  state: {
    loading: "Đang tải", empty: "Chưa có dữ liệu", error: "Không tải được dữ liệu",
    partial: "Dữ liệu chưa đầy đủ", stale: "Dữ liệu đã cũ",
    unauthorized: "Bạn không có quyền xem mục này", disconnected: "Kết nối đang gián đoạn",
    retry: "Thử lại",
  },
  lifecycle: {
    DRAFT: "Nháp", RESEARCHING: "Đang nghiên cứu", PLANNED: "Đã lên kế hoạch",
    IN_PROGRESS: "Đang thực hiện", INTERNAL_REVIEW: "Đang rà soát nội bộ",
    WAITING_APPROVAL: "Chờ duyệt", APPROVED: "Đã duyệt", SCHEDULED: "Đã lên lịch",
    EXECUTING: "Đang thực thi", MEASURING: "Đang đo lường", COMPLETED: "Hoàn tất",
    BLOCKED: "Bị chặn", FAILED_RETRYABLE: "Lỗi có thể thử lại",
    FAILED_TERMINAL: "Lỗi không thể tiếp tục", CANCELLED: "Đã huỷ",
  },
} as const;
```

```ts
// apps/web/src/i18n/index.ts
import { messages } from "./vi.js";

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Leaves<typeof messages>;

export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  const found = key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], messages);
  if (typeof found !== "string") throw new Error(`Unknown message key: ${key}`);
  // Unmatched placeholders stay visible on purpose: a blank label in production
  // is harder to notice than a literal {count}.
  return found.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}
```

```js
// scripts/i18n-guard.mjs
const VIETNAMESE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/;
const JSX_TEXT = />([^<>{}]+)</g;

/** ADR-006: display strings live in the i18n layer, never inline in JSX. */
export function findHardcodedVietnamese(source) {
  const hits = [];
  for (const m of source.matchAll(JSX_TEXT)) {
    if (VIETNAMESE.test(m[1]) && m[1].trim().length > 0) hits.push(m[1].trim());
  }
  return hits;
}
```

`scripts/check-i18n.mjs` — cùng khuôn với các guard trước, quét `apps/web/src/**/*.tsx` trừ `src/i18n/**`. Thêm `"lint:i18n"` vào `verify`.

- [ ] **Step 4: Chạy test** → 4 + 3 test PASS; `npm run lint:i18n` in `i18n ok`.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): add vietnamese i18n layer and hardcode guard"`

---

### Task 4: Tenant context từ session ở server

**Files:** Create `apps/web/src/server/session.ts`, `apps/web/src/server/auth.ts` · Test `apps/web/src/server/session.test.ts`

**Interfaces:**
- Produces: `requireWorkspace(): Promise<{ workspaceId: Id; userId: Id }>` — ném `UnauthorizedError` khi không có session; **không bao giờ** đọc `workspaceId` từ query/body

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/src/server/session.test.ts
import { describe, expect, it } from "vitest";
import { resolveWorkspace, UnauthorizedError } from "./session.js";
import { newId } from "@smos/domain";

const userId = newId(); const workspaceId = newId();

describe("resolveWorkspace", () => {
  it("returns the workspace bound to the session", async () => {
    const r = await resolveWorkspace({
      getSession: async () => ({ userId }),
      lookupWorkspace: async () => workspaceId,
    });
    expect(r).toEqual({ userId, workspaceId });
  });

  it("refuses when there is no session", async () => {
    await expect(resolveWorkspace({ getSession: async () => null, lookupWorkspace: async () => workspaceId }))
      .rejects.toThrow(UnauthorizedError);
  });

  it("refuses when the user belongs to no workspace", async () => {
    await expect(resolveWorkspace({ getSession: async () => ({ userId }), lookupWorkspace: async () => null }))
      .rejects.toThrow(UnauthorizedError);
  });

  it("ignores any workspace id supplied by the caller", async () => {
    const attacker = newId();
    const r = await resolveWorkspace(
      { getSession: async () => ({ userId }), lookupWorkspace: async () => workspaceId },
      { workspaceId: attacker } as never,
    );
    expect(r.workspaceId).toBe(workspaceId);
    expect(r.workspaceId).not.toBe(attacker);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation**

```ts
// apps/web/src/server/session.ts
import type { Id } from "@smos/domain";

export class UnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED";
  constructor(message = "Not signed in") { super(message); this.name = "UnauthorizedError"; }
}

export interface SessionDeps {
  getSession(): Promise<{ userId: Id } | null>;
  lookupWorkspace(userId: Id): Promise<Id | null>;
}

/**
 * The second parameter exists only so a test can prove it is ignored. The
 * workspace is always derived from the session; a client can never choose it
 * (threat T6, invariant 1).
 */
export async function resolveWorkspace(
  deps: SessionDeps,
  _clientSupplied?: unknown,
): Promise<{ userId: Id; workspaceId: Id }> {
  const session = await deps.getSession();
  if (session === null) throw new UnauthorizedError();
  const workspaceId = await deps.lookupWorkspace(session.userId);
  if (workspaceId === null) throw new UnauthorizedError("User belongs to no workspace");
  return { userId: session.userId, workspaceId };
}
```

`apps/web/src/server/auth.ts` nối `better-auth` và export `requireWorkspace()` bọc `resolveWorkspace` với deps thật.

- [ ] **Step 4: Chạy test** → PASS 4 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): derive tenant context from session only"`

---

### Task 5: State Ribbon — signature component

**Files:** Create `apps/web/src/ui/StateRibbon.tsx` · Test `apps/web/src/ui/StateRibbon.test.tsx`

**Interfaces:**
- Produces: `<StateRibbon state={LifecycleState} />` — 11 chặng, cao 3px, notch 5px ở chặng hiện tại, thổ hoàng khi `WAITING_APPROVAL`, gãy khi `BLOCKED`/`FAILED_*`

- [ ] **Step 1: Viết failing test**

```tsx
// apps/web/src/ui/StateRibbon.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StateRibbon } from "./StateRibbon.js";

describe("StateRibbon", () => {
  it("renders eleven stops", () => {
    render(<StateRibbon state="DRAFT" />);
    expect(screen.getAllByRole("presentation", { hidden: true })).toHaveLength(11);
  });

  it("marks stops before the current one as done", () => {
    const { container } = render(<StateRibbon state="WAITING_APPROVAL" />);
    expect(container.querySelectorAll('[data-stop="done"]')).toHaveLength(5);
    expect(container.querySelectorAll('[data-stop="now"]')).toHaveLength(1);
  });

  it("uses the tho accent only while waiting on the founder", () => {
    const { container: waiting } = render(<StateRibbon state="WAITING_APPROVAL" />);
    const { container: running } = render(<StateRibbon state="EXECUTING" />);
    expect(waiting.querySelector('[data-stop="now"]')?.getAttribute("data-accent")).toBe("tho");
    expect(running.querySelector('[data-stop="now"]')?.getAttribute("data-accent")).toBe("ink");
  });

  it("shows a broken ribbon for a failed state", () => {
    const { container } = render(<StateRibbon state="FAILED_TERMINAL" />);
    expect(container.querySelector('[data-broken="true"]')).not.toBeNull();
  });

  it("exposes an accessible label instead of relying on colour alone", () => {
    render(<StateRibbon state="WAITING_APPROVAL" />);
    expect(screen.getByLabelText("Chờ duyệt")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL. Cần cấu hình vitest environment `jsdom` cho `apps/web` và cài `@testing-library/react@16.4.0`, `@testing-library/jest-dom@6.9.1`, `jsdom@27.0.0`.

- [ ] **Step 3: Implementation**

```tsx
// apps/web/src/ui/StateRibbon.tsx
import { MAIN_STATES, type LifecycleState } from "@smos/domain";
import { t } from "../i18n/index.js";

const FAILED: ReadonlySet<string> = new Set(["BLOCKED", "FAILED_RETRYABLE", "FAILED_TERMINAL", "CANCELLED"]);

/**
 * The signature element. It puts the lifecycle state machine into every row so
 * the founder can scan one column and see everything waiting on them.
 */
export function StateRibbon({ state }: { state: LifecycleState }) {
  const broken = FAILED.has(state);
  const currentIndex = broken ? -1 : MAIN_STATES.indexOf(state as (typeof MAIN_STATES)[number]);
  const accent = state === "WAITING_APPROVAL" ? "tho" : "ink";

  return (
    <span
      aria-label={t(`lifecycle.${state}` as never)}
      role="img"
      data-broken={broken ? "true" : undefined}
      style={{ display: "inline-flex", gap: 2, alignItems: "flex-end", height: 7 }}
    >
      {MAIN_STATES.map((stop, i) => {
        const kind = i < currentIndex ? "done" : i === currentIndex ? "now" : "todo";
        return (
          <i
            key={stop}
            role="presentation"
            aria-hidden="true"
            data-stop={kind}
            data-accent={kind === "now" ? accent : undefined}
            style={{
              display: "block", width: 5,
              height: kind === "now" ? 5 : 3,
              background:
                kind === "done" ? "var(--color-ink2)"
                : kind === "now" ? (accent === "tho" ? "var(--color-tho)" : "var(--color-ink)")
                : "var(--color-rule)",
            }}
          />
        );
      })}
    </span>
  );
}
```

- [ ] **Step 4: Chạy test** → PASS 5 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): add state ribbon signature component"`

---

### Task 6: PageState — 7 trạng thái dùng chung

**Files:** Create `apps/web/src/ui/PageState.tsx` · Test `apps/web/src/ui/PageState.test.tsx`

**Interfaces:**
- Produces: `<PageState kind="loading"|"empty"|"error"|"partial"|"stale"|"unauthorized"|"disconnected" detail? onRetry? />`

- [ ] **Step 1: Viết failing test**

```tsx
// apps/web/src/ui/PageState.test.tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PAGE_STATE_KINDS, PageState } from "./PageState.js";

describe("PageState", () => {
  it("covers all seven required states", () => { expect(PAGE_STATE_KINDS).toHaveLength(7); });

  it.each(PAGE_STATE_KINDS)("%s renders visible Vietnamese text", (kind) => {
    render(<PageState kind={kind} />);
    expect(screen.getByRole("status")).toHaveTextContent(/\S/);
  });

  it("offers retry only where retrying makes sense", async () => {
    const onRetry = vi.fn();
    render(<PageState kind="error" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalledOnce();

    render(<PageState kind="unauthorized" onRetry={onRetry} />);
    expect(screen.queryAllByRole("button")).toHaveLength(1);
  });

  it("announces politely rather than assertively for non-errors", () => {
    render(<PageState kind="loading" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation**

```tsx
// apps/web/src/ui/PageState.tsx
import { t } from "../i18n/index.js";

export const PAGE_STATE_KINDS = ["loading", "empty", "error", "partial", "stale", "unauthorized", "disconnected"] as const;
export type PageStateKind = (typeof PAGE_STATE_KINDS)[number];

const RETRYABLE: ReadonlySet<PageStateKind> = new Set(["error", "stale", "disconnected"]);

export function PageState({ kind, detail, onRetry }: { kind: PageStateKind; detail?: string; onRetry?: () => void }) {
  return (
    <div
      role="status"
      aria-live={kind === "error" ? "assertive" : "polite"}
      style={{ padding: 24, color: "var(--color-ink2)", lineHeight: "var(--lh-body)" }}
    >
      <p style={{ margin: 0, color: "var(--color-ink)" }}>{t(`state.${kind}` as never)}</p>
      {detail !== undefined && <p style={{ margin: "4px 0 0" }}>{detail}</p>}
      {onRetry !== undefined && RETRYABLE.has(kind) && (
        <button type="button" onClick={onRetry} style={{ marginTop: 12 }}>{t("state.retry")}</button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Chạy test** → PASS 10 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): add shared seven-state page component"`

---

### Task 7: AppShell — rail trái, command bar, không chat-first

**Files:** Create `apps/web/src/ui/AppShell.tsx`, `apps/web/src/app/(app)/layout.tsx` · Test `apps/web/src/ui/AppShell.test.tsx`

- [ ] **Step 1: Viết failing test**

```tsx
// apps/web/src/ui/AppShell.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppShell } from "./AppShell.js";

describe("AppShell", () => {
  it("renders the five navigation destinations", () => {
    render(<AppShell pendingApprovals={0}><div /></AppShell>);
    for (const label of ["Sổ điều hành", "Chiến dịch", "Nội dung", "Phê duyệt", "Kết quả"]) {
      expect(screen.getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it("shows the approval badge only when something is pending", () => {
    const { rerender } = render(<AppShell pendingApprovals={0}><div /></AppShell>);
    expect(screen.queryByTestId("approval-badge")).toBeNull();
    rerender(<AppShell pendingApprovals={3}><div /></AppShell>);
    expect(screen.getByTestId("approval-badge")).toHaveTextContent("3");
  });

  it("has no persistent chat surface", () => {
    render(<AppShell pendingApprovals={0}><div /></AppShell>);
    expect(screen.queryByRole("textbox", { name: /chat/i })).toBeNull();
    expect(screen.queryByTestId("chat-panel")).toBeNull();
  });

  it("exposes a command bar reachable by keyboard", () => {
    render(<AppShell pendingApprovals={0}><div /></AppShell>);
    const cmd = screen.getByRole("button", { name: /⌘K|Ctrl\+K/ });
    expect(cmd).toBeInTheDocument();
    expect(cmd.tabIndex).toBeGreaterThanOrEqual(0);
  });

  it("marks the main region as a landmark", () => {
    render(<AppShell pendingApprovals={0}><div>content</div></AppShell>);
    expect(screen.getByRole("main")).toHaveTextContent("content");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation** — `AppShell` với `<nav>` 224px, `<main>`, nút command bar `⌘K`, badge approval; **không** render bất kỳ panel chat cố định nào.

- [ ] **Step 4: Chạy test** → PASS 5 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): add app shell with left rail and command bar"`

---

### Task 8: Trang Sổ điều hành và Campaign Workspace

**Files:** Create `apps/web/src/app/(app)/page.tsx`, `campaigns/[id]/page.tsx`, `apps/web/src/server/queries.ts` · Test `apps/web/src/server/queries.test.ts`

**Interfaces:**
- Produces: `getTodayBoard(pool, workspaceId)`, `getCampaign(pool, workspaceId, campaignId)` — mọi hàm nhận `workspaceId` từ server, đi qua `withTenant`

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/src/server/queries.test.ts
import { afterAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { getCampaign, getTodayBoard } from "./queries.js";
import { seedTwoWorkspaces } from "@smos/testing";

const pool = createDbPool(process.env["DATABASE_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5432/smos");
afterAll(async () => { await pool.end(); });

describe("server queries", () => {
  it("returns only the caller's workspace rows", async () => {
    const { a, b } = await seedTwoWorkspaces(pool);
    const boardA = await getTodayBoard(pool, a.workspaceId);
    expect(boardA.campaigns.every((c) => c.workspaceId === a.workspaceId)).toBe(true);
    expect(boardA.campaigns.some((c) => c.id === b.campaignId)).toBe(false);
  });

  it("E14: returns null for a campaign in another workspace, not an error", async () => {
    const { a, b } = await seedTwoWorkspaces(pool);
    expect(await getCampaign(pool, b.workspaceId, a.campaignId)).toBeNull();
  });

  it("reports pending approvals for the board", async () => {
    const { a } = await seedTwoWorkspaces(pool);
    const board = await getTodayBoard(pool, a.workspaceId);
    expect(board.pendingApprovalCount).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation** — `queries.ts` dùng `withTenant`; page component là server component gọi `requireWorkspace()` rồi truyền dữ liệu xuống; dùng `DataTable` + `StateRibbon`; mọi nhánh rỗng/lỗi trả `<PageState>`.

- [ ] **Step 4: Chạy test** → PASS 3 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): add today board and campaign workspace pages"`

---

### Task 9: Content Studio và Approval Center

**Files:** Create `apps/web/src/app/(app)/content/[id]/page.tsx`, `approvals/page.tsx`, `approvals/[id]/page.tsx`, `apps/web/src/server/actions/approve.ts` · Test `apps/web/src/server/actions/approve.test.ts`

**Interfaces:**
- Produces: `submitApproval(input: { approvalRequestId: Id; decision: ApprovalDecisionKind; reason: string })` — server action; suy `workspaceId` và `userId` từ session

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/src/server/actions/approve.test.ts
import { describe, expect, it, vi } from "vitest";
import { performApproval } from "./approve.js";
import { newId } from "@smos/domain";

const base = {
  approvalRequestId: newId(), decision: "approve" as const, reason: "nội dung đạt",
  session: { userId: newId(), workspaceId: newId() },
};

const deps = (over: Partial<Parameters<typeof performApproval>[1]> = {}) => ({
  loadRequest: async () => ({
    id: base.approvalRequestId, workspaceId: base.session.workspaceId, campaignId: newId(),
    contentVersionId: newId(), targetChannel: "meta_page", policyFlags: [],
    evidenceCitationIds: [newId()], estimatedImpact: null, createdAt: new Date(),
  }),
  isChannelConnected: async () => true,
  saveDecision: vi.fn(async () => undefined),
  writeAudit: vi.fn(async () => undefined),
  ...over,
});

describe("performApproval", () => {
  it("records the decision and writes audit", async () => {
    const d = deps();
    await performApproval(base, d);
    expect(d.saveDecision).toHaveBeenCalledOnce();
    expect(d.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: "approval.granted" }));
  });

  it("refuses when the request has no evidence", async () => {
    const d = deps({ loadRequest: async () => ({ ...(await deps().loadRequest()), evidenceCitationIds: [] }) });
    await expect(performApproval(base, d)).rejects.toThrow(/evidence/i);
    expect(d.saveDecision).not.toHaveBeenCalled();
  });

  it("refuses when the target channel is disconnected", async () => {
    const d = deps({ isChannelConnected: async () => false });
    await expect(performApproval(base, d)).rejects.toThrow(/disconnected|kết nối/i);
    expect(d.saveDecision).not.toHaveBeenCalled();
  });

  it("refuses a request belonging to another workspace", async () => {
    const d = deps({ loadRequest: async () => ({ ...(await deps().loadRequest()), workspaceId: newId() }) });
    await expect(performApproval(base, d)).rejects.toThrow(/workspace/i);
  });

  it("refuses a blank reason", async () => {
    await expect(performApproval({ ...base, reason: "  " }, deps())).rejects.toThrow(/reason|lý do/i);
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.

- [ ] **Step 3: Implementation** — `performApproval` gọi `assertRenderable` và `decideApproval` từ `@smos/domain`, chặn khi kênh ngắt kết nối (T17), kiểm `workspaceId` khớp session, ghi audit `approval.granted`.

Trang `approvals/[id]` render: diff before/after · danh sách citation kèm URL và ngày truy cập · policy flag kèm `ruleId@ruleVersion` · kênh đích đã resolve · tác động ước tính có nhãn `[ước lượng]`. **Không** render chain-of-thought. Nút approve bị disable kèm lý do khi `assertRenderable` ném lỗi.

- [ ] **Step 4: Chạy test** → PASS 5 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): add content studio and approval center"`

---

### Task 10: Analytics với freshness bắt buộc

**Files:** Create `apps/web/src/app/(app)/analytics/page.tsx`, `apps/web/src/ui/MetricValue.tsx` · Test `apps/web/src/ui/MetricValue.test.tsx`

**Interfaces:**
- Produces: `<MetricValue metric={Metric | null} />` — thiếu bất kỳ trường bắt buộc ⇒ render `PageState kind="partial"`, **không** render số

- [ ] **Step 1: Viết failing test**

```tsx
// apps/web/src/ui/MetricValue.test.tsx
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricValue } from "./MetricValue.js";

const full = { value: 12.5, unit: "%", freshnessAt: new Date("2026-08-11"), attributionModel: "last_touch", attributionWindow: "7d", confidence: "medium" as const, missingDataNote: null };

describe("MetricValue", () => {
  it("renders the number when every required field is present", () => {
    render(<MetricValue metric={full} />);
    expect(screen.getByText(/12,5|12\.5/)).toBeInTheDocument();
  });

  it.each(["freshnessAt", "attributionModel", "confidence"])("refuses to render a number when %s is missing", (field) => {
    render(<MetricValue metric={{ ...full, [field]: null } as never} />);
    expect(screen.queryByText(/12,5|12\.5/)).toBeNull();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("always shows the attribution model next to the number", () => {
    render(<MetricValue metric={full} />);
    expect(screen.getByText(/last_touch/)).toBeInTheDocument();
  });

  it("surfaces a missing-data note when present", () => {
    render(<MetricValue metric={{ ...full, missingDataNote: "thiếu 2 ngày" }} />);
    expect(screen.getByText(/thiếu 2 ngày/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Chạy test** → FAIL.
- [ ] **Step 3: Implementation** — guard clause kiểm ba trường bắt buộc trước khi render số; dùng `Intl.NumberFormat("vi-VN")`.
- [ ] **Step 4: Chạy test** → PASS 6 test.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): never render a metric without freshness and attribution"`

---

### Task 11: Accessibility và keyboard E2E — E11

**Files:** Create `apps/web/playwright.config.ts`, `apps/web/e2e/a11y.spec.ts`, `apps/web/e2e/keyboard.spec.ts`

- [ ] **Step 1: Viết failing test**

```ts
// apps/web/e2e/a11y.spec.ts
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PAGES = ["/", "/campaigns", "/content", "/approvals", "/analytics"];

for (const path of PAGES) {
  test(`${path} has no serious or critical accessibility violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
    const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(serious, JSON.stringify(serious.map((v) => v.id))).toHaveLength(0);
  });

  test(`${path} is reachable by keyboard alone`, async ({ page }) => {
    await page.goto(path);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      const s = el ? getComputedStyle(el) : null;
      return { tag: el?.tagName, hasVisibleFocus: s !== null && (s.outlineStyle !== "none" || s.boxShadow !== "none") };
    });
    expect(focused.tag).not.toBe("BODY");
    expect(focused.hasVisibleFocus, "focus ring must be visible").toBe(true);
  });
}

test("dark mode keeps text contrast at AA", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const results = await new AxeBuilder({ page }).withTags(["wcag2aa"]).analyze();
  expect(results.violations.filter((v) => v.id === "color-contrast")).toHaveLength(0);
});
```

- [ ] **Step 2: Chạy test** — `npx playwright test --config apps/web/playwright.config.ts` → FAIL, chưa có config và chưa cài `@axe-core/playwright@4.11.0`.

- [ ] **Step 3: Implementation** — `playwright.config.ts` với `webServer` khởi động `next dev`, project `chromium` desktop 1440×900 và `Mobile Safari` 390×844.

- [ ] **Step 4: Chạy test** → PASS 11 test. **Bằng chứng E11.**

- [ ] **Step 5: Chụp screenshot và visual critique**

Run:
```bash
npx playwright test --config apps/web/playwright.config.ts --update-snapshots
```
Rồi **thực sự mở từng ảnh và đánh giá**: hierarchy có rõ không · có overflow ngang không · contrast đủ chưa · dấu tiếng Việt có va chạm không (C1) · State Ribbon có đọc được ở 100% zoom không · mobile 390px có vỡ bảng không. **Sửa lỗi tìm được rồi chụp lại.** Không được bỏ qua bước này.

- [ ] **Step 6: Chạy toàn bộ verify**

Run: `npm run verify && npx playwright test --config apps/web/playwright.config.ts`
Expected: mọi guard `ok`, unit test pass, E2E pass.

- [ ] **Step 7: Commit** — `git commit -m "test(web): add accessibility and keyboard navigation e2e"`

---

## Acceptance Criteria

| # | Tiêu chí | Bằng chứng |
|---|---|---|
| D1 | Không `line-height` < 1.3 ở bất kỳ đâu | Task 1 + Task 2 guard |
| D2 | Không `·` trong text Archivo | Task 2 guard |
| D3 | Không chuỗi tiếng Việt hard-code trong JSX | Task 3 guard |
| D4 | `workspaceId` không bao giờ đến từ client | Task 4 |
| D5 | E14 — trang không rò dữ liệu workspace khác | Task 8 |
| D6 | 7 state có mặt và có test | Task 6 |
| D7 | State Ribbon đúng đặc tả, có nhãn a11y | Task 5 |
| D8 | Approval thiếu evidence/kênh ⇒ không approve được | Task 9 |
| D9 | Metric thiếu freshness ⇒ không render số | Task 10 |
| D10 | axe không violation serious/critical trên 5 trang, light và dark | E11 — Task 11 |
| D11 | Điều hướng bàn phím có focus ring thấy được | E11 — Task 11 |
| D12 | Không chat-first, không AI-look | Task 7 + Task 2 guard |

## Security Checks

- **T6**: `workspaceId` chỉ từ session; test chứng minh tham số client bị bỏ qua.
- **T13 XSS**: nội dung do agent sinh render qua React (auto-escape); preview HTML nếu có phải nằm trong `<iframe sandbox>` — thuộc P4 khi có preview thật.
- **T17**: approve bị chặn khi kênh đích ngắt kết nối.
- Không hiển thị chain-of-thought nội bộ ở Approval Center.

## Tenancy Checks

D1-2 ✅ ở tầng route — mọi query đi qua `withTenant`. D1-6 mở rộng sang route: Task 8 chứng minh `getCampaign` trả `null` cho workspace khác. Cùng với E14 của P1, phủ cả tầng DB lẫn tầng HTTP.

## Audit Evidence

`performApproval` ghi `approval.granted` / `approval.rejected` kèm `actor_user_id`, `subject_id`, `correlation_id`. Approval Center hiển thị `ruleId@ruleVersion` của mọi policy flag để quyết định truy vết được.

## Observability Evidence

Trace HTTP đến từ auto-instrumentation của P0. Server action ghi log có `workspaceId` và `correlationId`, đã qua `redact`.

## Rollback / Recovery

UI không có state bền — rollback là `git revert`. Không migration nào trong P3.

## Non-Goals

19 trang còn lại · duyệt qua magic link / Telegram / Zalo · realtime SSE · chat interface · Social Inbox · SEO Center · Journey builder · dark mode toggle thủ công (theo `prefers-color-scheme`).

## Manual Verification

1. `docker compose up -d db && npm run dev --workspace @smos/web`
2. Đăng nhập, mở `/` — kiểm State Ribbon ở mỗi hàng, notch thổ hoàng ở mục chờ duyệt.
3. `Tab` xuyên trang — focus ring luôn thấy được.
4. Mở `/approvals/<id>` của một request thiếu citation — nút phê duyệt phải disable kèm lý do tiếng Việt.
5. Đổi hệ điều hành sang dark mode — kiểm màu được thiết kế lại, không phải đảo màu.
6. Thu cửa sổ xuống 390px — bảng cuộn ngang trong container riêng, `body` không cuộn ngang.

## Browser Verification

Playwright chromium 1440×900 và Mobile Safari 390×844 trên 5 trang, light và dark, cộng axe scan. Screenshot được xem và phê bình bằng mắt ở Task 11 Step 5.

## Evidence Tiers

| Tier | P3 |
|---|---|
| **Source check** | ✅ guard design, i18n, cùng các guard cũ |
| **Local runtime** | ✅ unit + component test, server query trên Postgres thật |
| **Sandbox integration** | ✅ E2E trên browser thật với database thật; adapter ngoài vẫn chưa có (P4) |
| **Production verification** | ❌ Chưa có |

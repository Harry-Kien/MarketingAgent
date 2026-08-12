// The tool allowlist is the layer that makes a successful prompt injection
// harmless (STANDING-CONTEXT.md, task-4-brief.md). Even if a hostile page
// convinces the model to ask for "publish.meta", createToolRegistry must
// refuse -- because this is a runtime gate, not advice inside a prompt.
// Task 11's injection corpus and the whole "an agent cannot take an external
// action" claim rest on this holding, so this file both proves the brief's
// four base behaviours and then goes after the allowlist itself.
import { describe, expect, it, vi } from "vitest";
import { newId } from "@smos/domain";
import { logger } from "@smos/telemetry";
import { createToolRegistry } from "./tools.ts";

const ws = newId();
const ctx = (allowlist: string[]) => ({ workspaceId: ws, agentRunId: newId(), allowlist });

describe("tool registry", () => {
  // --- brief's base tests, verbatim ---------------------------------------

  it("invokes a tool that is on the allowlist", async () => {
    const reg = createToolRegistry([{ name: "read.brand", handler: async () => "voice" }]);
    await expect(reg.invoke("read.brand", {}, ctx(["read.brand"]))).resolves.toBe("voice");
  });

  it("refuses a tool that exists but is not on the allowlist, without invoking it", async () => {
    const handler = vi.fn();
    const reg = createToolRegistry([{ name: "publish.meta", handler }]);
    await expect(reg.invoke("publish.meta", {}, ctx(["read.brand"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses an unknown tool", async () => {
    const reg = createToolRegistry([]);
    await expect(reg.invoke("anything", {}, ctx(["anything"]))).rejects.toThrow(/unknown tool/i);
  });

  it("passes the workspace id to the handler so it cannot query across tenants", async () => {
    let seen: string | undefined;
    const reg = createToolRegistry([
      {
        name: "t",
        handler: async (_a, c) => {
          seen = c.workspaceId;
          return null;
        },
      },
    ]);
    await reg.invoke("t", {}, ctx(["t"]));
    expect(seen).toBe(ws);
  });

  // --- policy.violation must be logged when a refusal happens -------------

  it("logs a policy.violation when a registered tool is refused for not being allowlisted", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const handler = vi.fn();
      const reg = createToolRegistry([{ name: "publish.meta", handler }]);
      const runId = newId();
      await expect(
        reg.invoke("publish.meta", {}, { workspaceId: ws, agentRunId: runId, allowlist: ["read.brand"] }),
      ).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith(
        "policy.violation",
        expect.objectContaining({
          kind: "tool_not_allowed",
          tool: "publish.meta",
          workspaceId: ws,
          agentRunId: runId,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// --- attacking the allowlist itself ---------------------------------------
// The allowlist is now the thing standing between an injection and an
// external action. Each test below either proves an evasion is refused, or
// (where it is not) says so plainly and states the fix.

describe("allowlist: name-matching cannot be fooled", () => {
  // Below, the mangled name is checked against ctx.allowlist (which carries
  // only the exact original spelling) before the registry is even
  // consulted, so these are refused at the allowlist stage -- "not on the
  // tool allowlist", not "unknown tool". Either message would prove the
  // property; the assertions below match what the code actually does so the
  // check order stays honest, and each still proves the mangled name never
  // reaches the handler.

  it("does not match a tool name that differs only in case", async () => {
    const handler = vi.fn();
    const reg = createToolRegistry([{ name: "publish.meta", handler }]);
    // Allowlist authorises the exact lowercase name; attacker (or a mangled
    // prompt) asks for a differently-cased spelling.
    await expect(reg.invoke("Publish.Meta", {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    await expect(reg.invoke("PUBLISH.META", {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not match a tool name padded with surrounding whitespace", async () => {
    const handler = vi.fn();
    const reg = createToolRegistry([{ name: "publish.meta", handler }]);
    await expect(reg.invoke(" publish.meta", {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    await expect(reg.invoke("publish.meta ", {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    await expect(reg.invoke("publish.meta\n", {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not match a tool name carrying a zero-width character an attacker spliced in", async () => {
    const handler = vi.fn();
    const reg = createToolRegistry([{ name: "publish.meta", handler }]);
    const zw = "publish.​meta"; // zero-width space inserted
    await expect(reg.invoke(zw, {}, ctx(["publish.meta"]))).rejects.toThrow(/not on the tool allowlist/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not match a fullwidth-homoglyph rendering of an allowlisted name", async () => {
    const handler = vi.fn();
    const reg = createToolRegistry([{ name: "publish.meta", handler }]);
    // Fullwidth Unicode letters that *display* similarly but are different
    // code points and do not NFC/NFKC-normalise onto the ASCII original.
    const homoglyph = "ｐublish.meta"; // ｐublish.meta (fullwidth 'p')
    await expect(reg.invoke(homoglyph, {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("also refuses at the allowlist stage when the mismatched-case name IS registered as a distinct tool", async () => {
    // Prove the refusal isn't only "unknown tool" by coincidence of what's
    // registered: register the differently-cased name too, and show the
    // allowlist (which only carries the lowercase form) still blocks it.
    const lower = vi.fn();
    const upper = vi.fn();
    const reg = createToolRegistry([
      { name: "publish.meta", handler: lower },
      { name: "PUBLISH.META", handler: upper },
    ]);
    await expect(reg.invoke("PUBLISH.META", {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(upper).not.toHaveBeenCalled();
    expect(lower).not.toHaveBeenCalled();
  });
});

describe("allowlist: matching is exact, never prefix/suffix/substring", () => {
  it("does not let a longer tool name through when a shorter prefix is allowlisted", async () => {
    const dryRun = vi.fn();
    const reg = createToolRegistry([
      { name: "publish.meta", handler: vi.fn() },
      { name: "publish.meta.dry-run", handler: dryRun },
    ]);
    await expect(reg.invoke("publish.meta.dry-run", {}, ctx(["publish.meta"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(dryRun).not.toHaveBeenCalled();
  });

  it("does not let a shorter tool name through when a longer name is allowlisted", async () => {
    const publish = vi.fn();
    const reg = createToolRegistry([
      { name: "publish.meta", handler: publish },
      { name: "publish.meta.dry-run", handler: vi.fn() },
    ]);
    await expect(reg.invoke("publish.meta", {}, ctx(["publish.meta.dry-run"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not let a substring or superstring name through in either direction", async () => {
    const reg = createToolRegistry([
      { name: "read.brand", handler: vi.fn() },
      { name: "read.brand.extended", handler: vi.fn() },
      { name: "ead.brand", handler: vi.fn() },
    ]);
    await expect(reg.invoke("read.brand.extended", {}, ctx(["read.brand"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
    await expect(reg.invoke("ead.brand", {}, ctx(["read.brand"]))).rejects.toThrow(
      /not on the tool allowlist/i,
    );
  });
});

describe("allowlist: mutation and read timing", () => {
  it("createToolRegistry snapshots the tool list at construction -- registering a tool after construction has no effect", async () => {
    const tools = [{ name: "read.brand", handler: async () => "voice" }];
    const reg = createToolRegistry(tools);
    const lateHandler = vi.fn();
    tools.push({ name: "publish.meta", handler: lateHandler });
    await expect(reg.invoke("publish.meta", {}, ctx(["publish.meta"]))).rejects.toThrow(/unknown tool/i);
    expect(lateHandler).not.toHaveBeenCalled();
  });

  it("reads ctx.allowlist fresh on every call rather than caching it -- documented, not a vulnerability under this threat model", async () => {
    // The registry has no way to "snapshot" ctx.allowlist at construction
    // because construction never sees a ToolContext at all -- ctx is built
    // fresh by trusted runtime code (task 7's runAgent) on every call, from
    // AgentRegistryEntry.toolAllowlist, never from model/tool output. A
    // mutable array reference is therefore read live, which is correct: it
    // is what lets a single long-lived registry serve many runs with
    // different allowlists. This is not attacker-reachable via prompt
    // injection (the model produces JSON tool-call arguments, not object
    // references into the host process); it would only matter if some other
    // part of the host already had arbitrary code execution, which is a
    // different threat model entirely. Documented here rather than "fixed"
    // because there is nothing for the registry itself to fix: the
    // obligation is on callers to construct ctx.allowlist from a trusted,
    // per-run source and not hand out a shared mutable array across runs.
    const handler = vi.fn(async () => "ok");
    const reg = createToolRegistry([{ name: "publish.meta", handler }]);
    const allowlist: string[] = [];
    const liveCtx = { workspaceId: ws, agentRunId: newId(), allowlist };
    await expect(reg.invoke("publish.meta", {}, liveCtx)).rejects.toThrow(/not on the tool allowlist/i);
    allowlist.push("publish.meta");
    await expect(reg.invoke("publish.meta", {}, liveCtx)).resolves.toBe("ok");
  });
});

describe("allowlist: duplicate tool registration is a hard construction-time error", () => {
  it("throws when the same tool name is registered twice, rather than silently letting one shadow the other", () => {
    const first = vi.fn();
    const second = vi.fn();
    expect(() =>
      createToolRegistry([
        { name: "publish.meta", handler: first },
        { name: "publish.meta", handler: second },
      ]),
    ).toThrow(/duplicate/i);
  });
});

describe("allowlist: a handler cannot escape its own allowlist via the registry", () => {
  it("does not hand the registry (or an invoke function) to the handler through ctx", async () => {
    let capturedCtx: Record<string, unknown> | undefined;
    const reg = createToolRegistry([
      {
        name: "read.brand",
        handler: async (_a, c) => {
          capturedCtx = c as unknown as Record<string, unknown>;
          return "ok";
        },
      },
    ]);
    await reg.invoke("read.brand", {}, ctx(["read.brand"]));
    expect(capturedCtx).toBeDefined();
    expect(Object.keys(capturedCtx as object).sort()).toEqual(["agentRunId", "allowlist", "workspaceId"]);
    expect((capturedCtx as Record<string, unknown>)["invoke"]).toBeUndefined();
    expect((capturedCtx as Record<string, unknown>)["registry"]).toBeUndefined();
  });

  it("one tool's handler invoking a second tool needs its own reference to that registry -- ctx never supplies one", async () => {
    // Demonstrates the escape does not exist: a handler that tries to reach
    // "the registry" through anything ctx offers gets nothing to call.
    const secondTool = vi.fn(async () => "escaped");
    const reg = createToolRegistry([
      {
        name: "read.brand",
        handler: async (_a, c) => {
          const maybeRegistry = (c as unknown as { registry?: { invoke?: unknown } }).registry;
          expect(maybeRegistry).toBeUndefined();
          return "no escape";
        },
      },
      { name: "publish.meta", handler: secondTool },
    ]);
    await expect(reg.invoke("read.brand", {}, ctx(["read.brand"]))).resolves.toBe("no escape");
    expect(secondTool).not.toHaveBeenCalled();
  });
});

describe("allowlist: prototype-chain names cannot fall through to something inherited", () => {
  for (const trap of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    it(`treats "${trap}" as an ordinary unregistered tool name, not a live prototype member`, async () => {
      const reg = createToolRegistry([{ name: "read.brand", handler: async () => "voice" }]);
      await expect(reg.invoke(trap, {}, ctx([trap]))).rejects.toThrow(/unknown tool/i);
    });
  }

  it("registering a tool literally named __proto__ still only ever runs that exact, explicit registration", async () => {
    const trapHandler = vi.fn(async () => "trap-ran");
    const reg = createToolRegistry([{ name: "__proto__", handler: trapHandler }]);
    await expect(reg.invoke("__proto__", {}, ctx(["__proto__"]))).resolves.toBe("trap-ran");
    expect(trapHandler).toHaveBeenCalledOnce();
    // And an unrelated, never-registered name must still be unknown -- i.e.
    // registering "__proto__" did not pollute lookups for other names.
    const reg2 = createToolRegistry([{ name: "__proto__", handler: trapHandler }]);
    await expect(reg2.invoke("toString", {}, ctx(["toString"]))).rejects.toThrow(/unknown tool/i);
  });
});

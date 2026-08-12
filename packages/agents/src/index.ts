export { UNTRUSTED_PREAMBLE, wrapUntrusted } from "./untrusted.ts";
export {
  createToolRegistry,
  defineTenantTool,
  type TenantToolHandler,
  type ToolContext,
  type ToolDef,
  type ToolRegistry,
} from "./tools.ts";
export {
  runAgent,
  MAX_TOOL_CALLS_PER_RUN,
  type RunStore,
  type RunAgentInput,
  type RunAgentResult,
  type ToolCallRequest,
} from "./runtime.ts";
// The four M1_ACTIVATED_AGENTS role definitions (P4 Task 8's Golden
// Sequence needs the real buildPrompt/parse pair for each, not a
// reimplementation) -- previously only reachable via a package-relative
// import from inside this package itself (roles/roles.test.ts). Purely
// additive: no existing export changes shape, and roles/*.ts's own content
// is untouched.
export { orchestratorAgent, type OrchestratorOutput } from "./roles/orchestrator.ts";
export { researchAgent, type ResearchContext } from "./roles/research.ts";
export { contentAgent, type ContentContext } from "./roles/content.ts";
export { qaAgent, type QaContext } from "./roles/qa.ts";

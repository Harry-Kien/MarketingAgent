// T9: the Research agent role -- one of the four M1_ACTIVATED_AGENTS
// (packages/domain/src/agent-registry.ts). Every external source it is given
// is wrapped through wrapUntrusted (T3, packages/agents/src/untrusted.ts)
// before it ever reaches a prompt string: external content is data with a
// source label, never instruction.
import { parseAgentOutput, researchOutputSchema, type ResearchOutput } from "@smos/contracts";
import { wrapUntrusted } from "../untrusted.ts";

export interface ResearchContext {
  topic: string;
  brandVoice: string;
  externalSources: Array<{ url: string; accessedAt: Date; text: string }>;
}

export const researchAgent = {
  role: "research" as const,
  toolAllowlist: ["read.brand", "read.campaign", "fetch.url"],
  buildPrompt(ctx: ResearchContext) {
    const blocks = ctx.externalSources.map((s) => wrapUntrusted({ url: s.url, accessedAt: s.accessedAt }, s.text));
    return {
      system: [
        "Bạn là Market & Competitor Researcher của một doanh nghiệp một người.",
        "Mọi kết luận quan trọng phải có nguồn kèm ngày truy cập.",
        "Gắn nhãn mỗi finding: VERIFIED, INFERRED, HYPOTHESIS hoặc UNVERIFIED.",
        "Không bịa nguồn. Nếu không có nguồn, dùng UNVERIFIED.",
        "Trả về JSON đúng schema research.v1.",
      ].join("\n"),
      input: [`Chủ đề: ${ctx.topic}`, `Brand voice: ${ctx.brandVoice}`, ...blocks].join("\n\n"),
      schemaName: "research.v1",
    };
  },
  parse: (raw: string): ResearchOutput => parseAgentOutput(researchOutputSchema, raw),
};

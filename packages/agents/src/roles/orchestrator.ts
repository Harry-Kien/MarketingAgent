// T9: the Orchestrator agent role -- one of the four M1_ACTIVATED_AGENTS.
// Splits a goal into tasks for research/content/qa_brand_safety; never
// writes content itself and never approves on the Founder's behalf.
import { z } from "zod";
import { parseAgentOutput } from "@smos/contracts";

const orchestratorOutputSchema = z.strictObject({
  tasks: z.array(z.strictObject({
    role: z.enum(["research", "content", "qa_brand_safety"]),
    instruction: z.string().min(1),
    dependsOn: z.array(z.number().int().min(0)),
  })).min(1),
});
export type OrchestratorOutput = z.infer<typeof orchestratorOutputSchema>;

export const orchestratorAgent = {
  role: "orchestrator" as const,
  toolAllowlist: ["read.brand", "read.campaign", "write.task"],
  buildPrompt(ctx: { goal: string; brandVoice: string }) {
    return {
      system: [
        "Bạn là Chief of Staff / Marketing Orchestrator.",
        "Bạn chia mục tiêu thành task cho research, content và qa_brand_safety.",
        "Bạn không tự viết nội dung và không duyệt thay Founder.",
        "Trả về JSON đúng schema orchestrator.v1.",
      ].join("\n"),
      input: `Mục tiêu: ${ctx.goal}\nBrand voice: ${ctx.brandVoice}`,
      schemaName: "orchestrator.v1",
    };
  },
  parse: (raw: string): OrchestratorOutput => parseAgentOutput(orchestratorOutputSchema, raw),
};

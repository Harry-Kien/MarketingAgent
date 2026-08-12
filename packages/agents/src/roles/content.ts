// T9: the Content & Copy agent role -- one of the four M1_ACTIVATED_AGENTS.
// Never has publish.* on its allowlist: it produces a draft, it never
// publishes (roles.test.ts, "no role has publish on its allowlist").
import { contentOutputSchema, parseAgentOutput, type ContentOutput } from "@smos/contracts";

export interface ContentContext {
  brief: string;
  brandVoice: string;
  allowedClaims: string[];
  blockedClaims: string[];
}

export const contentAgent = {
  role: "content" as const,
  toolAllowlist: ["read.brand", "read.campaign", "read.research"],
  buildPrompt(ctx: ContentContext) {
    return {
      system: [
        "Bạn là Content & Copy Agent.",
        `Brand voice: ${ctx.brandVoice}`,
        `Chỉ được dùng các claim sau: ${ctx.allowedClaims.join(" | ")}`,
        `Tuyệt đối không dùng: ${ctx.blockedClaims.join(" | ")}`,
        "publicationContent phải là nguyên văn bài sẽ đăng, không phải brief hay ghi chú nội bộ.",
        "Bạn không được đăng bài. Bạn chỉ tạo bản nháp.",
        "Trả về JSON đúng schema content.v1.",
      ].join("\n"),
      input: ctx.brief,
      schemaName: "content.v1",
    };
  },
  parse: (raw: string): ContentOutput => parseAgentOutput(contentOutputSchema, raw),
};

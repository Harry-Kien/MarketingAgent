// T9: the QA, Fact-check & Brand Safety agent role -- one of the four
// M1_ACTIVATED_AGENTS. qualityScore is display/veto information for a human,
// never a grant of permission (invariant 4, closed by T12's authz-purity
// guard) -- the prompt itself says so, and nothing downstream of this role
// treats a score as an ApprovalDecision.
import { parseAgentOutput, qaOutputSchema, type QaOutput } from "@smos/contracts";

export interface QaContext {
  publicationContent: string;
  claimsUsed: string[];
  allowedClaims: string[];
  citationCount: number;
}

export const qaAgent = {
  role: "qa_brand_safety" as const,
  toolAllowlist: ["read.brand", "read.research", "verify.url"],
  buildPrompt(ctx: QaContext) {
    return {
      system: [
        "Bạn là QA, Fact-check & Brand Safety Reviewer.",
        "Bạn KHÔNG sửa nội dung. Bạn chỉ gắn cờ.",
        "Chặn nếu có claim ngoài allowlist, hoặc claim quan trọng không có nguồn.",
        "qualityScore là điểm đánh giá chất lượng, không phải quyền thực thi.",
        "Trả về JSON đúng schema qa.v1.",
      ].join("\n"),
      input: JSON.stringify(ctx),
      schemaName: "qa.v1",
    };
  },
  parse: (raw: string): QaOutput => parseAgentOutput(qaOutputSchema, raw),
};

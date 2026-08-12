/**
 * Every agent (T1's fake provider today, a real one later) returns a string.
 * That string is untrusted content -- the model chose it, and a hostile
 * page/document the model read via wrapUntrusted (packages/agents/src/
 * untrusted.ts) may have tried to steer it. parseAgentOutput is the single
 * boundary where that string is admitted into the rest of the system: every
 * agent output is parsed against one of these schemas here, and an output
 * that does not parse is a failure, never a partial success that flows
 * onward (per task-5-brief.md and the P2 plan's "agent output contracts").
 *
 * Every schema below is closed (z.strictObject): an unknown key is a parse
 * failure, not silently dropped. That is a security property, not a style
 * preference -- a model that invents an extra field (say, an
 * "approvalOverride" key it was never asked for) must not have that field
 * survive parsing and reach a database write.
 */
import { z } from "zod";
import { VERIFICATION_STATUSES } from "@smos/domain";

// Same shape as SourceCitation's public fields (packages/domain/src/
// content.ts) minus `id` and `verificationStatus` -- those are assigned by
// domain code when a SourceCitation is built, never trusted from model
// output directly.
const agentCitationSchema = z.strictObject({
  url: z.string().url(),
  accessedAt: z.string().datetime(),
  excerpt: z.string().min(1),
});

export const researchOutputSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      claim: z.string().min(1),
      // Reuses domain's single source of truth for the allowed values
      // instead of redeclaring a second list that could drift from it.
      verificationStatus: z.enum(VERIFICATION_STATUSES),
      citations: z.array(agentCitationSchema).min(1, "every finding needs at least one citation"),
    }),
  ),
});

export const contentOutputSchema = z.strictObject({
  body: z.string().min(1),
  publicationContent: z.string().refine((v) => v.trim().length > 0, {
    message: "publicationContent must not be blank",
  }),
  claimsUsed: z.array(z.string()),
});

export const qaOutputSchema = z.strictObject({
  verdict: z.enum(["pass", "block"]),
  /** Display and veto signal only. Never a permission input (invariant 4). */
  qualityScore: z.number().int().min(0).max(100),
  findings: z.array(
    z.strictObject({
      severity: z.enum(["info", "warn", "block"]),
      message: z.string().min(1),
    }),
  ),
});

export type ResearchOutput = z.infer<typeof researchOutputSchema>;
export type ContentOutput = z.infer<typeof contentOutputSchema>;
export type QaOutput = z.infer<typeof qaOutputSchema>;

// Bounds on how much of a schema-validation failure gets stitched into the
// thrown Error's message. The failure detail is diagnostic information for
// whoever is debugging a broken agent run, but the *input* that produced it
// is untrusted content -- so, consistent with how packages/agents/src/
// tools.ts caps a refused tool name before logging it, nothing here is
// allowed to carry an unbounded (or literally attacker-chosen) string into
// a message that ends up in a log.
const MAX_ISSUES_REPORTED = 10;
const MAX_ISSUE_DETAIL_LENGTH = 200;
const MAX_UNRECOGNIZED_KEYS_REPORTED = 5;
const MAX_KEY_NAME_LENGTH = 60;

function truncateForMessage(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated, ${value.length} chars total]`;
}

/**
 * Formats one Zod issue for the aggregate error message.
 *
 * For every issue code Zod emits for the schemas in this file (invalid_type,
 * invalid_value, invalid_format, too_small/too_big, and our own custom
 * `.refine`/`.min` messages), `issue.message` describes the *rule* that was
 * violated -- it does not echo the value that violated it back verbatim.
 * `unrecognized_keys` is the one exception: its `keys` array is the actual,
 * attacker-controlled property names pulled straight out of the parsed
 * JSON, and Zod's default message embeds them (and their full length)
 * as-is. That case is handled separately here so those names are capped,
 * bounded in count, and clearly labelled rather than passed through.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  if (issue.code === "unrecognized_keys") {
    const shown = issue.keys
      .slice(0, MAX_UNRECOGNIZED_KEYS_REPORTED)
      .map((key) => truncateForMessage(key, MAX_KEY_NAME_LENGTH));
    const omitted = issue.keys.length - shown.length;
    const suffix = omitted > 0 ? `, and ${omitted} more` : "";
    return `${path}: unexpected field(s): ${shown.join(", ")}${suffix}`;
  }
  return `${path}: ${truncateForMessage(issue.message, MAX_ISSUE_DETAIL_LENGTH)}`;
}

// Marker used only to distinguish "the JSON contained a disallowed
// __proto__ key" from an ordinary JSON syntax error inside the single
// catch block in parseJson below -- never thrown across that boundary,
// never surfaced to a caller.
class ProtoKeyError extends Error {}

/**
 * JSON.parse itself is safe from prototype pollution: its own algorithm
 * (InternalizeJSONProperty) assigns a `"__proto__"` key as an ordinary own
 * data property, never as the object's actual prototype -- verified
 * empirically (Object.getPrototypeOf stays Object.prototype either way).
 * But Zod 4.4.3's own object-shape checking special-cases that one key name
 * and silently drops it from the parsed result instead of reporting it as
 * an unrecognized key, which would quietly violate this file's closed-
 * schema invariant for that one key alone (every other made-up key is
 * correctly refused). The reviver below rejects `"__proto__"` at any
 * nesting depth before a Zod schema ever sees the value, so it is refused
 * the same way every other unrecognized key is: as a parse failure.
 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw, (key, value) => {
      if (key === "__proto__") throw new ProtoKeyError();
      return value;
    });
  } catch (error) {
    if (error instanceof ProtoKeyError) {
      throw new Error('Agent output contains a disallowed "__proto__" key');
    }
    throw new Error("Agent output is not valid JSON");
  }
}

/**
 * Parses a raw agent output string against `schema`. Throws on invalid JSON
 * and on any schema violation (including an unrecognised field, since every
 * schema in this file is closed) -- there is no partial-success path. The
 * thrown message is built entirely from `describeIssue` above (plus the
 * fixed, non-attacker-controlled `"__proto__"` message above), so it never
 * carries unbounded or verbatim untrusted content.
 */
export function parseAgentOutput<T>(schema: z.ZodType<T>, raw: string): T {
  const parsed = parseJson(raw);
  const result = schema.safeParse(parsed);
  if (result.success) return result.data;

  const issues = result.error.issues;
  const shown = issues.slice(0, MAX_ISSUES_REPORTED).map(describeIssue);
  const omitted = issues.length - shown.length;
  const suffix = omitted > 0 ? ` (and ${omitted} more issue(s))` : "";
  throw new Error(`Agent output failed schema validation -> ${shown.join("; ")}${suffix}`);
}

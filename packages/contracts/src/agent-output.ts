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

// Fix round 1, MINOR 3: rejecting a "__proto__" key must live in the schema
// itself, not only in parseAgentOutput's JSON.parse reviver -- otherwise a
// caller that reaches straight for `someSchema.safeParse(json)` (bypassing
// parseAgentOutput) would still get Zod 4.4.3's silent drop of that one key
// (see the long comment on parseJson further down for how that was found).
// z.preprocess runs on the RAW value, before Zod's own strictObject shape
// checking has a chance to strip the key, so this is the one place that can
// actually see it. Applied to every z.strictObject below, at every nesting
// depth, not only the outermost ones -- an object nested inside an array
// (a citation, a finding) is exactly as reachable by a direct caller as the
// top-level shape is.
const PROTO_KEY_MESSAGE = 'disallowed "__proto__" key';

function noProtoKey<Output>(schema: z.ZodType<Output>): z.ZodType<Output> {
  return z.preprocess((value, ctx) => {
    if (value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "__proto__")) {
      ctx.addIssue({ code: "custom", message: PROTO_KEY_MESSAGE });
      return z.NEVER;
    }
    return value;
  }, schema);
}

function strictObjectNoProto<Shape extends z.ZodRawShape>(shape: Shape) {
  return noProtoKey(z.strictObject(shape));
}

// Fix round 1, MINOR 4 (and fix round 2's IMPORTANT finding, same bug class
// in the opposite direction -- see requireNonBlank below): U+200B (ZERO
// WIDTH SPACE) and its relatives are Unicode category Cf ("format") --
// invisible, but not part of the WhiteSpace/LineTerminator productions
// ECMA-262's String#trim() strips. A model (or a hostile page it read)
// could pad an otherwise-empty string with only these and defeat a naive
// `v.trim().length > 0` check. \p{Cf} in a Unicode-mode regex covers the
// whole category, not just U+200B. Deliberately does NOT require the
// string to be trimmed -- leading/trailing whitespace around real content
// must still pass (see requireNonBlank's tests).
//
// Note on the database side: every P1 CHECK this pattern is compared
// against (content_version.body, source_citation.excerpt -- see
// requireNonBlank) uses `~ '\S'` (PostgreSQL's ARE engine), whose `\s`/`\S`
// classes are ASCII whitespace only -- Postgres does NOT treat U+200B as
// whitespace, so a Cf-only string would pass those CHECKs. This pattern is
// therefore stricter than the database for that one input class: it
// refuses something the database alone would accept. That is the safe
// direction to diverge in (fails closed -- everything this pattern accepts
// as non-blank, the database's `~ '\S'` also accepts as non-blank, since
// ASCII whitespace is a subset of what \s+Cf both treat as blank; the
// reverse is not required to hold and does not). See task-5-report.md,
// "Fix round 2" for the audit of every string field against its column's
// actual CHECK.
const BLANK_PATTERN = /^[\s\p{Cf}]*$/u;

/**
 * Fix round 2, IMPORTANT: content_version.body and source_citation.excerpt
 * both carry a `CHECK (x ~ '\S')` in P1's schema (infra/migrations/
 * 0009_check_whitespace_hardening.sql, 0021_whitespace_hardening_gap.sql).
 * `z.string().min(1)` (the brief's literal spec for these two fields) is a
 * LENGTH check, not a blankness check -- a single space, or a tab+newline,
 * both have length 1-2 and passed, but the database would refuse the
 * insert. That is precisely the failure mode T5 exists to prevent: an
 * invalid output should fail at this contract boundary, not later as a
 * database error after the run has already done work.
 *
 * Reuses BLANK_PATTERN (whitespace + Cf) rather than a bare `~ '\S'`
 * translation, which is at least as strict as the database's rule (see the
 * note on BLANK_PATTERN above) -- "stricter is fine, never looser" per the
 * rule applied uniformly across every field in this file that backs a
 * checked column.
 */
function requireNonBlank(fieldName: string) {
  return z.string().refine((v) => !BLANK_PATTERN.test(v), {
    message: `${fieldName} must not be blank`,
  });
}

// Fix round 1, IMPORTANT 2: citation urls are model-supplied text that a
// founder may click directly from the UI. z.string().url() (the brief's
// literal spec) only checks that the value parses as *some* URL -- it does
// not restrict the scheme, so "javascript:", "data:", and "file:" all
// passed. Restricted to http/https at the schema level (not a .refine
// bolted on afterwards) via z.url()'s own `protocol` option.
//
// Backs source_citation.url, which separately carries `CHECK (url ~ '\S')`
// (infra/migrations/0021_whitespace_hardening_gap.sql). Already strictly
// stronger: every string this schema accepts is a syntactically valid
// http(s) URL, which by construction always contains at least one
// non-whitespace character -- there is no valid http(s) URL made only of
// whitespace/Cf characters. No separate blankness check needed here.
const httpUrlSchema = z.url({ protocol: /^https?$/ });

// Same shape as SourceCitation's public fields (packages/domain/src/
// content.ts) minus `id` and `verificationStatus` -- those are assigned by
// domain code when a SourceCitation is built, never trusted from model
// output directly.
const agentCitationSchema = strictObjectNoProto({
  url: httpUrlSchema,
  accessedAt: z.string().datetime(),
  // Backs source_citation.excerpt, CHECK (excerpt ~ '\S'). See
  // requireNonBlank's doc comment (fix round 2).
  excerpt: requireNonBlank("excerpt"),
});

export const researchOutputSchema = strictObjectNoProto({
  findings: z.array(
    strictObjectNoProto({
      // No column backs `claim` yet (T6 adds the finding table). Left as
      // length-only per the brief -- min(1) is not "looser than a column"
      // when there is no column to compare against. See task-5-report.md,
      // "Fix round 2" audit table.
      claim: z.string().min(1),
      // Reuses domain's single source of truth for the allowed values
      // instead of redeclaring a second list that could drift from it.
      verificationStatus: z.enum(VERIFICATION_STATUSES),
      citations: z.array(agentCitationSchema).min(1, "every finding needs at least one citation"),
    }),
  ),
});

export const contentOutputSchema = strictObjectNoProto({
  // Backs content_version.body, CHECK (body ~ '\S'). See requireNonBlank's
  // doc comment (fix round 2).
  body: requireNonBlank("body"),
  // Backs content_version.publication_content, which is nullable and has NO
  // CHECK constraint at all in P1's schema -- there is nothing to disagree
  // with here, so this being stricter than "no constraint" is simply extra
  // safety, not a database-divergence case like `body`/`excerpt` above.
  publicationContent: requireNonBlank("publicationContent"),
  // No column backs this yet (T6 adds the tables that would); left as a
  // bare array of strings per the brief, with no per-item constraint. See
  // task-5-report.md, "Fix round 2" audit table.
  claimsUsed: z.array(z.string()),
});

export const qaOutputSchema = strictObjectNoProto({
  verdict: z.enum(["pass", "block"]),
  /**
   * Display and veto signal only. Never a permission input (invariant 4).
   * Backs content_version.quality_score, `CHECK (quality_score BETWEEN 0
   * AND 100)` -- an exact match, not a string field, so it is outside fix
   * round 2's blankness audit but included in task-5-report.md's table for
   * completeness.
   */
  qualityScore: z.number().int().min(0).max(100),
  findings: z.array(
    strictObjectNoProto({
      severity: z.enum(["info", "warn", "block"]),
      // No column backs `message` yet (T6 adds the qa-finding table). Same
      // reasoning as researchOutputSchema's `claim` above.
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
 * correctly refused).
 *
 * The authoritative fix is `noProtoKey` above, on the schemas themselves, so
 * it holds for any caller -- including one that calls a schema's
 * `.safeParse` directly and never goes through `parseAgentOutput` at all.
 * The reviver below is a second, earlier layer specific to this function:
 * it rejects `"__proto__"` at any nesting depth before JSON.parse even
 * finishes, so a caller going through parseAgentOutput gets the failure at
 * the JSON-parsing stage rather than waiting for schema validation.
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

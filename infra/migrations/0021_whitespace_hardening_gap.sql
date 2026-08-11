-- Final whole-branch review, FINDING 5 (LOW). 0009_check_whitespace_
-- hardening.sql replaced `length(btrim(x)) > 0` with `x ~ '\S'` on every
-- column that ALREADY carried a btrim-based blankness CHECK, because
-- btrim() only strips ASCII spaces (U+0020) and a tab/newline-only value
-- passed the old CHECK while the domain layer's `.trim()` correctly
-- rejected it as blank. That migration's own scope was exactly "every
-- column across the schema that previously used the btrim pattern" -- four
-- columns never had ANY blankness CHECK, in either form, and so were never
-- touched: goal.statement (0004_campaign.sql), source_citation.url and
-- source_citation.excerpt (0006_content.sql), audit_log.event_type
-- (0001_core_tenancy.sql). All four accept a whitespace-only value today.
--
-- Same `~ '\S'` rule as 0009, same reasoning: NULL is unaffected in every
-- case (all four columns are already NOT NULL, so NULL never reaches the
-- CHECK regardless of which expression guards it).
--
-- Named constraints (not anonymous CHECKs), matching every other CHECK in
-- this schema, so a violation's error message is readable. Idempotent:
-- DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT makes re-running this
-- file safe.
ALTER TABLE goal DROP CONSTRAINT IF EXISTS goal_statement_check;
ALTER TABLE goal ADD CONSTRAINT goal_statement_check CHECK (statement ~ '\S');

ALTER TABLE source_citation DROP CONSTRAINT IF EXISTS source_citation_url_check;
ALTER TABLE source_citation ADD CONSTRAINT source_citation_url_check CHECK (url ~ '\S');

ALTER TABLE source_citation DROP CONSTRAINT IF EXISTS source_citation_excerpt_check;
ALTER TABLE source_citation ADD CONSTRAINT source_citation_excerpt_check CHECK (excerpt ~ '\S');

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_event_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_event_type_check CHECK (event_type ~ '\S');

-- Fix round 1 on Task 8, MEDIUM. Every existing `CHECK (length(btrim(x)) > 0)`
-- in this schema only rejects a value that is empty or made only of ASCII
-- spaces (U+0020): PostgreSQL's single-argument btrim() strips exactly the
-- space character and nothing else. A value made only of tabs and/or
-- newlines (e.g. E'\t\n') has length > 0 after btrim() and passes the
-- CHECK, while the domain layer's `.trim()` (packages/domain/src/approval.ts
-- decideApproval, and the equivalent guards in campaign.ts / content.ts)
-- strips the full Unicode whitespace class and would reject the identical
-- string as blank. Reproduced: inserting reason = E'\t\n' against 0007's
-- original CHECK succeeded. The database must refuse exactly what the
-- domain refuses, not a narrower ASCII-space-only version of it.
--
-- Replaced with `x ~ '\S'` (matches only if the string contains at least
-- one character PostgreSQL's regex engine does NOT classify as whitespace,
-- i.e. not one of space/tab/newline/CR/FF/VT) on every column across the
-- schema that previously used the btrim pattern:
--   campaign.name              (0004_campaign.sql)
--   content_item.title         (0006_content.sql)
--   content_version.body       (0006_content.sql)
--   approval_request.target_channel (0007_approval.sql)
--   approval_decision.reason   (0007_approval.sql)
-- NULL is unaffected in every case: all five columns are already NOT NULL,
-- so NULL never reaches the CHECK regardless of which expression guards it.
ALTER TABLE campaign DROP CONSTRAINT campaign_name_check;
ALTER TABLE campaign ADD CONSTRAINT campaign_name_check CHECK (name ~ '\S');

ALTER TABLE content_item DROP CONSTRAINT content_item_title_check;
ALTER TABLE content_item ADD CONSTRAINT content_item_title_check CHECK (title ~ '\S');

ALTER TABLE content_version DROP CONSTRAINT content_version_body_check;
ALTER TABLE content_version ADD CONSTRAINT content_version_body_check CHECK (body ~ '\S');

ALTER TABLE approval_request DROP CONSTRAINT approval_request_target_channel_check;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_target_channel_check CHECK (target_channel ~ '\S');

ALTER TABLE approval_decision DROP CONSTRAINT approval_decision_reason_check;
ALTER TABLE approval_decision ADD CONSTRAINT approval_decision_reason_check CHECK (reason ~ '\S');

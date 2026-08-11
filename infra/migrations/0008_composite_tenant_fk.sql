-- Fix round 1 on Task 8. Adversarial review reproduced live: a session
-- scoped to workspace B could insert an approval_decision with
-- workspace_id = B that referenced an approval_request row belonging to
-- workspace A. PostgreSQL checks a foreign key against the referenced
-- table with row level security bypassed entirely -- FKs are enforced by
-- an internal trigger that runs as the table owner, not as the querying
-- role, so RLS's per-workspace filtering never participates in that check.
-- A single-column FK on approval_request_id therefore only ever verified
-- that *some* approval_request with that id existed anywhere in the
-- database, never that it belonged to the same workspace as the child row
-- being inserted. Because approval_request_id is also UNIQUE, the
-- hijacked row permanently occupied the slot, which would have let
-- workspace B permanently deny workspace A's real user the ability to
-- ever record a decision on their own request -- a cross-tenant denial of
-- service on the one gate this milestone exists to protect.
--
-- This is a pattern bug, not a one-off: every foreign key between two
-- workspace-owned tables in every migration up to 0007 has the identical
-- hole. All seven are fixed here, forward-only -- 0004, 0006 and 0007 are
-- applied and are never edited:
--   campaign.goal_id                      -> goal
--   content_item.campaign_id              -> campaign
--   content_version.content_item_id       -> content_item
--   source_citation.content_version_id    -> content_version
--   approval_request.campaign_id          -> campaign
--   approval_request.content_version_id   -> content_version
--   approval_decision.approval_request_id -> approval_request
--
-- The fix is a composite foreign key on (referenced_id, workspace_id)
-- against a UNIQUE (id, workspace_id) on the parent -- redundant with the
-- parent's primary key (id alone is already unique) but required for
-- PostgreSQL to allow a composite FK to reference that pair at all. Once
-- workspace_id is part of the key, a child row cannot reference a parent
-- in a different workspace: the two columns must agree or the FK itself
-- rejects the row, regardless of what RLS would or would not have shown
-- the session.
--
-- Only tables that are referenced as a parent below need the extra
-- UNIQUE (id, workspace_id); source_citation and approval_decision are
-- leaves in this graph and get none. Order matters: each parent's
-- UNIQUE (id, workspace_id) is added before any child FK that depends on
-- it. The old single-column FKs are dropped, not kept alongside the new
-- ones -- keeping both would leave two rules doing overlapping, easily
-- misread work for zero additional protection (the composite FK is
-- strictly stronger: satisfying it implies satisfying the old one, since
-- id alone is already the parent's primary key).

-- goal is a parent of campaign.
ALTER TABLE goal ADD CONSTRAINT goal_id_workspace_id_key UNIQUE (id, workspace_id);

-- campaign is a parent of content_item and approval_request.
ALTER TABLE campaign ADD CONSTRAINT campaign_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE campaign DROP CONSTRAINT campaign_goal_id_fkey;
ALTER TABLE campaign ADD CONSTRAINT campaign_goal_id_workspace_fkey
  FOREIGN KEY (goal_id, workspace_id) REFERENCES goal (id, workspace_id);

-- content_item is a parent of content_version.
ALTER TABLE content_item ADD CONSTRAINT content_item_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE content_item DROP CONSTRAINT content_item_campaign_id_fkey;
ALTER TABLE content_item ADD CONSTRAINT content_item_campaign_id_workspace_fkey
  FOREIGN KEY (campaign_id, workspace_id) REFERENCES campaign (id, workspace_id);

-- content_version is a parent of source_citation and approval_request.
ALTER TABLE content_version ADD CONSTRAINT content_version_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE content_version DROP CONSTRAINT content_version_content_item_id_fkey;
ALTER TABLE content_version ADD CONSTRAINT content_version_content_item_id_workspace_fkey
  FOREIGN KEY (content_item_id, workspace_id) REFERENCES content_item (id, workspace_id);

-- source_citation is a leaf: no UNIQUE (id, workspace_id) needed.
ALTER TABLE source_citation DROP CONSTRAINT source_citation_content_version_id_fkey;
ALTER TABLE source_citation ADD CONSTRAINT source_citation_content_version_id_workspace_fkey
  FOREIGN KEY (content_version_id, workspace_id) REFERENCES content_version (id, workspace_id);

-- approval_request is a parent of approval_decision, and itself a child of
-- both campaign and content_version.
ALTER TABLE approval_request ADD CONSTRAINT approval_request_id_workspace_id_key UNIQUE (id, workspace_id);
ALTER TABLE approval_request DROP CONSTRAINT approval_request_campaign_id_fkey;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_campaign_id_workspace_fkey
  FOREIGN KEY (campaign_id, workspace_id) REFERENCES campaign (id, workspace_id);
ALTER TABLE approval_request DROP CONSTRAINT approval_request_content_version_id_fkey;
ALTER TABLE approval_request ADD CONSTRAINT approval_request_content_version_id_workspace_fkey
  FOREIGN KEY (content_version_id, workspace_id) REFERENCES content_version (id, workspace_id);

-- approval_decision is a leaf: no UNIQUE (id, workspace_id) needed. Its
-- existing UNIQUE (approval_request_id) constraint from 0007 is untouched:
-- it still enforces "at most one decision per request," independent of
-- workspace, exactly as before.
ALTER TABLE approval_decision DROP CONSTRAINT approval_decision_approval_request_id_fkey;
ALTER TABLE approval_decision ADD CONSTRAINT approval_decision_approval_request_id_workspace_fkey
  FOREIGN KEY (approval_request_id, workspace_id) REFERENCES approval_request (id, workspace_id);

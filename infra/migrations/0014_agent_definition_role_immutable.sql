-- Fix round 2 on Task 10. Fix round 1 (0013) closed the direct path: an
-- agent_version can no longer be inserted or updated to activated=true for
-- a non-M1 role. That round's own report disclosed a residual: 0013's
-- trigger lives on agent_version and only fires on writes to
-- agent_version.activated / agent_version.agent_definition_id. Nothing
-- stopped `UPDATE agent_definition SET role = 'integration_reliability'`
-- on a definition that already has an activated=true agent_version
-- pointing at it -- the version's own columns never change, so 0013 never
-- re-fires, and the four-agent cost control is defeated through a door
-- that looks nothing like the one already closed: activate `content`
-- legitimately, then rename the definition itself out from under the
-- already-activated version.
--
-- `role` is the definition's identity -- which agent this is. There is no
-- legitimate reason to rename `content` into `integration_reliability` on
-- an existing row; the correct operation is to insert a different
-- agent_definition. This is therefore made unconditionally immutable, the
-- same column-selective `BEFORE UPDATE OF <column>` pattern as
-- publication_core_fields_immutable() in 0011_publication_immutability.sql:
-- the trigger fires only when an UPDATE's SET clause names `role` itself
-- (including the DO UPDATE arm of INSERT ... ON CONFLICT, which PostgreSQL
-- fires the same column-selective UPDATE trigger for), leaving every other
-- column on agent_definition -- in particular `mission`, since agent
-- contracts are expected to be revised -- freely updatable.
--
-- Two other doors were checked for the same class of bug and found already
-- closed, not requiring a new guard here (verified in
-- packages/db/src/agent-definition-immutability.test.ts):
--   1. agent_version.agent_definition_id (repointing an activated version
--      at a different definition): 0013's trigger is declared
--      `BEFORE INSERT OR UPDATE OF activated, agent_definition_id ...
--      WHEN (NEW.activated)`, so any UPDATE naming agent_definition_id in
--      its SET clause already re-fires the gate and re-validates against
--      the (possibly new) parent's role, whether or not `activated` is
--      also named in the same statement.
--   2. DELETE + reinsert under the same id, to swap out an
--      agent_definition an activated version depends on without touching
--      either trigger: smos_app was never granted DELETE on either table
--      (0012_agent_registry.sql's GRANT is SELECT, INSERT, UPDATE only),
--      so this is refused at the privilege level before it ever reaches a
--      trigger, and a referenced agent_definition could not be deleted
--      anyway while any agent_version still points at it (the composite FK
--      has no ON DELETE clause, so it defaults to NO ACTION/RESTRICT).
CREATE OR REPLACE FUNCTION agent_definition_role_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'agent_definition.role is immutable; role is the definition''s identity -- insert a different agent_definition row instead of renaming this one';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_definition_role_immutable ON agent_definition;
CREATE TRIGGER agent_definition_role_immutable
  BEFORE UPDATE OF role ON agent_definition
  FOR EACH ROW EXECUTE FUNCTION agent_definition_role_immutable();

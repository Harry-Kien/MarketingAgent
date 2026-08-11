-- Fix round 1 on Task 10. Adversarial review reproduced live: inserting
-- agent_version(role effectively 'integration_reliability', activated=true)
-- directly as smos_app, inside a properly RLS-scoped transaction, succeeded
-- with no error. Nothing in 0012_agent_registry.sql (applied, never edited)
-- limited which roles -- or how many -- could ever be marked activated.
--
-- That is a hole in the project's primary cost control. Blueprint 11.2.1 /
-- invariant 6 says only four agents are activated in M1; invariant 5 says a
-- non-activated agent must never create an AgentRun or call a model
-- provider, and in P2 those calls cost real money. Every other invariant
-- this milestone protects already has a database backstop -- campaign
-- state has a CHECK (0005), approval actor has a CHECK plus a foreign key
-- (0007), publication content has an immutability trigger (0011) -- this
-- one was the exception: assertActivated (packages/domain/src/agent-
-- registry.ts) was the only thing stopping a fifth agent from running, and
-- it is TypeScript. A raw SQL write, a buggy seeder, or a future migration
-- could all bypass it entirely.
--
-- `role` lives on agent_definition, not agent_version, so a plain CHECK on
-- agent_version cannot see it -- PostgreSQL CHECK constraints may only
-- reference columns of the same row. Two ways to close that: denormalise
-- `role` onto agent_version, or use a trigger that looks up the parent
-- role via the composite FK 0012 already put in place. Denormalising was
-- rejected: it creates a second copy of `role` that must be kept in sync
-- with agent_definition.role forever (itself requiring more triggers to
-- stop it drifting), for a column this table would otherwise never need.
-- A BEFORE INSERT OR UPDATE trigger that joins to agent_definition on
-- (agent_definition_id, workspace_id) -- the exact pair the composite FK
-- already guarantees exists and agrees on workspace -- is simpler to
-- reason about and adds no new mutable state. It runs as the invoking role
-- (smos_app, the default for a PL/pgSQL function with no SECURITY DEFINER
-- clause), so its SELECT is itself subject to agent_definition's own RLS
-- policy; that is not a hole here because a row can only pass this
-- trigger's later NOT NULL check if its agent_definition_id/workspace_id
-- pair is visible under the same session scope the row is being written
-- into, which the composite FK and this table's own tenant policy already
-- require to agree.
--
-- The four roles below MUST mirror M1_ACTIVATED_AGENTS in
-- packages/domain/src/agent-registry.ts exactly and are changed only
-- alongside it. Activating a fifth agent in a later milestone is a
-- deliberate forward migration that edits this list and the TypeScript
-- constant together -- never a code-only change, and never an edit to this
-- file (0013 is applied and is never edited; a later milestone adds a new
-- migration that replaces this function body).
--
-- WHEN (NEW.activated) means the trigger does nothing at all for the
-- overwhelmingly common case of registering a role inactive (all fifteen
-- contracts must exist per ALL_AGENT_ROLES) or updating any column other
-- than activated/agent_definition_id on an already-inactive row.
CREATE OR REPLACE FUNCTION agent_version_m1_activation_gate() RETURNS trigger AS $$
DECLARE
  v_role text;
BEGIN
  SELECT role INTO v_role
  FROM agent_definition
  WHERE id = NEW.agent_definition_id AND workspace_id = NEW.workspace_id;

  IF v_role IS NULL THEN
    RAISE EXCEPTION
      'agent_version.agent_definition_id % has no matching agent_definition row in workspace %',
      NEW.agent_definition_id, NEW.workspace_id;
  END IF;

  IF v_role NOT IN ('orchestrator', 'research', 'content', 'qa_brand_safety') THEN
    RAISE EXCEPTION
      'agent_version cannot be activated for role %: only orchestrator, research, content and qa_brand_safety are activated in M1 (M1_ACTIVATED_AGENTS, packages/domain/src/agent-registry.ts). Activating a fifth agent is a deliberate forward migration, not a code edit.',
      v_role;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_version_m1_activation_gate ON agent_version;
CREATE TRIGGER agent_version_m1_activation_gate
  BEFORE INSERT OR UPDATE OF activated, agent_definition_id ON agent_version
  FOR EACH ROW
  WHEN (NEW.activated)
  EXECUTE FUNCTION agent_version_m1_activation_gate();

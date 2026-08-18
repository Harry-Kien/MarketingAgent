-- M2B Task 2: message is a record of what a real customer actually sent or
-- received; once written it must never change. 0040_conversation_domain.sql
-- granted smos_app UPDATE on message (matching every other table's default
-- grant) so this migration is what actually locks it down -- the same two-
-- migration shape 0028_integration.sql -> 0032_webhook_delivery_nonce_and_
-- audit.sql already used for webhook_delivery, and for the identical reason
-- stated there: "the grant is revoked AND a trigger refuses the UPDATE, so
-- re-granting UPDATE in some future migration is not by itself enough to
-- reopen it."
CREATE OR REPLACE FUNCTION message_is_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'message is an immutable record of what a real customer sent or received; % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS message_no_mutation ON message;
CREATE TRIGGER message_no_mutation
  BEFORE UPDATE ON message
  FOR EACH ROW EXECUTE FUNCTION message_is_immutable();

REVOKE UPDATE ON message FROM smos_app;

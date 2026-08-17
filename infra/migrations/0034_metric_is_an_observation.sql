-- Late-review IMPORTANT 4: a stale metric could be relabelled current.
--
-- Reproduced live as smos_app:
--
--   update metric set freshness_at = now() where id = <30-day-old row>
--
-- ...was ACCEPTED, and left `confidence = 'high'` untouched -- so a month-old
-- number was presented as measured moments ago, at the top confidence tier.
-- A future-dated freshness_at also inserted without complaint.
--
-- ADR-005 is the rule this violated: "a metric that cannot state its
-- freshness and attribution must not exist", which 0028_integration.sql
-- implemented only as NOT NULL columns -- it made a metric SAY a freshness,
-- never made that statement TRUE. The whole guarantee lived in the
-- presentation layer (apps/web/src/ui/MetricValue.tsx flags anything older
-- than 24h as stale), and the UPDATE above simply moved the row out of the
-- window the UI was checking. This is the project's recurring failure mode
-- once more: an invariant that existed only above the database, defeated by
-- direct SQL.
--
-- Three mechanisms:
--
-- 1. A metric row is IMMUTABLE. 0028's own upsertMetric comment already
--    says what a metric row is: "a fresh row per observation (a time series
--    point), not a literal SQL UPSERT overwriting a single value ... a
--    history of freshness-stamped observations is more honest than one
--    mutable summary cell". An observation is a record of what was measured
--    at one instant; there is no legitimate later edit to any column of it,
--    so -- unlike publication (0011) or agent_run (0027), both of which keep
--    a real lifecycle moving -- this needs no exempt column at all, not even
--    updated_at, which the table does not have. Whole-row comparison via
--    to_jsonb follows 0027 rather than enumerating columns, so a column
--    added later is frozen by default instead of silently editable.
--    A row-identical UPDATE is still permitted (0023's precedent).
--
--    Paired with REVOKE UPDATE, so the grant and the trigger are two
--    independent locks and re-granting one does not reopen the hole
--    (0001_core_tenancy.sql's audit_log pattern). DELETE is deliberately not
--    touched: smos_app has no DELETE grant on metric and never had one,
--    while the migration role's ability to delete is what every integration
--    test in this repository cleans up with (0028's own closing comment).
--
-- 2. freshness_at may not be in the future. This cannot be a CHECK
--    constraint -- PostgreSQL requires CHECK expressions to be IMMUTABLE and
--    now() is STABLE, so `CHECK (freshness_at <= now())` is refused outright
--    -- hence a BEFORE INSERT trigger. A small tolerance is allowed for
--    ordinary clock skew between an application host and the database (the
--    timestamp is generated in Node, by `new Date()`, and inserted here), so
--    the rule is "not meaningfully in the future" rather than a strict
--    inequality that would make a 200ms clock difference a hard failure.
--
-- 3. confidence = 'high' may not be claimed by an observation that is
--    ALREADY stale when it is written. MetricValue's own threshold is 24h;
--    the database now agrees with it, so a number cannot simultaneously be
--    flagged stale by the UI and stored as top-confidence. This closes the
--    second half of the reviewer's finding -- the relabel left confidence
--    untouched, and freezing the row alone would have preserved a
--    high-confidence claim that was never checked in the first place.
--    'low' and 'medium' remain available for a deliberately backfilled
--    historical observation, which is a real and honest case.

REVOKE UPDATE ON metric FROM smos_app;

CREATE OR REPLACE FUNCTION metric_is_an_immutable_observation() RETURNS trigger AS $$
BEGIN
  IF to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'metric % is a recorded observation at a fixed instant and may not be edited; record a new observation instead',
    OLD.id;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS metric_is_an_immutable_observation ON metric;
CREATE TRIGGER metric_is_an_immutable_observation
  BEFORE UPDATE ON metric
  FOR EACH ROW EXECUTE FUNCTION metric_is_an_immutable_observation();

CREATE OR REPLACE FUNCTION metric_freshness_is_honest() RETURNS trigger AS $$
BEGIN
  IF NEW.freshness_at > now() + interval '1 minute' THEN
    RAISE EXCEPTION
      'metric.freshness_at % is in the future; a metric cannot have been measured at a time that has not happened',
      NEW.freshness_at;
  END IF;

  IF NEW.confidence = 'high' AND NEW.freshness_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION
      'metric.freshness_at % is already stale (over 24 hours old) and cannot be recorded at confidence "high"',
      NEW.freshness_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS metric_freshness_is_honest ON metric;
CREATE TRIGGER metric_freshness_is_honest
  BEFORE INSERT ON metric
  FOR EACH ROW EXECUTE FUNCTION metric_freshness_is_honest();

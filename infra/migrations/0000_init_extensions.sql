-- ADR-002 records that CREATE EXTENSION has to be written by hand: Drizzle
-- does not generate it. pgcrypto supplies gen_random_uuid() for seed data and
-- test fixtures; application ids are UUID v7 minted in TypeScript.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

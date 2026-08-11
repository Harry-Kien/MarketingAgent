// Schema tables arrive in P1. P0 only proves the connection works, and an
// empty schema keeps the migration guard honest: there is no table yet that
// could be missing workspace_id.
export {};

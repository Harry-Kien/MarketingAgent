// P4 Task 9: closes the known cross-track gap -- submit-approval.ts's
// `isChannelConnected` was a documented stub that always returned false
// because, when P3 wrote it, there was no channel-integration table.
// 0028_integration.sql has since created `integration`; this wires the real
// check against it, against the real PostgreSQL on 5433, RLS-scoped exactly
// like every other query in this app.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPool } from "@smos/db";
import { newId, type Id } from "@smos/domain";
import { isChannelConnected, providerForChannel } from "./channel-status.ts";

const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const appUrl = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminPool = createDbPool(adminUrl);
const appPool = createDbPool(appUrl);

const workspaceId: Id = newId();

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `channel-status-${workspaceId}`,
  ]);
});

afterAll(async () => {
  await adminPool.query(`delete from integration where workspace_id = $1`, [workspaceId]);
  await adminPool.query(`delete from workspace where id = $1`, [workspaceId]);
  await adminPool.end();
  await appPool.end();
});

describe("providerForChannel", () => {
  it("derives the provider from the leading segment of the channel name", () => {
    expect(providerForChannel("meta_page")).toBe("meta");
  });
  it("returns the whole string when there is no underscore, rather than throwing", () => {
    expect(providerForChannel("meta")).toBe("meta");
  });
});

describe("isChannelConnected", () => {
  it("is false with no integration row at all -- fails closed, never infers a connection from silence", async () => {
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(false);
  });

  it("is false when a row exists but is merely disconnected", async () => {
    const id = newId();
    await adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'disconnected')`, [
      id,
      workspaceId,
    ]);
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(false);
    await adminPool.query(`delete from integration where id = $1`, [id]);
  });

  it("is true once the integration is genuinely connected", async () => {
    const id = newId();
    await adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'connected')`, [
      id,
      workspaceId,
    ]);
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(true);
    await adminPool.query(`delete from integration where id = $1`, [id]);
  });

  it("is true when verified in sandbox", async () => {
    const id = newId();
    await adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'sandbox')`, [
      id,
      workspaceId,
    ]);
    await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(true);
    await adminPool.query(`delete from integration where id = $1`, [id]);
  });

  it("never reads a different workspace's integration row (RLS-scoped like every other query)", async () => {
    const otherWorkspaceId = newId();
    await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [otherWorkspaceId, `other-${otherWorkspaceId}`]);
    const id = newId();
    await adminPool.query(`insert into integration (id, workspace_id, provider, status) values ($1, $2, 'meta', 'connected')`, [
      id,
      otherWorkspaceId,
    ]);
    try {
      await expect(isChannelConnected(appPool, workspaceId, "meta_page")).resolves.toBe(false);
    } finally {
      await adminPool.query(`delete from integration where id = $1`, [id]);
      await adminPool.query(`delete from workspace where id = $1`, [otherWorkspaceId]);
    }
  });
});

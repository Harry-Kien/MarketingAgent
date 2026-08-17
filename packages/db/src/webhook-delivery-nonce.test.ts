// Late-review CRITICAL 2, database half: the replay nonce must be consumed
// by VERIFIED deliveries only.
//
// The reviewer's denial of service: `deliveryId` is the nonce, keyed by
// 0028_integration.sql's UNIQUE (workspace_id, provider, external_id), and
// smos_app has no DELETE grant -- so whoever writes that key first owns it
// forever. Sending `d-burn-1` to workspace B first meant B's own genuine
// delivery with that id afterwards returned 200 with "events before 1, after
// 1": silently dropped forever, no error, no trace.
//
// 0032_webhook_delivery_nonce_and_audit.sql replaces the single blanket
// UNIQUE with two DISJOINT PARTIAL unique indexes split on signature_ok, so
// a rejected receipt and a verified delivery can never contend for the same
// key. Every attempt below runs as smos_app, against the real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@smos/domain";
import { createDbPool } from "./client.ts";
import { withTenant } from "./tenant-scope.ts";

const url = process.env["DATABASE_URL"] ?? "postgres://smos_app:smos_app_local_dev@127.0.0.1:5433/smos";
const adminUrl = process.env["DATABASE_MIGRATION_URL"] ?? "postgres://smos:smos_local_dev@127.0.0.1:5433/smos";
const pool = createDbPool(url);
const adminPool = createDbPool(adminUrl);

const workspaceId = newId();

async function insertDelivery(externalId: string, signatureOk: boolean): Promise<number> {
  const r = await withTenant(pool, workspaceId, (tx) =>
    tx.query(
      `insert into webhook_delivery (id, workspace_id, provider, external_id, signature_ok, payload)
       values ($1, $2, 'meta', $3, $4, '{}'::jsonb)
       on conflict (workspace_id, provider, external_id) where ${signatureOk ? "signature_ok" : "not signature_ok"} do nothing
       returning id`,
      [newId(), workspaceId, externalId, signatureOk],
    ),
  );
  return r.rowCount ?? 0;
}

beforeAll(async () => {
  await adminPool.query(`insert into workspace (id, name) values ($1, $2)`, [
    workspaceId,
    `webhook-nonce-${workspaceId}`,
  ]);
});

afterAll(async () => {
  await adminPool.query(`delete from webhook_delivery where workspace_id = $1`, [workspaceId]).catch(() => undefined);
  await adminPool.query(`delete from workspace where id = $1`, [workspaceId]).catch(() => undefined);
  await pool.end();
  await adminPool.end();
});

describe("webhook_delivery replay nonce (CRITICAL 2)", () => {
  it("a rejected receipt does not burn the delivery id a genuine delivery will later claim", async () => {
    const deliveryId = `d-burn-${newId()}`;
    // The attacker's forgery lands first, recorded for audit.
    expect(await insertDelivery(deliveryId, false)).toBe(1);
    // The real sender's delivery, same id, must still be treated as new.
    expect(await insertDelivery(deliveryId, true)).toBe(1);
  });

  it("still refuses a second VERIFIED delivery under the same id -- the replay defense itself is intact", async () => {
    const deliveryId = `d-replay-${newId()}`;
    expect(await insertDelivery(deliveryId, true)).toBe(1);
    expect(await insertDelivery(deliveryId, true)).toBe(0);
  });

  it("collapses repeated identical forgeries into one audit row rather than growing without bound", async () => {
    const deliveryId = `d-forge-${newId()}`;
    expect(await insertDelivery(deliveryId, false)).toBe(1);
    expect(await insertDelivery(deliveryId, false)).toBe(0);
  });

  it("refuses to flip a recorded receipt's signature_ok after the fact", async () => {
    const deliveryId = `d-flip-${newId()}`;
    await insertDelivery(deliveryId, false);
    await expect(
      withTenant(pool, workspaceId, (tx) =>
        tx.query(`update webhook_delivery set signature_ok = true where workspace_id = $1 and external_id = $2`, [
          workspaceId,
          deliveryId,
        ]),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it("smos_app holds no UPDATE or DELETE privilege on webhook_delivery", async () => {
    const r = await adminPool.query(
      `select privilege_type from information_schema.role_table_grants
       where table_name = 'webhook_delivery' and grantee = 'smos_app'`,
    );
    const privileges = (r.rows as Array<{ privilege_type: string }>).map((row) => row.privilege_type).sort();
    expect(privileges).toEqual(["INSERT", "SELECT"]);
  });
});

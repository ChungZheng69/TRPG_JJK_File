import assert from "node:assert/strict";
import { mock, test } from "node:test";
import pg from "pg";

// Exercise the real storage functions and JSONB query boundary, without using a
// live database, credentials, or any existing campaign saves.
process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1/fixture";
const rows = new Map();
const calls = [];
mock.method(pg.Pool.prototype, "query", async (sql, args = []) => {
  calls.push({ sql, args });
  if (sql.includes("CREATE TABLE IF NOT EXISTS")) return { rows: [], rowCount: 0 };
  if (sql.includes("INSERT INTO campaigns")) {
    rows.set(args[0], { campaign_id: args[0], updated_at: new Date(args[1]), state: JSON.parse(args[2]) });
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("SELECT campaign_id")) {
    const row = rows.get(args[0]);
    return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
  }
  throw new Error("Unexpected SQL in test");
});
const storage = await import("../src/storage.js");

test("Postgres persistence retains archives and unknown nested fields through load/save/restore", async () => {
  const state = storage.createDefaultState({
    player: { name: "Fixture", custom_profile_field: { archived: true } },
    rolling_summary: "秘密🙂".repeat(20000),
    recent_events: Array.from({ length: 200 }, (_, index) => `${index}: secret event`),
    growth: { history: Array.from({ length: 150 }, (_, index) => ({ index })), ledger: [], legacy_notes: ["retain"] },
    logs: [{ private: "retain" }],
    narrative_history: ["retain"],
    custom_extension: { saved: true },
    engine_meta: { custom_archive: "retain" }
  });
  await storage.saveState("fixture", state);
  const loaded = await storage.loadCampaign("fixture");
  assert.deepEqual(loaded.state, state);
  await storage.writeCampaign("fixture", { ...loaded, state: { ...loaded.state, rolling_summary: "updated" } });
  const raw = await storage.readRawCampaign("fixture");
  await storage.saveState("restored", raw.state);
  const restored = await storage.loadCampaign("restored");
  assert.deepEqual(restored.state, raw.state);
  assert.equal(restored.state.growth.history.length, 150);
  assert.equal(restored.state.player.custom_profile_field.archived, true);
  assert.equal(restored.state.engine_meta.custom_archive, "retain");
  assert.ok(calls.filter((call) => call.sql.includes("INSERT")).every((call) => typeof call.args[2] === "string"));
  assert.equal(calls.some((call) => /DELETE|ALTER TABLE|DROP TABLE/i.test(call.sql)), false);
});

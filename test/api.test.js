import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../server.js";
import * as realStorage from "../src/storage.js";
import { campaignContext, jsonSize, RESPONSE_LIMITS } from "../src/api-responses.js";
import { ACTION_OPERATIONS } from "../src/request-logging.js";
import { parseDocument } from "yaml";

const clone = (value) => JSON.parse(JSON.stringify(value));
const privateText = "PRIVATE_CAMPAIGN_秘密🙂\\\"\n".repeat(1000);
const records = new Map();
const logs = [];
const storage = {
  ...realStorage,
  async storageHealth() { return { ok: true, mode: "postgres" }; },
  async readRawCampaign(id) { return clone(records.get(id) || null); },
  async loadCampaign(id) {
    const raw = await this.readRawCampaign(id);
    return raw && realStorage.normalizeRecord(raw, id);
  },
  async writeCampaign(id, record) { records.set(id, clone(record)); },
  async saveState(id, state) {
    const record = { campaign_id: id, updated_at: new Date().toISOString(), state: realStorage.createDefaultState(state) };
    records.set(id, clone(record));
    return clone(record);
  }
};
// Server dependencies are called as functions, not as object methods.
storage.loadCampaign = async (id) => {
  const raw = await storage.readRawCampaign(id);
  return raw && realStorage.normalizeRecord(raw, id);
};
let server;
let base;
before(async () => {
  server = createApp({ storage, apiKey: "test-key", logger: (line) => logs.push(JSON.parse(line)) }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function request(path, { method = "GET", body, authorized = true, raw } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(authorized ? { authorization: "Bearer test-key" } : {}), "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text, id: response.headers.get("x-request-id") };
}
function assertSmall(response) {
  const size = jsonSize(response.text);
  assert.ok(size.characters <= RESPONSE_LIMITS.characters, `characters: ${size.characters}`);
  assert.ok(size.bytes <= RESPONSE_LIMITS.bytes, `bytes: ${size.bytes}`);
}
function largeState() {
  return realStorage.createDefaultState({
    player: { name: "Synthetic player", attributes: { physical: 80, technique: 60, mind: 40 },
      resources: { hp: { current: 42, max: 90 }, ce: { current: 30, max: 70 } } },
    recent_events: Array.from({ length: 200 }, (_, index) => `${index}:${privateText}`),
    rolling_summary: privateText,
    important_facts: [privateText],
    growth: { ledger: [], history: Array.from({ length: 130 }, () => ({ note: "archival milestone" })) },
    narrative_history: [{ private_history: privateText }],
    logs: [privateText],
    custom_extension: { nested: { saved: true } },
    entities: { abilities: { synthetic: { id: "synthetic", name: "Synthetic", damage: { min: 2, max: 4 },
      evolution_history: [privateText], mastery_notes: [privateText] } } }
  });
}
const fixture = largeState();
records.set("large", { campaign_id: "large", updated_at: "2026-10-16T00:00:00.000Z", state: clone(fixture) });

test("large save produces bounded context without mutating it or hiding omissions", async (t) => {
  const original = clone(records.get("large"));
  assert.ok(jsonSize(JSON.stringify(original)).bytes > 1000000);
  const response = await request("/campaigns/large");
  assert.equal(response.status, 200);
  assertSmall(response);
  assert.equal(response.body.context.partial, true);
  assert.deepEqual(response.body.state.player.attributes, fixture.player.attributes);
  assert.deepEqual(response.body.state.player.resources, fixture.player.resources);
  assert.ok(response.body.context.omitted_sections.includes("/state/recent_events"));
  assert.deepEqual(records.get("large"), original);
  t.diagnostic(JSON.stringify({ full_save: jsonSize(JSON.stringify(original)), compact_load: jsonSize(response.text) }));
});

test("narrative update acknowledges fields without echoing state and preserves the full save", async (t) => {
  const response = await request("/campaigns/large/narrative", { method: "PATCH", body: { rolling_summary: privateText + "updated" } });
  assert.equal(response.status, 200);
  assertSmall(response);
  assert.deepEqual(response.body.changed_fields, ["rolling_summary"]);
  assert.equal(Object.hasOwn(response.body, "state"), false);
  const saved = records.get("large").state;
  assert.equal(saved.rolling_summary, privateText + "updated");
  assert.deepEqual(saved.recent_events, fixture.recent_events);
  assert.deepEqual(saved.growth.history, fixture.growth.history);
  assert.deepEqual(saved.logs, fixture.logs);
  assert.deepEqual(saved.narrative_history, fixture.narrative_history);
  assert.deepEqual(saved.custom_extension, fixture.custom_extension);
  t.diagnostic(JSON.stringify({ narrative_ack: jsonSize(response.text) }));
});

test("all Action mutation routes return small results and preserve archive fields", async () => {
  const created = await request("/campaigns/new/character/create", { method: "POST", body: {
    name: "New", physical: 60, technique: 60, mind: 60, hp_max: 80, ce_max: 60
  } });
  assert.equal(created.status, 201);
  assertSmall(created);
  const calls = [
    ["PATCH", "character", { name: "Synthetic player", physical: 80, technique: 60, mind: 40, hp_max: 90, hp_current: 42, ce_max: 70, ce_current: 30 }],
    ["POST", "check", { actor_id: "player_001", attribute: "physical", difficulty: 10 }],
    ["POST", "check/reroll", {}],
    ["POST", "resources/change", { target_id: "player_001", operation: "damage", amount: 2 }],
    ["POST", "enemies", { name: "Synthetic enemy", grade: "Grade 4" }],
    ["POST", "abilities", { owner_id: "player_001", name: "Synthetic ability", type: "attack", attribute: "technique", damage_min: 2, damage_max: 4, ce_cost: 1 }],
    ["PATCH", "entities/state", { target_id: "player_001", add_status: "test", note: "test note" }],
    ["POST", "growth/evidence", { category: "physical", significance: "minor", note: "Synthetic training evidence" }]
  ];
  for (const [method, path, body] of calls) {
    const response = await request(`/campaigns/large/${path}`, { method, body });
    assert.equal(response.status, 200, `${path}: ${response.text}`);
    assertSmall(response);
    assert.equal(Object.hasOwn(response.body, "state"), false);
  }
  assert.equal(records.get("large").state.player.resources.hp.current, 40);
  assert.deepEqual(records.get("large").state.logs, fixture.logs);
  assert.deepEqual(records.get("large").state.narrative_history, fixture.narrative_history);
  const evidence = records.get("large").state.growth.ledger.at(-1);
  const growth = await request("/campaigns/large/growth/apply", { method: "POST", body: {
    reason: "Synthetic milestone", evidence_ids: [evidence.evidence_id], physical_delta: 1
  } });
  assert.equal(growth.status, 200, growth.text);
  assertSmall(growth);
  assert.equal(growth.body.growth.after.physical, 81);
  const abilityEvidence = await request("/campaigns/large/growth/evidence", { method: "POST", body: {
    category: "ability", note: "Synthetic ability practice", related_ability_id: "synthetic"
  } });
  const evolution = await request("/campaigns/large/abilities/evolve", { method: "PATCH", body: {
    ability_id: "synthetic", reason: "Synthetic refinement", evidence_ids: [abilityEvidence.body.evidence.evidence_id],
    new_name: "Refined synthetic"
  } });
  assert.equal(evolution.status, 200, evolution.text);
  assertSmall(evolution);
  assert.equal(Object.hasOwn(evolution.body, "state"), false);
});

test("section pages reconstruct escaped Unicode JSON exactly and reject stale versions", async () => {
  const record = records.get("large");
  let offset = 0;
  let serialized = "";
  do {
    const response = await request(`/campaigns/large/sections?pointer=/state/rolling_summary&offset=${offset}&expected_updated_at=${encodeURIComponent(record.updated_at)}`);
    assert.equal(response.status, 200);
    assertSmall(response);
    serialized += response.body.serialized_json;
    offset = response.body.next_offset;
  } while (offset !== null);
  assert.equal(JSON.parse(serialized), record.state.rolling_summary);
  assert.equal((await request("/campaigns/large/sections?expected_updated_at=stale")).status, 409);
  for (const query of ["offset=-1", "offset=9007199254740992", "offset=999999999", "pointer=/__proto__", "pointer=/state/missing", "pointer=/state/~2"]) {
    const response = await request(`/campaigns/large/sections?${query}`);
    assert.ok([400, 404].includes(response.status), query);
    assertSmall(response);
  }
});

test("authenticated export and manual restore preserve a save larger than the Action request limit", async () => {
  const exported = await request("/campaigns/large/export");
  assert.equal(exported.status, 200);
  assert.deepEqual(exported.body.state, records.get("large").state);
  const restored = await request("/campaigns/restored", { method: "PUT", body: { state: exported.body.state } });
  assert.equal(restored.status, 200);
  assertSmall(restored);
  const reloaded = await request("/campaigns/restored/export");
  assert.deepEqual(reloaded.body.state, exported.body.state);
  assertSmall(await request("/campaigns/restored"));
  assert.equal((await request("/campaigns/large/export", { authorized: false })).status, 401);
  assert.equal((await request("/campaigns/large/sections", { authorized: false })).status, 401);
});

test("logging measures serialized JSON exactly and never prints campaign data, IDs, or secrets", async () => {
  const response = await request("/campaigns/large?secret=DO_NOT_LOG");
  const log = logs.find((entry) => entry.event === "http_response" && entry.request_id === response.id);
  assert.equal(log.operation_id, "loadCampaignContext");
  assert.equal(log.route, "/campaigns/:campaignId");
  const size = jsonSize(response.text);
  assert.equal(log.json_characters, size.characters);
  assert.equal(log.json_utf8_bytes, Buffer.byteLength(response.text, "utf8"));
  assert.equal(log.json_utf16_units, response.text.length);
  assert.equal(logs.find((entry) => entry.event === "http_request" && entry.request_id === response.id).operation_id, "loadCampaignContext");
  const combined = JSON.stringify(logs);
  for (const secret of ["PRIVATE_CAMPAIGN", "秘密", "test-key", "DO_NOT_LOG", "Synthetic player", "Synthetic enemy", "Synthetic ability", '"large"']) {
    assert.equal(combined.includes(secret), false, secret);
  }
});

test("auth, malformed JSON, oversized input, missing campaigns and retired combat stay bounded", async () => {
  const cases = [
    ["/campaigns/large", { authorized: false }, 401],
    ["/campaigns/missing", {}, 404],
    ["/campaigns/large/narrative", { method: "PATCH", raw: "{" }, 400],
    ["/campaigns/large/narrative", { method: "PATCH", body: { rolling_summary: "x".repeat(270000) } }, 413],
    ["/campaigns/large/combat/start", { method: "POST", body: {} }, 410],
    ["/not-found?private=PRIVATE_CAMPAIGN", {}, 404]
  ];
  for (const [path, options, status] of cases) {
    const response = await request(path, options);
    assert.equal(response.status, status);
    assertSmall(response);
  }
  assert.equal(JSON.stringify(logs).includes("PRIVATE_CAMPAIGN"), false);
});

test("budget also holds for pathological player and entity fields", () => {
  const state = clone(fixture);
  state.player.inventory = [privateText];
  state.player.profile.appearance = privateText;
  state.player.status = [privateText];
  state.entities.enemies = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`enemy${index}`, { id: `enemy${index}`, description: privateText }]));
  const context = campaignContext({ campaign_id: "budget", updated_at: new Date().toISOString(), state });
  assertSmall({ text: JSON.stringify(context) });
  assert.deepEqual(context.state.player.resources, state.player.resources);
  assert.equal(context.context.partial, true);
  assert.deepEqual(state.player.inventory, [privateText]);
});

test("operation IDs match every OpenAPI Action", async () => {
  const { readFile } = await import("node:fs/promises");
  const schema = await readFile(new URL("../openapi.yaml", import.meta.url), "utf8");
  const document = parseDocument(schema, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const api = document.toJS();
  const operationIds = [];
  for (const [path, methods] of Object.entries(api.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      operationIds.push(operation.operationId);
      assert.equal(ACTION_OPERATIONS[`${method.toUpperCase()} ${path.replace("{campaignId}", ":campaignId")}`], operation.operationId);
      const success = operation.responses["200"] || operation.responses["201"];
      const reference = success.content["application/json"].schema.$ref;
      assert.ok(api.components.schemas[reference.split("/").at(-1)], reference);
    }
  }
  assert.equal(new Set(operationIds).size, operationIds.length);
  assert.equal(Object.values(api.paths).some((methods) => methods.get?.operationId === "exportCampaign"), false);
});

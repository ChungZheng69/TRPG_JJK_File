// Transport budgets, independent of the persistent campaign and game rules.
export const RESPONSE_LIMITS = Object.freeze({ characters: 16000, bytes: 32000 });

export function jsonSize(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return { characters: Array.from(json).length, utf16_units: json.length, bytes: Buffer.byteLength(json, "utf8") };
}

function fits(value, reserve = 0) {
  const size = jsonSize(JSON.stringify(value));
  return size.utf16_units <= RESPONSE_LIMITS.characters - reserve && size.bytes <= RESPONSE_LIMITS.bytes - reserve;
}

const HISTORY_FIELDS = new Set(["state_notes", "mastery_notes", "evolution_history"]);
function withoutHistory(entity) {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) return entity;
  return Object.fromEntries(Object.entries(entity).filter(([key]) => !HISTORY_FIELDS.has(key)));
}

function prefix(text, units) {
  let end = Math.min(text.length, units);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

// Preview descriptive data without touching the source. Partial sections are
// explicitly marked, and saved values remain available through section retrieval.
function preview(value, bytes, { latest = false, depth = 0 } = {}) {
  if (jsonSize(JSON.stringify(value)).bytes <= bytes) return { value, partial: false };
  if (typeof value === "string") {
    let low = 0;
    let high = Math.min(value.length, bytes);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonSize(JSON.stringify(prefix(value, middle))).bytes <= bytes) low = middle;
      else high = middle - 1;
    }
    return { value: prefix(value, low), partial: true };
  }
  if (!value || typeof value !== "object" || depth >= 8) return { value: null, partial: true };
  const array = Array.isArray(value);
  const result = array ? [] : Object.create(null);
  let entries = Object.entries(value);
  if (latest && array) entries = entries.reverse();
  for (const [key, entry] of entries) {
    const remaining = bytes - jsonSize(JSON.stringify(result)).bytes - (array ? 1 : Buffer.byteLength(JSON.stringify(key)) + 2);
    if (remaining < 16) break;
    const projected = preview(entry, Math.min(remaining, 900), { depth: depth + 1 });
    if (array) latest ? result.unshift(projected.value) : result.push(projected.value);
    else result[key] = projected.value;
    if (jsonSize(JSON.stringify(result)).bytes > bytes) {
      if (array) latest ? result.shift() : result.pop();
      else delete result[key];
      break;
    }
    if (Object.keys(result).length >= 20) break;
  }
  return { value: result, partial: true };
}

function actorFields(actor = {}) {
  if (!actor || typeof actor !== "object") return {};
  return Object.fromEntries(["id", "attributes", "resources", "name", "grade", "level", "combat", "status", "narrative_position", "ability_ids", "profile", "inventory"]
    .filter((key) => actor[key] !== undefined).map((key) => [key, actor[key]]));
}

function activeEnemy(enemy, id, scene) {
  if (!enemy || typeof enemy !== "object" || enemy.active === false) return false;
  if (enemy.resources?.hp?.current !== undefined && Number(enemy.resources.hp.current) <= 0) return false;
  if (Array.isArray(scene?.active_enemy_ids)) return scene.active_enemy_ids.includes(id);
  return true;
}

export function campaignContext(record) {
  const state = record.state;
  const response = {
    campaign_id: record.campaign_id,
    updated_at: record.updated_at,
    view: "compact",
    state: {},
    context: { partial: false, omitted_sections: [], retrieve_with: "readCampaignSection" }
  };
  const omitted = new Set();
  function add(target, key, value, pointer, maxBytes = 1000, options = {}) {
    if (value === undefined) return;
    const projected = preview(value, maxBytes, options);
    Object.defineProperty(target, key, { value: projected.value, enumerable: true, configurable: true, writable: true });
    if (projected.partial) omitted.add(pointer);
    if (!fits(response, 1024)) {
      delete target[key];
      omitted.add(pointer);
    }
  }

  const player = actorFields(state.player);
  add(response.state, "player", player, "/state/player", 2200);
  if (Object.keys(state.player || {}).some((key) => !Object.hasOwn(player, key))) omitted.add("/state/player");
  add(response.state, "scene", state.scene, "/state/scene", 1500);
  const summary = typeof state.rolling_summary === "string" ? prefix(state.rolling_summary, 1000) : "";
  add(response.state, "rolling_summary", summary, "/state/rolling_summary", 2000);
  if (summary !== state.rolling_summary) omitted.add("/state/rolling_summary");
  add(response.state, "important_facts", state.important_facts, "/state/important_facts", 1200);
  const recent = Array.isArray(state.recent_events) ? state.recent_events.slice(-10) : [];
  add(response.state, "recent_events", recent, "/state/recent_events", 1200, { latest: true });
  if (recent.length !== state.recent_events?.length) omitted.add("/state/recent_events");

  const enemies = Object.entries(state.entities?.enemies || {}).filter(([id, enemy]) => activeEnemy(enemy, id, state.scene));
  const present = new Set(Array.isArray(state.scene?.present_npcs) ? state.scene.present_npcs : []);
  const npcs = Object.entries(state.entities?.npcs || {}).filter(([id, npc]) => npc && typeof npc === "object" &&
    (present.has(id) || present.has(npc.id) || present.has(npc.name)));
  const abilityIds = new Set([...(Array.isArray(state.player?.ability_ids) ? state.player.ability_ids : []), "basic_attack"]);
  for (const [, actor] of [...enemies, ...npcs]) for (const id of Array.isArray(actor.ability_ids) ? actor.ability_ids : []) abilityIds.add(id);
  const abilityMap = state.entities?.abilities || {};
  const abilities = [...abilityIds].filter((id) => Object.hasOwn(abilityMap, id)).map((id) => [id, abilityMap[id]]);

  response.context.selection = { active_enemy_count: enemies.length, relevant_ability_count: abilities.length };
  response.state.entities = {};
  for (const [group, entries, budget] of [["enemies", enemies, 2600], ["abilities", abilities, 2600], ["npcs", npcs, 800]]) {
    const selected = Object.fromEntries(entries.map(([id, entity]) => [id, group === "abilities" ? withoutHistory(entity) : actorFields(entity)]));
    const pointer = `/state/entities/${group}`;
    add(response.state.entities, group, selected, pointer, budget);
    if (entries.length !== Object.keys(state.entities?.[group] || {}).length ||
        entries.some(([, entity]) => Object.keys(entity).some((key) => HISTORY_FIELDS.has(key)))) omitted.add(pointer);
  }

  for (const key of ["schema_version", "rules", "engine_meta"]) {
    add(response.state, key, state[key], `/state/${key}`, 1000);
  }
  for (const key of ["quests", "relationships", "campaign_flags", "canon_changes", "growth"]) {
    let value = state[key];
    if (key === "growth" && value) {
      value = { ledger: Array.isArray(value.ledger) ? value.ledger.slice(-10) : [] };
      omitted.add("/state/growth");
    }
    add(response.state, key, value, `/state/${key}`, 600);
  }
  const known = new Set(Object.keys(response.state));
  for (const key of Object.keys(state)) if (!known.has(key)) omitted.add("/state");
  response.context.omitted_sections = [...omitted];
  response.context.partial = omitted.size > 0;
  return response;
}

function updatedFields(state, output) {
  if (!state) return {};
  const updated = {};
  const actorId = output.change?.target_id;
  const actor = actorId === state.player?.id ? state.player : state.entities?.enemies?.[actorId] || state.entities?.npcs?.[actorId];
  if (actor) updated.entity = { id: actor.id, resources: actor.resources };
  if (output.check) {
    const last = state.engine_meta.last_check;
    updated.last_check = { original_check_id: last.original_check_id, current_check_id: last.current_check_id,
      reroll_count: last.reroll_count, rolled_at: last.rolled_at };
  }
  if (output.ability) {
    const owner = [state.player, ...Object.values(state.entities?.enemies || {}), ...Object.values(state.entities?.npcs || {})]
      .find((entity) => entity?.ability_ids?.includes(output.ability.id));
    if (owner) updated.owner = { id: owner.id, ability_ids: owner.ability_ids };
  }
  if (output.growth) updated.player = { id: state.player.id, attributes: state.player.attributes,
    resources: state.player.resources, grade: state.player.grade };
  if (output.evolution) updated.ability = withoutHistory(state.entities?.abilities?.[output.evolution.ability_id]);
  return updated;
}

export function mutationResponse(campaignId, updatedAt, output, state) {
  const response = { success: true, campaign_id: campaignId, updated_at: updatedAt };
  const omitted = [];
  const updates = updatedFields(state, output);
  const fields = Object.keys(updates).length ? { ...output, updated: updates } : output;
  for (const [key, value] of Object.entries(fields)) {
    if (key === "state") continue;
    const projected = preview(withoutHistory(value), key === "updated" ? 3000 : 9000);
    response[key] = projected.value;
    if (projected.partial || (value && typeof value === "object" && Object.keys(value).some((field) => HISTORY_FIELDS.has(field)))) omitted.push(key);
    if (!fits(response, 512)) { delete response[key]; omitted.push(key); }
  }
  if (omitted.length) response.response_context = { partial: true, omitted_results: omitted, retrieve_with: "loadCampaignContext" };
  return response;
}

export const HISTORY_SECTIONS = Object.freeze({
  recent_events: "/state/recent_events", narrative_history: "/state/narrative_history",
  important_facts: "/state/important_facts", canon_changes: "/state/canon_changes",
  growth_history: "/state/growth/history", growth_ledger: "/state/growth/ledger", logs: "/state/logs"
});

export function campaignHistory(record, collection = "recent_events", offset = 0, limit = 10) {
  const pointer = HISTORY_SECTIONS[collection];
  if (!Object.hasOwn(HISTORY_SECTIONS, collection)) throw new Error("INVALID_HISTORY_COLLECTION");
  const source = resolvePointer(record, pointer);
  if (source === undefined) return null;
  if (!Array.isArray(source)) throw new Error("HISTORY_NOT_A_COLLECTION");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new Error("INVALID_OFFSET");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("INVALID_LIMIT");
  const response = {
    campaign_id: record.campaign_id, updated_at: record.updated_at, collection,
    offset, total_items: source.length, next_offset: null, items: []
  };
  let index = offset;
  for (; index < Math.min(source.length, offset + limit); index++) {
    const projected = preview(source[index], 1200);
    response.items.push({ index, value: projected.value, partial: projected.partial, pointer: `${pointer}/${index}` });
    if (!fits(response, 512)) { response.items.pop(); break; }
  }
  response.next_offset = index < source.length ? index : null;
  return response;
}

export function resolvePointer(record, pointer) {
  if (pointer === "") return record;
  if (typeof pointer !== "string" || !pointer.startsWith("/") || /~(?:[^01]|$)/.test(pointer)) return undefined;
  let value = record;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

// Lossless chunks of JSON text: concatenate serialized_json then JSON.parse.
// Offsets are UTF-16 units, so clients need no byte-offset/Unicode conversion.
export function campaignSection(record, pointer = "/state", offset = 0) {
  const value = resolvePointer(record, pointer);
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > serialized.length) throw new Error("INVALID_OFFSET");
  let end = Math.min(serialized.length, offset + 6000);
  // Never split a surrogate pair at a page boundary.
  const safeEnd = (position) => position < serialized.length && /[\uD800-\uDBFF]/.test(serialized[position - 1]) ? position - 1 : position;
  end = safeEnd(end);
  const response = {
    campaign_id: record.campaign_id, updated_at: record.updated_at, pointer,
    offset, next_offset: null, total_utf16_units: serialized.length, serialized_json: ""
  };
  do {
    response.serialized_json = serialized.slice(offset, end);
    response.next_offset = end < serialized.length ? end : null;
    if (fits(response)) return response;
    end = safeEnd(offset + Math.floor((end - offset) / 2));
  } while (end > offset);
  throw new Error("SECTION_METADATA_TOO_LARGE");
}

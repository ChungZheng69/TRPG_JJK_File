// Transport budgets, independent of the persistent campaign and game rules.
export const RESPONSE_LIMITS = Object.freeze({ characters: 16000, bytes: 32000 });

export function jsonSize(value) {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return { characters: Array.from(json).length, utf16_units: json.length, bytes: Buffer.byteLength(json, "utf8") };
}

function fits(value, reserve = 0) {
  const size = jsonSize(JSON.stringify(value));
  return size.characters <= RESPONSE_LIMITS.characters - reserve && size.bytes <= RESPONSE_LIMITS.bytes - reserve;
}

const HISTORY_FIELDS = new Set(["state_notes", "mastery_notes", "evolution_history"]);
function withoutHistory(entity) {
  if (!entity || typeof entity !== "object" || Array.isArray(entity)) return entity;
  return Object.fromEntries(Object.entries(entity).filter(([key]) => !HISTORY_FIELDS.has(key)));
}

// Drop whole fields rather than silently changing authoritative values. A caller
// can retrieve every omitted field, including individual entities, by JSON Pointer.
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
  function add(target, key, value, pointer, maxBytes = Infinity) {
    if (value === undefined) return;
    Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
    if (jsonSize(JSON.stringify(value)).bytes > maxBytes || !fits(response, 2048)) {
      delete target[key];
      omitted.add(pointer);
    }
  }

  response.state.player = {};
  const player = state.player || {};
  // Reserve the character's mechanics before spending space on descriptive text.
  const playerKeys = [...new Set(["id", "name", "attributes", "resources", "combat", "status", "ability_ids", ...Object.keys(player)])];
  for (const key of playerKeys) {
    if (HISTORY_FIELDS.has(key)) { omitted.add("/state/player"); continue; }
    add(response.state.player, key, player[key], "/state/player", 4000);
  }

  for (const key of ["schema_version", "rules", "scene", "rolling_summary", "engine_meta"]) {
    add(response.state, key, state[key], `/state/${key}`, 4000);
  }

  response.state.entities = {};
  for (const group of ["abilities", "enemies", "npcs"]) {
    const source = state.entities?.[group] || {};
    const target = response.state.entities[group] = {};
    let groupBytes = 0;
    for (const [id, entity] of Object.entries(source)) {
      const projected = withoutHistory(entity);
      const bytes = jsonSize(JSON.stringify(projected)).bytes;
      const pointer = `/state/entities/${group}`;
      if (Object.keys(entity || {}).some((key) => HISTORY_FIELDS.has(key))) omitted.add(pointer);
      if (groupBytes + bytes > 3000) { omitted.add(pointer); continue; }
      add(target, id, projected, pointer);
      if (Object.hasOwn(target, id)) groupBytes += bytes;
    }
  }
  for (const key of ["quests", "relationships", "campaign_flags", "canon_changes", "important_facts", "recent_events", "growth"]) {
    let value = state[key];
    if (key === "recent_events" && Array.isArray(value) && value.length > 10) {
      value = value.slice(-10);
      omitted.add(`/state/${key}`);
    }
    if (key === "growth" && value) {
      value = { ledger: Array.isArray(value.ledger) ? value.ledger.slice(-10) : [] };
      omitted.add("/state/growth");
    }
    add(response.state, key, value, `/state/${key}`, 3000);
  }
  const known = new Set(Object.keys(response.state));
  for (const key of Object.keys(state)) if (!known.has(key)) omitted.add("/state");
  response.context.omitted_sections = [...omitted];
  response.context.partial = omitted.size > 0;
  return response;
}

export function mutationResponse(campaignId, updatedAt, output) {
  const response = { success: true, campaign_id: campaignId, updated_at: updatedAt };
  const omitted = [];
  for (const [key, value] of Object.entries(output)) {
    if (key === "state") continue;
    response[key] = withoutHistory(value);
    if (!fits(response, 512)) {
      // Preserve useful individual fields of a large operation result.
      response[key] = {};
      for (const [field, entry] of Object.entries(withoutHistory(value) || {})) {
        response[key][field] = entry;
        if (!fits(response, 512)) delete response[key][field];
      }
      omitted.push(key);
    } else if (value && typeof value === "object" && Object.keys(value).some((field) => HISTORY_FIELDS.has(field))) {
      omitted.push(key);
    }
  }
  if (omitted.length) response.response_context = { partial: true, omitted_results: omitted, retrieve_with: "loadCampaignContext" };
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

import fs from "node:fs/promises";
import path from "node:path";
import { BUILTIN_ABILITIES, RULES } from "./rules.js";

const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

export function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function fileFor(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

export async function readRawCampaign(id) {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeCampaign(id, record) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const finalPath = fileFor(id);
  const tempPath = `${finalPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(tempPath, finalPath);
}

function asResource(value, fallbackMax = 100) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const max = Number.isFinite(Number(value.max)) ? Math.max(1, Number(value.max)) : fallbackMax;
    const current = Number.isFinite(Number(value.current)) ? Number(value.current) : max;
    return { current: Math.min(max, Math.max(0, current)), max };
  }
  const n = Number(value);
  if (Number.isFinite(n)) return { current: Math.max(0, n), max: Math.max(fallbackMax, n) };
  return { current: fallbackMax, max: fallbackMax };
}

function asAttribute(value, fallback = 50) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const n = Number(value.value ?? value.base ?? fallback);
    return { value: Math.min(RULES.attribute_max, Math.max(0, Number.isFinite(n) ? n : fallback)), max: RULES.attribute_max };
  }
  const n = Number(value);
  return { value: Math.min(RULES.attribute_max, Math.max(0, Number.isFinite(n) ? n : fallback)), max: RULES.attribute_max };
}

export function createDefaultState(seed = {}) {
  const oldPlayer = seed.player || {};
  const oldAttributes = oldPlayer.attributes || {};
  const oldResources = oldPlayer.resources || {};

  const state = {
    schema_version: RULES.schema_version,
    rules: {
      attribute_max: RULES.attribute_max,
      stat_per_positive_die: RULES.stat_per_positive_die,
      max_positive_dice: RULES.max_positive_dice,
      dice_type: `d${RULES.dice_type}`,
      difficulties: RULES.difficulties
    },
    player: {
      id: oldPlayer.id || "player_001",
      name: oldPlayer.name || "测试角色",
      level: Number(oldPlayer.level || 1),
      grade: oldPlayer.grade || "Grade 4",
      attributes: {
        physical: asAttribute(oldAttributes.physical ?? oldPlayer.physical, 50),
        technique: asAttribute(oldAttributes.technique ?? oldPlayer.technique, 50),
        mind: asAttribute(oldAttributes.mind ?? oldPlayer.mind, 50)
      },
      resources: {
        hp: asResource(oldResources.hp ?? oldPlayer.hp, Number(oldPlayer.max_hp || 100)),
        ce: asResource(oldResources.ce ?? oldPlayer.ce, Number(oldPlayer.max_ce || 100))
      },
      combat: {
        defense_dc: Number(oldPlayer.combat?.defense_dc || oldPlayer.combat?.defense || 10),
        speed: Number(oldPlayer.combat?.speed || 50)
      },
      status: Array.isArray(oldPlayer.status) ? oldPlayer.status : [],
      inventory: Array.isArray(oldPlayer.inventory) ? oldPlayer.inventory : [],
      ability_ids: Array.isArray(oldPlayer.ability_ids) ? oldPlayer.ability_ids : ["basic_attack"]
    },
    entities: {
      npcs: seed.entities?.npcs || seed.npcs || {},
      enemies: seed.entities?.enemies || seed.enemies || {},
      abilities: { ...BUILTIN_ABILITIES, ...(seed.entities?.abilities || seed.abilities || {}) }
    },
    combat_state: seed.combat_state || {
      active: false,
      combat_id: null,
      round: 0,
      turn_index: 0,
      turn_order: [],
      current_actor: null
    },
    scene: seed.scene || {
      date_time: "2018-06-01 10:00",
      location: "东京咒术高专",
      situation: "角色正在等待第一次任务。",
      present_npcs: []
    },
    quests: Array.isArray(seed.quests) ? seed.quests : [],
    relationships: seed.relationships || {},
    campaign_flags: seed.campaign_flags || {},
    canon_changes: Array.isArray(seed.canon_changes) ? seed.canon_changes : [],
    important_facts: Array.isArray(seed.important_facts) ? seed.important_facts : [],
    recent_events: Array.isArray(seed.recent_events) ? seed.recent_events : [],
    rolling_summary: typeof seed.rolling_summary === "string" ? seed.rolling_summary : ""
  };

  return state;
}

export function normalizeRecord(raw, campaignId) {
  const seed = raw?.state && typeof raw.state === "object" ? raw.state : (raw || {});
  const state = seed.schema_version === RULES.schema_version ? createDefaultState(seed) : createDefaultState(seed);
  return {
    campaign_id: campaignId,
    updated_at: raw?.updated_at || new Date().toISOString(),
    state
  };
}

export async function loadCampaign(id, { migrate = true } = {}) {
  const raw = await readRawCampaign(id);
  if (!raw) return null;
  const normalized = normalizeRecord(raw, id);
  if (migrate && normalized.state.schema_version !== raw?.state?.schema_version) {
    normalized.updated_at = new Date().toISOString();
    await writeCampaign(id, normalized);
  }
  return normalized;
}

export async function saveState(id, state) {
  const record = {
    campaign_id: id,
    updated_at: new Date().toISOString(),
    state: createDefaultState(state)
  };
  await writeCampaign(id, record);
  return record;
}

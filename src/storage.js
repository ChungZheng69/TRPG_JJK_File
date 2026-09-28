import pg from "pg";
import { BUILTIN_ABILITIES, RULES } from "./rules.js";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

if (!DATABASE_URL) {
  console.warn("DATABASE_URL/POSTGRES_URL is not configured. Persistent campaign storage is unavailable.");
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

let initPromise = null;

function requireDatabase() {
  if (!pool) {
    const error = new Error("DATABASE_NOT_CONFIGURED");
    error.code = "DATABASE_NOT_CONFIGURED";
    throw error;
  }
}

async function ensureDatabase() {
  requireDatabase();
  if (!initPromise) {
    initPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        campaign_id VARCHAR(80) PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        state JSONB NOT NULL
      )
    `).catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  await initPromise;
}

export async function storageHealth() {
  if (!pool) {
    return {
      ok: false,
      mode: "postgres",
      error: "DATABASE_NOT_CONFIGURED"
    };
  }

  try {
    await ensureDatabase();
    const result = await pool.query("SELECT NOW() AS now");
    return {
      ok: true,
      mode: "postgres",
      database_time: result.rows[0]?.now || null
    };
  } catch (error) {
    return {
      ok: false,
      mode: "postgres",
      error: error.code || error.message || "DATABASE_UNAVAILABLE"
    };
  }
}

export function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

export async function readRawCampaign(id) {
  if (!validId(id)) return null;
  await ensureDatabase();

  const result = await pool.query(
    `SELECT campaign_id, updated_at, state
       FROM campaigns
      WHERE campaign_id = $1`,
    [id]
  );

  if (!result.rowCount) return null;

  const row = result.rows[0];
  return {
    campaign_id: row.campaign_id,
    updated_at: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : new Date(row.updated_at).toISOString(),
    state: row.state
  };
}

export async function writeCampaign(id, record) {
  if (!validId(id)) throw new Error("INVALID_CAMPAIGN_ID");
  await ensureDatabase();

  const updatedAt = record?.updated_at || new Date().toISOString();
  const state = record?.state ?? {};

  await pool.query(
    `INSERT INTO campaigns (campaign_id, updated_at, state)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (campaign_id)
     DO UPDATE SET
       updated_at = EXCLUDED.updated_at,
       state = EXCLUDED.state`,
    [id, updatedAt, JSON.stringify(state)]
  );
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

function textOr(value, fallback = "") {
  return typeof value === "string" ? value.slice(0, 2000) : fallback;
}

function integerInRange(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function normalizePlayerSetup(input = {}, existingPlayer = null) {
  const attrs = input.attributes || {};
  const resources = input.resources || {};
  const hp = resources.hp || {};
  const ce = resources.ce || {};
  const combat = input.combat || {};
  const profile = input.profile || {};

  const previous = existingPlayer || {};
  const previousProfile = previous.profile || {};

  const hpMax = integerInRange(hp.max, previous.resources?.hp?.max ?? 100, 1, 9999);
  const hpCurrent = integerInRange(hp.current, hpMax, 0, hpMax);
  const ceMax = integerInRange(ce.max, previous.resources?.ce?.max ?? 100, 1, 9999);
  const ceCurrent = integerInRange(ce.current, ceMax, 0, ceMax);

  return {
    id: typeof input.id === "string" && input.id ? input.id.slice(0, 80) : (previous.id || "player_001"),
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 80) : (previous.name || "未命名角色"),
    level: integerInRange(input.level, previous.level ?? 1, 1, 999),
    grade: typeof input.grade === "string" && input.grade.trim() ? input.grade.trim().slice(0, 80) : (previous.grade || "Grade 4"),
    profile: {
      age: input.age ?? profile.age ?? previousProfile.age ?? null,
      gender: textOr(input.gender ?? profile.gender, previousProfile.gender || ""),
      affiliation: textOr(input.affiliation ?? profile.affiliation, previousProfile.affiliation || ""),
      era: textOr(input.era ?? profile.era, previousProfile.era || ""),
      appearance: textOr(input.appearance ?? profile.appearance, previousProfile.appearance || ""),
      personality: textOr(input.personality ?? profile.personality, previousProfile.personality || ""),
      goal: textOr(input.goal ?? profile.goal, previousProfile.goal || ""),
      innate_technique: input.innate_technique ?? profile.innate_technique ?? previousProfile.innate_technique ?? null
    },
    attributes: {
      physical: asAttribute(attrs.physical, previous.attributes?.physical?.value ?? 50),
      technique: asAttribute(attrs.technique, previous.attributes?.technique?.value ?? 50),
      mind: asAttribute(attrs.mind, previous.attributes?.mind?.value ?? 50)
    },
    resources: {
      hp: { current: hpCurrent, max: hpMax },
      ce: { current: ceCurrent, max: ceMax }
    },
    combat: {
      defense_dc: integerInRange(combat.defense_dc, previous.combat?.defense_dc ?? 10, 1, 30),
      speed: integerInRange(combat.speed, previous.combat?.speed ?? 50, 0, 100)
    },
    status: Array.isArray(input.status) ? input.status : (Array.isArray(previous.status) ? previous.status : []),
    inventory: Array.isArray(input.inventory) ? input.inventory : (Array.isArray(previous.inventory) ? previous.inventory : []),
    ability_ids: (() => {
      const supplied = Array.isArray(input.ability_ids)
        ? input.ability_ids.filter((abilityId) => typeof abilityId === "string" && abilityId.trim())
        : [];
      const preserved = Array.isArray(previous.ability_ids)
        ? previous.ability_ids.filter((abilityId) => typeof abilityId === "string" && abilityId.trim())
        : [];
      const source = supplied.length ? supplied : preserved;
      return [...new Set(["basic_attack", ...source])];
    })()
  };
}

export function applyPlayerSetup(state, input = {}) {
  state.player = normalizePlayerSetup(input, state.player);
  return state.player;
}

function normalizeEngineMeta(input = {}) {
  const meta = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const revisionRaw = Number(meta.mechanics_revision);
  const mechanicsRevision = Number.isFinite(revisionRaw)
    ? Math.max(0, Math.trunc(revisionRaw))
    : 0;

  return {
    mechanics_revision: mechanicsRevision,
    last_check: meta.last_check && typeof meta.last_check === "object" && !Array.isArray(meta.last_check)
      ? meta.last_check
      : null,
    last_combat_action: meta.last_combat_action && typeof meta.last_combat_action === "object" && !Array.isArray(meta.last_combat_action)
      ? meta.last_combat_action
      : null
  };
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
    player: normalizePlayerSetup({
      ...oldPlayer,
      profile: oldPlayer.profile || {},
      attributes: {
        physical: oldAttributes.physical ?? oldPlayer.physical ?? 50,
        technique: oldAttributes.technique ?? oldPlayer.technique ?? 50,
        mind: oldAttributes.mind ?? oldPlayer.mind ?? 50
      },
      resources: {
        hp: oldResources.hp ?? { current: oldPlayer.hp ?? oldPlayer.max_hp ?? 100, max: oldPlayer.max_hp ?? 100 },
        ce: oldResources.ce ?? { current: oldPlayer.ce ?? oldPlayer.max_ce ?? 100, max: oldPlayer.max_ce ?? 100 }
      },
      combat: oldPlayer.combat || {
        defense_dc: oldPlayer.combat?.defense_dc || oldPlayer.combat?.defense || 10,
        speed: oldPlayer.combat?.speed || 50
      }
    }),
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
    rolling_summary: typeof seed.rolling_summary === "string" ? seed.rolling_summary : "",
    engine_meta: normalizeEngineMeta(seed.engine_meta)
  };

  return state;
}

export function normalizeRecord(raw, campaignId) {
  const seed = raw?.state && typeof raw.state === "object" ? raw.state : (raw || {});
  const state = createDefaultState(seed);
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

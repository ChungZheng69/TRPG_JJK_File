import "dotenv/config";
import express from "express";
import {
  applyPlayerSetup,
  createDefaultState,
  loadCampaign,
  readRawCampaign,
  saveState,
  storageHealth,
  validId,
  writeCampaign
} from "./src/storage.js";
import {
  applyResourceOperation,
  createAbility,
  createEnemy,
  markMechanicalMutation,
  rerollLastCheck,
  rerollLastCombatAction,
  resolveTrackedCombatAction,
  runTrackedCheck,
  startCombat
} from "./src/engine.js";
import { RULES } from "./src/rules.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TRPG_API_KEY;

app.use(express.json({ limit: "256kb" }));

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: "Server is missing TRPG_API_KEY." });
  const authorization = req.get("authorization") || "";
  if (authorization !== `Bearer ${API_KEY}`) return res.status(401).json({ error: "Unauthorized." });
  next();
}

function sendEngineError(res, error) {
  if (error?.message === "DATABASE_NOT_CONFIGURED" || error?.code === "DATABASE_NOT_CONFIGURED") {
    return res.status(503).json({
      error: "DATABASE_NOT_CONFIGURED",
      message: "Persistent database storage is not configured. Set DATABASE_URL in Render."
    });
  }

  const known = new Set([
    "ACTOR_NOT_FOUND", "TARGET_NOT_FOUND", "OWNER_NOT_FOUND", "ACTOR_OR_TARGET_NOT_FOUND",
    "INVALID_ATTRIBUTE", "INVALID_AMOUNT", "INVALID_OPERATION", "RESOURCE_NOT_FOUND",
    "INVALID_ABILITY_TYPE", "NO_ENEMIES", "COMBAT_NOT_ACTIVE", "NOT_ACTORS_TURN",
    "ACTOR_DEFEATED", "TARGET_DEFEATED", "ABILITY_NOT_FOUND", "ABILITY_NOT_OWNED", "NOT_ENOUGH_CE",
    "PLAYER_SETUP_REQUIRED", "PLAYER_SETUP_DURING_COMBAT", "INVALID_ABILITY_DAMAGE_RANGE", "INVALID_ABILITY_CE_COST",
    "NO_CHECK_TO_REROLL", "REROLL_CHECK_MISMATCH", "NO_COMBAT_ACTION_TO_REROLL",
    "REROLL_COMBAT_ACTION_MISMATCH", "REROLL_SNAPSHOT_INVALID"
  ]);
  if (error.message === "REROLL_STALE_COMBAT_ACTION") {
    return res.status(409).json({
      error: error.message,
      message: "The last combat action is no longer the latest mechanical state and cannot be safely overwritten."
    });
  }
  if (known.has(error.message)) return res.status(400).json({ error: error.message });
  console.error(error);
  return res.status(500).json({ error: "Internal engine error." });
}

function validateFlatCharacter(body = {}) {
  const missing = [];
  for (const key of ["name", "physical", "technique", "mind", "hp_max", "ce_max"]) {
    if (body[key] === undefined || body[key] === null || body[key] === "") missing.push(key);
  }
  if (missing.length) {
    return {
      ok: false,
      error: "CHARACTER_SETUP_REQUIRED",
      message: `Missing required character fields: ${missing.join(", ")}`
    };
  }

  for (const key of ["physical", "technique", "mind"]) {
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { ok: false, error: "INVALID_ATTRIBUTE", message: `${key} must be between 0 and 100.` };
    }
  }

  for (const key of ["hp_max", "ce_max"]) {
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 1) {
      return { ok: false, error: "INVALID_RESOURCE_MAX", message: `${key} must be at least 1.` };
    }
  }

  return { ok: true };
}

function buildPlayerFromFlatBody(body = {}) {
  const hpMax = Math.max(1, Math.trunc(Number(body.hp_max)));
  const ceMax = Math.max(1, Math.trunc(Number(body.ce_max)));
  const hpCurrent = body.hp_current === undefined
    ? hpMax
    : Math.min(hpMax, Math.max(0, Math.trunc(Number(body.hp_current))));
  const ceCurrent = body.ce_current === undefined
    ? ceMax
    : Math.min(ceMax, Math.max(0, Math.trunc(Number(body.ce_current))));

  const techniqueConcept = (body.innate_technique_name || body.innate_technique_description)
    ? {
        name: body.innate_technique_name || "",
        description: body.innate_technique_description || ""
      }
    : undefined;

  return {
    id: body.player_id || "player_001",
    name: body.name,
    age: body.age,
    gender: body.gender || "",
    affiliation: body.affiliation || "",
    grade: body.grade || "Grade 4",
    era: body.era || "",
    appearance: body.appearance || "",
    personality: body.personality || "",
    goal: body.goal || "",
    level: body.level || 1,
    innate_technique: techniqueConcept,
    attributes: {
      physical: Math.trunc(Number(body.physical)),
      technique: Math.trunc(Number(body.technique)),
      mind: Math.trunc(Number(body.mind))
    },
    resources: {
      hp: { current: hpCurrent, max: hpMax },
      ce: { current: ceCurrent, max: ceMax }
    },
    combat: {
      defense_dc: body.defense_dc === undefined ? 10 : Math.trunc(Number(body.defense_dc)),
      speed: body.speed === undefined ? 50 : Math.trunc(Number(body.speed))
    },
    status: [],
    inventory: []
  };
}

function buildSceneFromFlatBody(body = {}) {
  if (!body.start_date_time && !body.start_location && !body.start_situation) return null;
  return {
    date_time: body.start_date_time || "",
    location: body.start_location || "",
    situation: body.start_situation || "",
    present_npcs: []
  };
}

function publicState(state) {
  const copy = JSON.parse(JSON.stringify(state));

  if (copy.engine_meta?.last_combat_action) {
    delete copy.engine_meta.last_combat_action.before_snapshot;
  }

  return copy;
}

function publicOutput(output) {
  if (!output || typeof output !== "object" || Array.isArray(output)) return output;
  const safe = { ...output };
  if (safe.state) safe.state = publicState(safe.state);
  return safe;
}

async function withCampaign(req, res, fn) {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });

  try {
    const record = await loadCampaign(campaignId);
    if (!record) return res.status(404).json({ error: "Campaign not found.", campaign_id: campaignId });

    const output = await fn(record.state, record);
    record.updated_at = new Date().toISOString();
    await writeCampaign(campaignId, record);
    return res.json({
      success: true,
      campaign_id: campaignId,
      updated_at: record.updated_at,
      ...publicOutput(output)
    });
  } catch (error) {
    return sendEngineError(res, error);
  }
}

app.get("/health", async (_req, res) => {
  const storage = await storageHealth();
  const status = storage.ok ? 200 : 503;
  return res.status(status).json({
    ok: storage.ok,
    engine_version: "2.6.0",
    schema_version: RULES.schema_version,
    storage
  });
});

app.get("/campaigns/:campaignId", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found.", campaign_id: campaignId });
    return res.json({ ...campaign, state: publicState(campaign.state) });
  } catch (error) {
    return sendEngineError(res, error);
  }
});


// Custom-GPT-safe character creation route.
// Uses only flat JSON fields so the Action tool can always expose every character field.
app.post("/campaigns/:campaignId/character/create", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });

  const validation = validateFlatCharacter(req.body || {});
  if (!validation.ok) return res.status(400).json(validation);

  try {
    const existing = await readRawCampaign(campaignId);
    if (existing && req.body?.overwrite !== true) {
      return res.status(409).json({
        error: "CAMPAIGN_ALREADY_EXISTS",
        message: "Campaign already exists. Use updatePlayerCharacter to repair the player, or explicitly set overwrite=true for a full reset."
      });
    }

    const seed = {
      player: buildPlayerFromFlatBody(req.body || {})
    };
    const scene = buildSceneFromFlatBody(req.body || {});
    if (scene) seed.scene = scene;

    const state = createDefaultState(seed);
    const saved = await saveState(campaignId, state);
    return res.status(201).json({
      success: true,
      campaign_id: campaignId,
      created: true,
      state: publicState(saved.state),
      updated_at: saved.updated_at
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to create character campaign." });
  }
});

// Custom-GPT-safe player repair/respec route for an existing campaign.
// Also uses flat JSON fields. It is blocked during active combat.
app.patch("/campaigns/:campaignId/character", requireApiKey, async (req, res) => {
  const validation = validateFlatCharacter(req.body || {});
  if (!validation.ok) return res.status(400).json(validation);

  return withCampaign(req, res, async (state) => {
    if (state.combat_state?.active) throw new Error("PLAYER_SETUP_DURING_COMBAT");

    if (req.body?.reset_abilities === true && state.player) {
      state.player.ability_ids = ["basic_attack"];
    }

    const player = applyPlayerSetup(state, buildPlayerFromFlatBody(req.body || {}));
    markMechanicalMutation(state);
    const scene = buildSceneFromFlatBody(req.body || {});
    if (scene) {
      state.scene = {
        ...(state.scene || {}),
        ...scene
      };
    }

    return { player, state };
  });
});

app.post("/campaigns/:campaignId/initialize", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  try {
    const existing = await readRawCampaign(campaignId);
    if (existing && req.body?.overwrite !== true) {
      return res.status(409).json({ error: "Campaign already exists. Use configurePlayerCharacter to repair/setup the player, or set overwrite=true only for an intentional full reset." });
    }
    if (!req.body?.player || typeof req.body.player !== "object" || Array.isArray(req.body.player)) {
      return res.status(400).json({ error: "PLAYER_SETUP_REQUIRED", message: "New campaigns must include a complete player object. The engine will not silently create the old test character template." });
    }

    const seed = (req.body?.state && typeof req.body.state === "object" && !Array.isArray(req.body.state))
      ? { ...req.body.state }
      : {};
    seed.player = req.body.player;
    if (req.body?.scene && typeof req.body.scene === "object" && !Array.isArray(req.body.scene)) seed.scene = req.body.scene;

    const state = createDefaultState(seed);
    const saved = await saveState(campaignId, state);
    return res.status(201).json(saved);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to initialize campaign." });
  }
});

app.patch("/campaigns/:campaignId/player/setup", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => {
    if (state.combat_state?.active) throw new Error("PLAYER_SETUP_DURING_COMBAT");
    const playerInput = req.body?.player;
    if (!playerInput || typeof playerInput !== "object" || Array.isArray(playerInput)) {
      return Promise.reject(new Error("PLAYER_SETUP_REQUIRED"));
    }
    if (req.body?.reset_abilities === true && state.player) {
      state.player.ability_ids = ["basic_attack"];
    }
    const player = applyPlayerSetup(state, playerInput);
    markMechanicalMutation(state);
    return { player, state };
  });
});

app.patch("/campaigns/:campaignId/narrative", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => {
    const allowed = [
      "scene", "quests", "relationships", "campaign_flags", "canon_changes",
      "important_facts", "recent_events", "rolling_summary"
    ];
    const changed = [];
    for (const key of allowed) {
      if (Object.hasOwn(req.body || {}, key)) {
        state[key] = req.body[key];
        changed.push(key);
      }
    }
    return { changed_fields: changed, state };
  });
});

app.post("/campaigns/:campaignId/check", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({
    check: runTrackedCheck(state, req.body || {}),
    state
  }));
});

app.post("/campaigns/:campaignId/check/reroll", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({
    check: rerollLastCheck(state, req.body || {}),
    state
  }));
});

app.post("/campaigns/:campaignId/resources/change", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => {
    const change = applyResourceOperation(state, req.body || {});
    markMechanicalMutation(state);
    return { change, state };
  });
});

app.post("/campaigns/:campaignId/enemies", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => {
    const enemy = createEnemy(state, req.body || {});
    markMechanicalMutation(state);
    return { enemy, state };
  });
});

app.post("/campaigns/:campaignId/abilities", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => {
    const ability = createAbility(state, req.body || {});
    markMechanicalMutation(state);
    return { ability, state };
  });
});

app.post("/campaigns/:campaignId/combat/start", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => {
    const combat_state = startCombat(state, req.body || {});
    markMechanicalMutation(state);
    return { combat_state, state };
  });
});

app.post("/campaigns/:campaignId/combat/action", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({
    result: resolveTrackedCombatAction(state, req.body || {}),
    state
  }));
});

app.post("/campaigns/:campaignId/combat/action/reroll", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({
    result: rerollLastCombatAction(state, req.body || {}),
    state
  }));
});

// Legacy v1 full-save route kept for manual compatibility only.
// It is intentionally NOT exposed in openapi.yaml, so the new Custom GPT should not use it.
app.put("/campaigns/:campaignId", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  const { state } = req.body ?? {};
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return res.status(400).json({ error: 'Request body must contain an object named "state".' });
  }
  try {
    const saved = await saveState(campaignId, state);
    return res.json({ success: true, campaign_id: campaignId, updated_at: saved.updated_at, warning: "Legacy full-save route used." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to save campaign." });
  }
});

app.use((_req, res) => res.status(404).json({ error: "Route not found." }));
app.listen(PORT, () => console.log(`JJK TRPG Engine v2.6 listening on port ${PORT}`));

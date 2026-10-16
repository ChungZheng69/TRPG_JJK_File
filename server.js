import "dotenv/config";
import express from "express";
import { pathToFileURL } from "node:url";
import * as defaultStorage from "./src/storage.js";
import { campaignContext, campaignHistory, campaignSection, HISTORY_SECTIONS, mutationResponse } from "./src/api-responses.js";
import { ACTION_OPERATIONS, requestLogging } from "./src/request-logging.js";
import {
  applyCharacterGrowth,
  applyResourceOperation,
  createAbility,
  createEnemy,
  evolveAbility,
  recordGrowthEvidence,
  rerollLastCheck,
  runTrackedCheck,
  updateEntityState
} from "./src/engine.js";
import { RULES } from "./src/rules.js";

export function createApp({ storage = defaultStorage, apiKey = process.env.TRPG_API_KEY, logger = console.log } = {}) {
  const { applyPlayerSetup, createDefaultState, loadCampaign, readRawCampaign, saveState, storageHealth, validId, writeCampaign } = storage;
  const app = express();
  const API_KEY = apiKey;

  app.use(requestLogging({ logger, operations: ACTION_OPERATIONS }));
  // Recovery accepts larger saves; normal Action request limits stay unchanged.
  app.put("/campaigns/:campaignId", requireApiKey, express.json({ limit: "10mb" }));
  app.use(express.json({ limit: "256kb" }));

  function requireApiKey(req, res, next) {
    if (!API_KEY) return res.status(500).json({ error: "Server is missing TRPG_API_KEY." });
    const authorization = req.get("authorization") || "";
    if (authorization !== `Bearer ${API_KEY}`) {
      return res.status(401).json({ error: "Unauthorized." });
    }
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
      "ACTOR_NOT_FOUND",
      "TARGET_NOT_FOUND",
      "OWNER_NOT_FOUND",
      "INVALID_ATTRIBUTE",
      "INVALID_AMOUNT",
      "INVALID_OPERATION",
      "RESOURCE_NOT_FOUND",
      "INVALID_ABILITY_TYPE",
      "ABILITY_NOT_FOUND",
      "INVALID_ABILITY_DAMAGE_RANGE",
      "INVALID_ABILITY_CE_COST",
      "NO_CHECK_TO_REROLL",
      "REROLL_CHECK_MISMATCH",
      "PLAYER_SETUP_REQUIRED",
      "INVALID_GROWTH_CATEGORY",
      "INVALID_GROWTH_SIGNIFICANCE",
      "GROWTH_NOTE_REQUIRED",
      "GROWTH_EVIDENCE_REQUIRED",
      "GROWTH_EVIDENCE_NOT_FOUND",
      "GROWTH_EVIDENCE_ALREADY_USED",
      "INVALID_GROWTH_DELTA",
      "GROWTH_ATTRIBUTE_TOTAL_TOO_HIGH",
      "GROWTH_REASON_REQUIRED",
      "INVALID_GROWTH_SCALE",
      "NO_GROWTH_CHANGE",
      "BUILTIN_ABILITY_NOT_EVOLVABLE",
      "NO_ABILITY_EVOLUTION_CHANGE"
    ]);

    if (known.has(error.message)) {
      return res.status(400).json({
        error: error.message,
        field: error.field || undefined
      });
    }

    logger(JSON.stringify({ event: "engine_error", error: "INTERNAL_ENGINE_ERROR" }));
    return res.status(500).json({ error: "Internal engine error." });
  }

  function validateFlatCharacter(body = {}) {
    const missing = [];
    for (const key of ["name", "physical", "technique", "mind", "hp_max", "ce_max"]) {
      if (body[key] === undefined || body[key] === null || body[key] === "") {
        missing.push(key);
      }
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
        return {
          ok: false,
          error: "INVALID_ATTRIBUTE",
          message: `${key} must be between 0 and 100.`
        };
      }
    }

    for (const key of ["hp_max", "ce_max"]) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 1) {
        return {
          ok: false,
          error: "INVALID_RESOURCE_MAX",
          message: `${key} must be at least 1.`
        };
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

  async function withCampaign(req, res, fn) {
    const { campaignId } = req.params;
    if (!validId(campaignId)) {
      return res.status(400).json({ error: "Invalid campaignId." });
    }

    try {
      const record = await loadCampaign(campaignId);
      if (!record) {
        return res.status(404).json({
          error: "Campaign not found.",
          campaign_id: campaignId
        });
      }

      const output = await fn(record.state, record);
      record.updated_at = new Date().toISOString();
      await writeCampaign(campaignId, record);

      return res.json(mutationResponse(campaignId, record.updated_at, output, record.state));
    } catch (error) {
      return sendEngineError(res, error);
    }
  }

  app.get("/health", async (_req, res) => {
    const storage = await storageHealth();
    const status = storage.ok ? 200 : 503;

    return res.status(status).json({
      ok: storage.ok,
      engine_version: "3.0.0",
      schema_version: RULES.schema_version,
      combat_model: "narrative_dice_resolution",
      storage
    });
  });

  app.get("/campaigns/:campaignId", requireApiKey, async (req, res) => {
    const { campaignId } = req.params;
    if (!validId(campaignId)) {
      return res.status(400).json({ error: "Invalid campaignId." });
    }

    try {
      const campaign = await loadCampaign(campaignId);
      if (!campaign) {
        return res.status(404).json({
          error: "Campaign not found.",
          campaign_id: campaignId
        });
      }
      return res.json(campaignContext(campaign));
    } catch (error) {
      return sendEngineError(res, error);
    }
  });

  async function sendSavedSection(req, res) {
    const { campaignId } = req.params;
    const isHistory = req.route.path === "/campaigns/:campaignId/history";
    const collection = req.query.collection ?? "recent_events";
    if (isHistory && (typeof collection !== "string" || !Object.hasOwn(HISTORY_SECTIONS, collection))) {
      return res.status(400).json({ error: "INVALID_HISTORY_COLLECTION" });
    }
    const pointer = isHistory ? HISTORY_SECTIONS[collection] : req.query.pointer ?? "/state";
    const offsetText = req.query.offset ?? "0";
    const limitText = req.query.limit ?? "10";
    if (!validId(campaignId) || typeof pointer !== "string" || pointer.length > 512 ||
        typeof offsetText !== "string" || !/^\d{1,16}$/.test(offsetText) ||
        (isHistory && (typeof limitText !== "string" || !/^\d{1,2}$/.test(limitText))) ||
        (Number(offsetText) > 0 && !req.query.expected_updated_at) ||
        (req.query.expected_updated_at !== undefined && typeof req.query.expected_updated_at !== "string")) {
      return res.status(400).json({ error: "INVALID_SECTION_REQUEST" });
    }
    try {
      const record = await readRawCampaign(campaignId);
      if (!record) return res.status(404).json({ error: "Campaign not found." });
      if (req.query.expected_updated_at && req.query.expected_updated_at !== record.updated_at) {
        return res.status(409).json({ error: "CAMPAIGN_CHANGED", message: "Restart section retrieval at offset 0." });
      }
      const section = isHistory ? campaignHistory(record, collection, Number(offsetText), Number(limitText)) :
        campaignSection(record, pointer, Number(offsetText));
      if (!section) return res.status(404).json({ error: "SECTION_NOT_FOUND" });
      return res.json(section);
    } catch (error) {
      if (["INVALID_OFFSET", "INVALID_LIMIT", "HISTORY_NOT_A_COLLECTION"].includes(error.message)) return res.status(400).json({ error: error.message });
      return sendEngineError(res, error);
    }
  }

  app.get("/campaigns/:campaignId/sections", requireApiKey, sendSavedSection);
  // A separate, authenticated route for archived narrative/growth information.
  app.get("/campaigns/:campaignId/history", requireApiKey, sendSavedSection);

  // Full raw save for authenticated manual backup/recovery, excluded from Actions.
  app.get("/campaigns/:campaignId/export", requireApiKey, async (req, res) => {
    if (!validId(req.params.campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
    try {
      const record = await readRawCampaign(req.params.campaignId);
      if (!record) return res.status(404).json({ error: "Campaign not found." });
      return res.json(record);
    } catch (error) {
      return sendEngineError(res, error);
    }
  });

  app.post("/campaigns/:campaignId/character/create", requireApiKey, async (req, res) => {
    const { campaignId } = req.params;
    if (!validId(campaignId)) {
      return res.status(400).json({ error: "Invalid campaignId." });
    }

    const validation = validateFlatCharacter(req.body || {});
    if (!validation.ok) return res.status(400).json(validation);

    try {
      const existing = await readRawCampaign(campaignId);
      if (existing && req.body?.overwrite !== true) {
        return res.status(409).json({
          error: "CAMPAIGN_ALREADY_EXISTS",
          message: "Campaign already exists. Use updatePlayerCharacter or explicitly request a full reset."
        });
      }

      const seed = { player: buildPlayerFromFlatBody(req.body || {}) };
      const scene = buildSceneFromFlatBody(req.body || {});
      if (scene) seed.scene = scene;

      const saved = await saveState(campaignId, createDefaultState(seed));

      return res.status(201).json(mutationResponse(campaignId, saved.updated_at, { created: true, player: saved.state.player }));
    } catch (error) {
      return sendEngineError(res, error);
    }
  });

  app.patch("/campaigns/:campaignId/character", requireApiKey, async (req, res) => {
    const validation = validateFlatCharacter(req.body || {});
    if (!validation.ok) return res.status(400).json(validation);

    return withCampaign(req, res, async (state) => {
      if (req.body?.reset_abilities === true && state.player) {
        state.player.ability_ids = ["basic_attack"];
      }

      const player = applyPlayerSetup(state, buildPlayerFromFlatBody(req.body || {}));
      const scene = buildSceneFromFlatBody(req.body || {});

      if (scene) state.scene = { ...(state.scene || {}), ...scene };
      return { player, ...(scene ? { scene: state.scene } : {}) };
    });
  });

  app.patch("/campaigns/:campaignId/narrative", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => {
      const allowed = [
        "scene",
        "quests",
        "relationships",
        "campaign_flags",
        "canon_changes",
        "important_facts",
        "recent_events",
        "rolling_summary"
      ];

      const changed = [];
      for (const key of allowed) {
        if (Object.hasOwn(req.body || {}, key)) {
          state[key] = req.body[key];
          changed.push(key);
        }
      }

      return { changed_fields: changed };
    });
  });

  app.post("/campaigns/:campaignId/check", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      check: runTrackedCheck(state, req.body || {})
    }));
  });

  app.post("/campaigns/:campaignId/check/reroll", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      check: rerollLastCheck(state, req.body || {})
    }));
  });

  app.post("/campaigns/:campaignId/resources/change", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      change: applyResourceOperation(state, req.body || {})
    }));
  });

  app.post("/campaigns/:campaignId/enemies", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      enemy: createEnemy(state, req.body || {})
    }));
  });

  app.post("/campaigns/:campaignId/abilities", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      ability: createAbility(state, req.body || {})
    }));
  });

  app.patch("/campaigns/:campaignId/entities/state", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      entity_state: updateEntityState(state, req.body || {})
    }));
  });

  app.post("/campaigns/:campaignId/growth/evidence", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      evidence: recordGrowthEvidence(state, req.body || {})
    }));
  });

  app.post("/campaigns/:campaignId/growth/apply", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      growth: applyCharacterGrowth(state, req.body || {})
    }));
  });

  app.patch("/campaigns/:campaignId/abilities/evolve", requireApiKey, async (req, res) => {
    return withCampaign(req, res, async (state) => ({
      evolution: evolveAbility(state, req.body || {})
    }));
  });

  // V2 turn-based combat routes are deliberately retired.
  for (const retiredPath of [
    "/campaigns/:campaignId/combat/start",
    "/campaigns/:campaignId/combat/action",
    "/campaigns/:campaignId/combat/action/reroll"
  ]) {
    app.all(retiredPath, requireApiKey, (_req, res) => {
      return res.status(410).json({
        error: "TURN_BASED_COMBAT_RETIRED",
        message: "V3 uses narrative combat. Use runAttributeCheck plus applyResourceChange instead."
      });
    });
  }

  // Legacy full-save route kept for manual recovery only and not exposed to Custom GPT.
  app.put("/campaigns/:campaignId", requireApiKey, async (req, res) => {
    const { campaignId } = req.params;
    const { state } = req.body ?? {};

    if (!validId(campaignId)) {
      return res.status(400).json({ error: "Invalid campaignId." });
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return res.status(400).json({
        error: 'Request body must contain an object named "state".'
      });
    }

    try {
      const saved = await saveState(campaignId, state);
      return res.json({
        success: true,
        campaign_id: campaignId,
        updated_at: saved.updated_at,
        warning: "Legacy full-save route used."
      });
    } catch (error) {
      return sendEngineError(res, error);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "Route not found." }));

  app.use((error, _req, res, _next) => {
    if (error.type === "entity.too.large") return res.status(413).json({ error: "REQUEST_TOO_LARGE" });
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "INVALID_JSON" });
    return sendEngineError(res, error);
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.env.PORT || 3000);
  createApp().listen(PORT, () => {
    console.log(`JJK TRPG Engine V3 narrative combat listening on port ${PORT}`);
  });
}

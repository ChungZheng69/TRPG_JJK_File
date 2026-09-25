import "dotenv/config";
import express from "express";
import {
  createDefaultState,
  loadCampaign,
  readRawCampaign,
  saveState,
  validId,
  writeCampaign
} from "./src/storage.js";
import {
  applyResourceOperation,
  createAbility,
  createEnemy,
  resolveCombatAction,
  runCheck,
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
  const known = new Set([
    "ACTOR_NOT_FOUND", "TARGET_NOT_FOUND", "OWNER_NOT_FOUND", "ACTOR_OR_TARGET_NOT_FOUND",
    "INVALID_ATTRIBUTE", "INVALID_AMOUNT", "INVALID_OPERATION", "RESOURCE_NOT_FOUND",
    "INVALID_ABILITY_TYPE", "NO_ENEMIES", "COMBAT_NOT_ACTIVE", "NOT_ACTORS_TURN",
    "ACTOR_DEFEATED", "TARGET_DEFEATED", "ABILITY_NOT_FOUND", "ABILITY_NOT_OWNED", "NOT_ENOUGH_CE"
  ]);
  if (known.has(error.message)) return res.status(400).json({ error: error.message });
  console.error(error);
  return res.status(500).json({ error: "Internal engine error." });
}

async function withCampaign(req, res, fn) {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  const record = await loadCampaign(campaignId);
  if (!record) return res.status(404).json({ error: "Campaign not found.", campaign_id: campaignId });
  try {
    const output = await fn(record.state, record);
    record.updated_at = new Date().toISOString();
    await writeCampaign(campaignId, record);
    return res.json({ success: true, campaign_id: campaignId, updated_at: record.updated_at, ...output });
  } catch (error) {
    return sendEngineError(res, error);
  }
}

app.get("/health", (_req, res) => res.json({ ok: true, engine_version: "2.0.0", schema_version: RULES.schema_version }));

app.get("/campaigns/:campaignId", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  try {
    const campaign = await loadCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found.", campaign_id: campaignId });
    return res.json(campaign);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to load campaign." });
  }
});

app.post("/campaigns/:campaignId/initialize", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  try {
    const existing = await readRawCampaign(campaignId);
    if (existing && req.body?.overwrite !== true) {
      return res.status(409).json({ error: "Campaign already exists. Set overwrite=true only if you intentionally want to reset it." });
    }
    const state = createDefaultState(req.body?.state || {});
    const saved = await saveState(campaignId, state);
    return res.status(201).json(saved);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Failed to initialize campaign." });
  }
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
  return withCampaign(req, res, async (state) => ({ check: runCheck(state, req.body || {}) }));
});

app.post("/campaigns/:campaignId/resources/change", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({ change: applyResourceOperation(state, req.body || {}), state }));
});

app.post("/campaigns/:campaignId/enemies", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({ enemy: createEnemy(state, req.body || {}), state }));
});

app.post("/campaigns/:campaignId/abilities", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({ ability: createAbility(state, req.body || {}), state }));
});

app.post("/campaigns/:campaignId/combat/start", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({ combat_state: startCombat(state, req.body || {}), state }));
});

app.post("/campaigns/:campaignId/combat/action", requireApiKey, async (req, res) => {
  return withCampaign(req, res, async (state) => ({ result: resolveCombatAction(state, req.body || {}), state }));
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
app.listen(PORT, () => console.log(`JJK TRPG Engine v2 listening on port ${PORT}`));

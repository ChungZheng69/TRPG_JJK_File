import "dotenv/config";
import express from "express";
import {
  applyPlayerSetup,
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
    "ACTOR_DEFEATED", "TARGET_DEFEATED", "ABILITY_NOT_FOUND", "ABILITY_NOT_OWNED", "NOT_ENOUGH_CE",
    "PLAYER_SETUP_REQUIRED", "PLAYER_SETUP_DURING_COMBAT"
  ]);
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

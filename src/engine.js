import crypto from "node:crypto";
import {
  ABILITY_COSTS,
  ABILITY_NUMERIC_LIMITS,
  ABILITY_REFERENCE_RANGES,
  BUILTIN_ABILITIES,
  ENEMY_GRADE_PROFILES,
  GROWTH_LIMITS,
  RULES
} from "./rules.js";

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

export function positiveDiceFromStat(stat) {
  return clamp(
    Math.floor(Number(stat || 0) / RULES.stat_per_positive_die),
    0,
    RULES.max_positive_dice
  );
}

export function rollDice(count, sides = 20) {
  return Array.from({ length: count }, () => randomInt(1, sides));
}

export function findActor(state, id) {
  if (state.player?.id === id) return state.player;
  if (state.entities?.enemies?.[id]) return state.entities.enemies[id];
  if (state.entities?.npcs?.[id]) return state.entities.npcs[id];
  return null;
}

function ensureEngineMeta(state) {
  if (!state.engine_meta || typeof state.engine_meta !== "object" || Array.isArray(state.engine_meta)) {
    state.engine_meta = {};
  }
  if (!Object.hasOwn(state.engine_meta, "last_check")) state.engine_meta.last_check = null;
  return state.engine_meta;
}

function ensureGrowthState(state) {
  if (!state.growth || typeof state.growth !== "object" || Array.isArray(state.growth)) {
    state.growth = {};
  }
  if (!Array.isArray(state.growth.ledger)) state.growth.ledger = [];
  if (!Array.isArray(state.growth.history)) state.growth.history = [];
  return state.growth;
}

function attributeValue(actor, attribute) {
  const raw = actor?.attributes?.[attribute];
  if (raw && typeof raw === "object") return Number(raw.value || 0);
  return Number(raw || 0);
}

function classifyCheck(highest, dc, finalDice) {
  if (finalDice <= 0 || highest === null) {
    return {
      success: false,
      margin: null,
      degree: "automatic_failure_no_positive_dice",
      natural_20: false
    };
  }

  const margin = highest - dc;
  const success = highest >= dc;
  const natural20 = highest === 20;

  if (!success) {
    return {
      success: false,
      margin,
      degree: margin <= RULES.check_degrees.severe_failure_margin
        ? "severe_failure"
        : "failure",
      natural_20: natural20
    };
  }

  if (natural20) {
    return {
      success: true,
      margin,
      degree: "exceptional_success",
      natural_20: true
    };
  }

  if (margin >= RULES.check_degrees.overwhelming_success_margin) {
    return { success: true, margin, degree: "overwhelming_success", natural_20: false };
  }

  if (margin >= RULES.check_degrees.strong_success_margin) {
    return { success: true, margin, degree: "strong_success", natural_20: false };
  }

  return { success: true, margin, degree: "success", natural_20: false };
}

export function runCheck(state, {
  actor_id,
  attribute,
  difficulty,
  bonus_dice = 0,
  penalty_dice = 0,
  reason = ""
}) {
  const actor = findActor(state, actor_id);
  if (!actor) throw new Error("ACTOR_NOT_FOUND");
  if (!["physical", "technique", "mind"].includes(attribute)) throw new Error("INVALID_ATTRIBUTE");

  const stat = clamp(attributeValue(actor, attribute), 0, RULES.attribute_max);
  const baseDice = positiveDiceFromStat(stat);
  const finalDice = clamp(
    baseDice + Number(bonus_dice || 0) - Number(penalty_dice || 0),
    0,
    RULES.max_positive_dice
  );
  const dc = clamp(Number(difficulty || RULES.difficulties.normal), 1, 30);
  const rolls = finalDice > 0 ? rollDice(finalDice, RULES.dice_type) : [];
  const highest = rolls.length ? Math.max(...rolls) : null;
  const classification = classifyCheck(highest, dc, finalDice);

  return {
    check_id: makeId("check"),
    actor_id,
    attribute,
    stat,
    base_dice: baseDice,
    bonus_dice: Number(bonus_dice || 0),
    penalty_dice: Number(penalty_dice || 0),
    final_dice: finalDice,
    dice_type: `d${RULES.dice_type}`,
    rolls,
    highest_roll: highest,
    difficulty: dc,
    ...classification,
    result: classification.degree,
    reason: String(reason || "").slice(0, 300)
  };
}

export function runTrackedCheck(state, args = {}) {
  const check = runCheck(state, args);
  const meta = ensureEngineMeta(state);

  meta.last_check = {
    original_check_id: check.check_id,
    current_check_id: check.check_id,
    reroll_count: 0,
    request: {
      actor_id: check.actor_id,
      attribute: check.attribute,
      difficulty: check.difficulty,
      bonus_dice: check.bonus_dice,
      penalty_dice: check.penalty_dice,
      reason: check.reason || ""
    },
    rolled_at: new Date().toISOString()
  };

  return {
    ...check,
    reroll_count: 0,
    original_check_id: check.check_id
  };
}

export function rerollLastCheck(state, { expected_check_id = "" } = {}) {
  const meta = ensureEngineMeta(state);
  const last = meta.last_check;

  if (!last?.request || !last.current_check_id) throw new Error("NO_CHECK_TO_REROLL");
  if (expected_check_id && expected_check_id !== last.current_check_id) {
    throw new Error("REROLL_CHECK_MISMATCH");
  }

  const replacedCheckId = last.current_check_id;
  const rerollCount = Number(last.reroll_count || 0) + 1;
  const check = runCheck(state, last.request);

  meta.last_check = {
    ...last,
    current_check_id: check.check_id,
    reroll_count: rerollCount,
    rolled_at: new Date().toISOString()
  };

  return {
    ...check,
    reroll: true,
    reroll_count: rerollCount,
    original_check_id: last.original_check_id,
    replaces_check_id: replacedCheckId
  };
}

export function applyResourceOperation(state, {
  target_id,
  operation,
  amount,
  reason = ""
}) {
  const target = findActor(state, target_id);
  if (!target) throw new Error("TARGET_NOT_FOUND");

  const n = Math.abs(Number(amount));
  if (!Number.isFinite(n) || n <= 0) throw new Error("INVALID_AMOUNT");

  const mapping = {
    damage: ["hp", -n],
    heal: ["hp", n],
    spend_ce: ["ce", -n],
    restore_ce: ["ce", n]
  };
  if (!mapping[operation]) throw new Error("INVALID_OPERATION");

  const [resourceName, delta] = mapping[operation];
  const resource = target.resources?.[resourceName];
  if (!resource) throw new Error("RESOURCE_NOT_FOUND");

  const before = Number(resource.current);
  const after = clamp(before + delta, 0, Number(resource.max));
  resource.current = after;

  return {
    target_id,
    operation,
    resource: resourceName,
    requested_amount: n,
    applied_change: after - before,
    before,
    after,
    max: Number(resource.max),
    depleted: after <= 0,
    reason: String(reason || "").slice(0, 300)
  };
}

function boundedGrade(grade) {
  return ENEMY_GRADE_PROFILES[grade] ? grade : "Grade 3";
}

export function createEnemy(state, {
  name,
  grade = "Grade 3",
  role = "balanced",
  theme = "",
  persistence = "scene",
  notes = ""
}) {
  const normalizedGrade = boundedGrade(grade);
  const p = ENEMY_GRADE_PROFILES[normalizedGrade];
  const id = makeId("enemy");
  const attr = () => randomInt(p.attribute[0], p.attribute[1]);
  const hp = randomInt(p.hp[0], p.hp[1]);
  const ce = randomInt(p.ce[0], p.ce[1]);

  const enemy = {
    id,
    name: String(name || "未命名敌人").slice(0, 80),
    type: "enemy",
    grade: normalizedGrade,
    role: String(role || "balanced").slice(0, 40),
    theme: String(theme || "").slice(0, 160),
    persistence: ["scene", "campaign"].includes(persistence) ? persistence : "scene",
    attributes: {
      physical: { value: attr(), max: 100 },
      technique: { value: attr(), max: 100 },
      mind: { value: attr(), max: 100 }
    },
    resources: {
      hp: { current: hp, max: hp },
      ce: { current: ce, max: ce }
    },
    combat: {
      defense_dc: randomInt(p.defense_dc[0], p.defense_dc[1]),
      speed: randomInt(p.speed[0], p.speed[1])
    },
    status: [],
    narrative_position: "",
    state_notes: [],
    inventory: [],
    ability_ids: ["basic_attack"],
    notes: String(notes || "").slice(0, 300),
    generated_by: { type: "ai_dynamic", created_at: new Date().toISOString() }
  };

  state.entities.enemies[id] = enemy;
  return enemy;
}

function validateRange(minValue, maxValue) {
  const hasMin = minValue !== undefined && minValue !== null && minValue !== "";
  const hasMax = maxValue !== undefined && maxValue !== null && maxValue !== "";

  if (!hasMin && !hasMax) return null;
  if (!hasMin || !hasMax) throw new Error("INVALID_ABILITY_DAMAGE_RANGE");

  const min = Math.trunc(Number(minValue));
  const max = Math.trunc(Number(maxValue));

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min < ABILITY_NUMERIC_LIMITS.damage_min ||
    max > ABILITY_NUMERIC_LIMITS.damage_max ||
    max < min
  ) {
    throw new Error("INVALID_ABILITY_DAMAGE_RANGE");
  }

  return { mode: "range", min, max };
}

function validateCeCost(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const ce = Math.trunc(Number(value));

  if (
    !Number.isFinite(ce) ||
    ce < ABILITY_NUMERIC_LIMITS.ce_cost_min ||
    ce > ABILITY_NUMERIC_LIMITS.ce_cost_max
  ) {
    throw new Error("INVALID_ABILITY_CE_COST");
  }
  return ce;
}

export function createAbility(state, {
  owner_id,
  name,
  type = "attack",
  attribute = "technique",
  power = "medium",
  cost = "medium",
  damage_min,
  damage_max,
  ce_cost,
  effect_kind = "",
  description = ""
}) {
  const owner = findActor(state, owner_id);
  if (!owner) throw new Error("OWNER_NOT_FOUND");
  if (!["physical", "technique", "mind"].includes(attribute)) throw new Error("INVALID_ATTRIBUTE");
  if (!["attack", "heal", "utility"].includes(type)) throw new Error("INVALID_ABILITY_TYPE");

  const normalizedPower = ABILITY_REFERENCE_RANGES[power] ? power : "medium";
  const normalizedCost = Object.hasOwn(ABILITY_COSTS, cost) ? cost : "medium";
  const exactRange = validateRange(damage_min, damage_max);
  const fallbackRange = ABILITY_REFERENCE_RANGES[normalizedPower];
  const referenceRange = exactRange || { mode: "range", ...fallbackRange };
  const id = makeId("ability");

  const ability = {
    id,
    name: String(name || "未命名术式").slice(0, 80),
    type,
    attribute,
    power: normalizedPower,
    ce_cost: validateCeCost(ce_cost, ABILITY_COSTS[normalizedCost]),
    damage: type === "attack" ? referenceRange : null,
    healing: type === "heal" ? referenceRange : null,
    effect_kind: String(effect_kind || "").slice(0, 80),
    description: String(description || "").slice(0, 500),
    mastery_notes: [],
    evolution_history: [],
    generated_by: {
      type: exactRange ? "ai_numeric_reference" : "ai_tier_reference",
      created_at: new Date().toISOString()
    }
  };

  state.entities.abilities[id] = ability;
  owner.ability_ids = Array.isArray(owner.ability_ids) ? owner.ability_ids : ["basic_attack"];
  if (!owner.ability_ids.includes(id)) owner.ability_ids.push(id);

  return ability;
}

export function updateEntityState(state, {
  target_id,
  add_status = "",
  remove_status = "",
  position = "",
  note = ""
}) {
  const target = findActor(state, target_id);
  if (!target) throw new Error("TARGET_NOT_FOUND");

  target.status = Array.isArray(target.status) ? target.status : [];
  const statusStrings = target.status
    .map((item) => typeof item === "string" ? item : item?.name)
    .filter(Boolean);

  const add = String(add_status || "").trim().slice(0, 80);
  const remove = String(remove_status || "").trim().slice(0, 80);

  let nextStatus = [...new Set(statusStrings)];
  if (remove) nextStatus = nextStatus.filter((value) => value !== remove);
  if (add && !nextStatus.includes(add)) nextStatus.push(add);
  target.status = nextStatus;

  if (position !== undefined && position !== null && String(position).trim()) {
    target.narrative_position = String(position).trim().slice(0, 200);
  }

  if (note !== undefined && note !== null && String(note).trim()) {
    target.state_notes = Array.isArray(target.state_notes) ? target.state_notes : [];
    target.state_notes.push({
      note: String(note).trim().slice(0, 300),
      recorded_at: new Date().toISOString()
    });
    target.state_notes = target.state_notes.slice(-20);
  }

  return {
    target_id,
    status: target.status,
    narrative_position: target.narrative_position || "",
    latest_note: target.state_notes?.at(-1) || null
  };
}

function growthEvidenceMap(state) {
  const growth = ensureGrowthState(state);
  return new Map(growth.ledger.map((item) => [item.evidence_id, item]));
}

function requireUnusedEvidence(state, evidenceIds) {
  if (!Array.isArray(evidenceIds) || evidenceIds.length === 0) {
    throw new Error("GROWTH_EVIDENCE_REQUIRED");
  }

  const map = growthEvidenceMap(state);
  const evidence = [];

  for (const id of [...new Set(evidenceIds)]) {
    const item = map.get(id);
    if (!item) throw new Error("GROWTH_EVIDENCE_NOT_FOUND");
    if (item.consumed_by) throw new Error("GROWTH_EVIDENCE_ALREADY_USED");
    evidence.push(item);
  }

  return evidence;
}

export function recordGrowthEvidence(state, {
  category,
  significance = "meaningful",
  note,
  related_ability_id = ""
}) {
  const allowedCategories = new Set([
    "physical", "technique", "mind", "hp", "ce", "ability", "grade", "general"
  ]);
  const allowedSignificance = new Set(["minor", "meaningful", "major"]);

  if (!allowedCategories.has(category)) throw new Error("INVALID_GROWTH_CATEGORY");
  if (!allowedSignificance.has(significance)) throw new Error("INVALID_GROWTH_SIGNIFICANCE");
  if (!String(note || "").trim()) throw new Error("GROWTH_NOTE_REQUIRED");

  if (related_ability_id && !state.entities?.abilities?.[related_ability_id]) {
    throw new Error("ABILITY_NOT_FOUND");
  }

  const growth = ensureGrowthState(state);
  const evidence = {
    evidence_id: makeId("growth_evidence"),
    category,
    significance,
    note: String(note).trim().slice(0, 500),
    related_ability_id: related_ability_id || null,
    consumed_by: null,
    recorded_at: new Date().toISOString()
  };

  growth.ledger.push(evidence);
  growth.ledger = growth.ledger.slice(-GROWTH_LIMITS.ledger_max_entries);
  return evidence;
}

function integerDelta(value, max, field) {
  const n = value === undefined || value === null || value === ""
    ? 0
    : Math.trunc(Number(value));

  if (!Number.isFinite(n) || n < 0 || n > max) {
    const error = new Error("INVALID_GROWTH_DELTA");
    error.field = field;
    throw error;
  }

  return n;
}

export function applyCharacterGrowth(state, {
  reason,
  evidence_ids,
  growth_scale = "minor",
  physical_delta = 0,
  technique_delta = 0,
  mind_delta = 0,
  hp_max_delta = 0,
  ce_max_delta = 0,
  new_grade = ""
}) {
  if (!String(reason || "").trim()) throw new Error("GROWTH_REASON_REQUIRED");
  if (!["minor", "significant", "breakthrough"].includes(growth_scale)) {
    throw new Error("INVALID_GROWTH_SCALE");
  }

  const evidence = requireUnusedEvidence(state, evidence_ids);
  const physical = integerDelta(
    physical_delta,
    GROWTH_LIMITS.attribute_delta_per_stat,
    "physical_delta"
  );
  const technique = integerDelta(
    technique_delta,
    GROWTH_LIMITS.attribute_delta_per_stat,
    "technique_delta"
  );
  const mind = integerDelta(
    mind_delta,
    GROWTH_LIMITS.attribute_delta_per_stat,
    "mind_delta"
  );
  const hp = integerDelta(hp_max_delta, GROWTH_LIMITS.hp_max_delta, "hp_max_delta");
  const ce = integerDelta(ce_max_delta, GROWTH_LIMITS.ce_max_delta, "ce_max_delta");

  if (physical + technique + mind > GROWTH_LIMITS.attribute_delta_total) {
    throw new Error("GROWTH_ATTRIBUTE_TOTAL_TOO_HIGH");
  }

  const grade = String(new_grade || "").trim().slice(0, 80);
  if (physical + technique + mind + hp + ce === 0 && !grade) {
    throw new Error("NO_GROWTH_CHANGE");
  }

  const player = state.player;
  if (!player) throw new Error("PLAYER_SETUP_REQUIRED");

  const before = {
    physical: Number(player.attributes?.physical?.value || 0),
    technique: Number(player.attributes?.technique?.value || 0),
    mind: Number(player.attributes?.mind?.value || 0),
    hp_current: Number(player.resources?.hp?.current || 0),
    hp_max: Number(player.resources?.hp?.max || 0),
    ce_current: Number(player.resources?.ce?.current || 0),
    ce_max: Number(player.resources?.ce?.max || 0),
    grade: player.grade || ""
  };

  player.attributes.physical.value = clamp(before.physical + physical, 0, RULES.attribute_max);
  player.attributes.technique.value = clamp(before.technique + technique, 0, RULES.attribute_max);
  player.attributes.mind.value = clamp(before.mind + mind, 0, RULES.attribute_max);

  const newHpMax = Math.max(1, before.hp_max + hp);
  const newCeMax = Math.max(1, before.ce_max + ce);
  player.resources.hp.max = newHpMax;
  player.resources.hp.current = clamp(before.hp_current + hp, 0, newHpMax);
  player.resources.ce.max = newCeMax;
  player.resources.ce.current = clamp(before.ce_current + ce, 0, newCeMax);

  if (grade) player.grade = grade;

  const after = {
    physical: player.attributes.physical.value,
    technique: player.attributes.technique.value,
    mind: player.attributes.mind.value,
    hp_current: player.resources.hp.current,
    hp_max: player.resources.hp.max,
    ce_current: player.resources.ce.current,
    ce_max: player.resources.ce.max,
    grade: player.grade || ""
  };

  const growth = ensureGrowthState(state);
  const event = {
    growth_id: makeId("growth"),
    type: "character_growth",
    growth_scale,
    reason: String(reason).trim().slice(0, 500),
    evidence_ids: evidence.map((item) => item.evidence_id),
    before,
    after,
    applied_at: new Date().toISOString()
  };

  for (const item of evidence) item.consumed_by = event.growth_id;
  growth.history.push(event);
  growth.history = growth.history.slice(-GROWTH_LIMITS.history_max_entries);

  return event;
}

export function evolveAbility(state, {
  ability_id,
  reason,
  evidence_ids,
  new_name = "",
  damage_min,
  damage_max,
  ce_cost,
  new_effect_kind = "",
  new_description = "",
  mastery_note = ""
}) {
  const ability = state.entities?.abilities?.[ability_id];
  if (!ability) throw new Error("ABILITY_NOT_FOUND");
  if (ability.builtin) throw new Error("BUILTIN_ABILITY_NOT_EVOLVABLE");
  if (!String(reason || "").trim()) throw new Error("GROWTH_REASON_REQUIRED");

  const evidence = requireUnusedEvidence(state, evidence_ids);
  const hasRangeInput =
    damage_min !== undefined || damage_max !== undefined;
  const newRange = hasRangeInput ? validateRange(damage_min, damage_max) : null;
  const newCe = ce_cost === undefined || ce_cost === null || ce_cost === ""
    ? null
    : validateCeCost(ce_cost, ability.ce_cost);

  const hasChange =
    String(new_name || "").trim() ||
    newRange ||
    newCe !== null ||
    String(new_effect_kind || "").trim() ||
    String(new_description || "").trim() ||
    String(mastery_note || "").trim();

  if (!hasChange) throw new Error("NO_ABILITY_EVOLUTION_CHANGE");

  const before = clonePlain(ability);

  if (String(new_name || "").trim()) ability.name = String(new_name).trim().slice(0, 80);
  if (newRange) {
    if (ability.type === "attack") ability.damage = newRange;
    if (ability.type === "heal") ability.healing = newRange;
  }
  if (newCe !== null) ability.ce_cost = newCe;
  if (String(new_effect_kind || "").trim()) {
    ability.effect_kind = String(new_effect_kind).trim().slice(0, 80);
  }
  if (String(new_description || "").trim()) {
    ability.description = String(new_description).trim().slice(0, 500);
  }

  ability.mastery_notes = Array.isArray(ability.mastery_notes) ? ability.mastery_notes : [];
  if (String(mastery_note || "").trim()) {
    ability.mastery_notes.push(String(mastery_note).trim().slice(0, 300));
    ability.mastery_notes = ability.mastery_notes.slice(-20);
  }

  ability.evolution_history = Array.isArray(ability.evolution_history)
    ? ability.evolution_history
    : [];

  const evolution = {
    evolution_id: makeId("ability_evolution"),
    ability_id,
    reason: String(reason).trim().slice(0, 500),
    evidence_ids: evidence.map((item) => item.evidence_id),
    before: {
      name: before.name,
      damage: before.damage || null,
      healing: before.healing || null,
      ce_cost: before.ce_cost,
      effect_kind: before.effect_kind || "",
      description: before.description || ""
    },
    after: {
      name: ability.name,
      damage: ability.damage || null,
      healing: ability.healing || null,
      ce_cost: ability.ce_cost,
      effect_kind: ability.effect_kind || "",
      description: ability.description || ""
    },
    mastery_note: String(mastery_note || "").trim().slice(0, 300),
    applied_at: new Date().toISOString()
  };

  ability.evolution_history.push(evolution);
  ability.evolution_history = ability.evolution_history.slice(-50);

  const growth = ensureGrowthState(state);
  for (const item of evidence) item.consumed_by = evolution.evolution_id;
  growth.history.push({
    growth_id: evolution.evolution_id,
    type: "ability_evolution",
    ability_id,
    reason: evolution.reason,
    evidence_ids: evolution.evidence_ids,
    applied_at: evolution.applied_at
  });
  growth.history = growth.history.slice(-GROWTH_LIMITS.history_max_entries);

  return evolution;
}

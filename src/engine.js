import crypto from "node:crypto";
import {
  ABILITY_COSTS,
  ABILITY_NUMERIC_LIMITS,
  ABILITY_POWER_PROFILES,
  BUILTIN_ABILITIES,
  CINEMATIC_COMBAT,
  ENEMY_GRADE_PROFILES,
  LEGACY_ATTACK_DAMAGE_RANGES,
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

export function positiveDiceFromStat(stat) {
  return clamp(Math.floor(Number(stat || 0) / RULES.stat_per_positive_die), 0, RULES.max_positive_dice);
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


function clonePlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureEngineMeta(state) {
  if (!state.engine_meta || typeof state.engine_meta !== "object" || Array.isArray(state.engine_meta)) {
    state.engine_meta = {};
  }

  if (!Number.isInteger(state.engine_meta.mechanics_revision) || state.engine_meta.mechanics_revision < 0) {
    state.engine_meta.mechanics_revision = 0;
  }

  if (!Object.hasOwn(state.engine_meta, "last_check")) {
    state.engine_meta.last_check = null;
  }

  if (!Object.hasOwn(state.engine_meta, "last_combat_action")) {
    state.engine_meta.last_combat_action = null;
  }

  return state.engine_meta;
}

export function markMechanicalMutation(state) {
  const meta = ensureEngineMeta(state);
  meta.mechanics_revision += 1;
  return meta.mechanics_revision;
}

function attributeValue(actor, attribute) {
  const raw = actor?.attributes?.[attribute];
  if (raw && typeof raw === "object") return Number(raw.value || 0);
  return Number(raw || 0);
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
  const finalDice = clamp(baseDice + Number(bonus_dice || 0) - Number(penalty_dice || 0), 0, RULES.max_positive_dice);
  const dc = clamp(Number(difficulty || RULES.difficulties.normal), 1, 30);
  const rolls = finalDice > 0 ? rollDice(finalDice, RULES.dice_type) : [];
  const highest = rolls.length ? Math.max(...rolls) : null;
  const success = highest !== null && highest >= dc;

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
    success,
    result: finalDice === 0 ? "automatic_failure_no_positive_dice" : (success ? "success" : "failure"),
    reason
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

  if (!last?.request || !last.current_check_id) {
    throw new Error("NO_CHECK_TO_REROLL");
  }

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


export function applyResourceOperation(state, { target_id, operation, amount, reason = "" }) {
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
    reason
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
    name: String(name || "未命名咒灵").slice(0, 80),
    type: "curse",
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
    inventory: [],
    ability_ids: ["basic_attack"],
    notes: String(notes || "").slice(0, 300),
    generated_by: { type: "ai_dynamic", created_at: new Date().toISOString() }
  };

  state.entities.enemies[id] = enemy;
  return enemy;
}

function explicitDamageRange(damageMin, damageMax) {
  const hasMin = damageMin !== undefined && damageMin !== null && damageMin !== "";
  const hasMax = damageMax !== undefined && damageMax !== null && damageMax !== "";

  if (!hasMin && !hasMax) return null;
  if (!hasMin || !hasMax) throw new Error("INVALID_ABILITY_DAMAGE_RANGE");

  const min = Math.trunc(Number(damageMin));
  const max = Math.trunc(Number(damageMax));

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

function explicitCeCost(value, fallback) {
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

  const normalizedPower = ABILITY_POWER_PROFILES[power] ? power : "medium";
  const normalizedCost = Object.hasOwn(ABILITY_COSTS, cost) ? cost : "medium";
  const id = makeId("ability");

  const customDamage = type === "attack"
    ? explicitDamageRange(damage_min, damage_max)
    : null;

  const ability = {
    id,
    name: String(name || "未命名术式").slice(0, 80),
    type,
    attribute,
    power: normalizedPower,
    ce_cost: explicitCeCost(ce_cost, ABILITY_COSTS[normalizedCost]),
    damage: type === "attack"
      ? (customDamage || { ...ABILITY_POWER_PROFILES[normalizedPower] })
      : null,
    healing: type === "heal" ? { ...ABILITY_POWER_PROFILES[normalizedPower] } : null,
    effect_kind: String(effect_kind || "").slice(0, 60),
    description: String(description || "").slice(0, 300),
    generated_by: {
      type: customDamage ? "ai_numeric_design" : "ai_dynamic_legacy_profile",
      created_at: new Date().toISOString()
    }
  };

  state.entities.abilities[id] = ability;
  owner.ability_ids = Array.isArray(owner.ability_ids) ? owner.ability_ids : ["basic_attack"];
  if (!owner.ability_ids.includes(id)) owner.ability_ids.push(id);
  return ability;
}

function actorSpeed(actor) {
  return Number(actor?.combat?.speed || 0);
}

export function startCombat(state, { enemy_ids = [], ally_ids = [] }) {
  const ids = [state.player.id, ...ally_ids, ...enemy_ids];
  const unique = [...new Set(ids)].filter(id => findActor(state, id));
  if (!enemy_ids.length) throw new Error("NO_ENEMIES");

  unique.sort((a, b) => actorSpeed(findActor(state, b)) - actorSpeed(findActor(state, a)));
  state.combat_state = {
    active: true,
    combat_id: makeId("combat"),
    round: 1,
    turn_index: 0,
    turn_order: unique,
    current_actor: unique[0] || null
  };
  return state.combat_state;
}

function rollFormula(formula) {
  const rolls = rollDice(formula.dice_count, formula.dice_sides);
  return {
    mode: "dice",
    rolls,
    dice_total: rolls.reduce((a, b) => a + b, 0),
    flat: Number(formula.flat || 0),
    total: rolls.reduce((a, b) => a + b, 0) + Number(formula.flat || 0)
  };
}

function rollAttackDamage(spec, power = "low") {
  if (
    spec &&
    spec.mode === "range" &&
    Number.isFinite(Number(spec.min)) &&
    Number.isFinite(Number(spec.max))
  ) {
    const min = Math.trunc(Number(spec.min));
    const max = Math.trunc(Number(spec.max));
    const total = randomInt(min, max);
    return {
      mode: "range",
      min,
      max,
      roll: total,
      total
    };
  }

  // Old abilities often stored low dice formulas such as 1d8+4.
  // Convert those legacy attacks to the new cinematic damage pacing
  // without requiring the campaign to recreate every ability.
  const range = LEGACY_ATTACK_DAMAGE_RANGES[power] || LEGACY_ATTACK_DAMAGE_RANGES.low;
  const total = randomInt(range.min, range.max);
  return {
    mode: "legacy_cinematic_range",
    min: range.min,
    max: range.max,
    roll: total,
    total,
    legacy_formula: spec || null
  };
}

function strongHitFromCheck(check) {
  if (!check?.success || check.highest_roll === null) return false;
  const margin = Number(check.highest_roll) - Number(check.difficulty);
  return (
    margin >= CINEMATIC_COMBAT.strong_hit_margin ||
    Number(check.highest_roll) === CINEMATIC_COMBAT.strong_hit_natural_roll
  );
}

function isDefeated(actor) {
  return Number(actor?.resources?.hp?.current ?? 1) <= 0;
}

function advanceTurn(state) {
  const combat = state.combat_state;
  if (!combat?.active || !combat.turn_order.length) return;

  const living = combat.turn_order.filter(id => {
    const actor = findActor(state, id);
    return actor && !isDefeated(actor);
  });
  combat.turn_order = living;

  const enemiesAlive = Object.values(state.entities.enemies || {}).some(enemy => living.includes(enemy.id) && !isDefeated(enemy));
  if (!enemiesAlive || isDefeated(state.player)) {
    combat.active = false;
    combat.current_actor = null;
    return;
  }

  combat.turn_index += 1;
  if (combat.turn_index >= combat.turn_order.length) {
    combat.turn_index = 0;
    combat.round += 1;
  }
  combat.current_actor = combat.turn_order[combat.turn_index] || null;
}

export function resolveCombatAction(state, { actor_id, target_id, ability_id = "basic_attack" }) {
  const combat = state.combat_state;
  if (!combat?.active) throw new Error("COMBAT_NOT_ACTIVE");
  if (combat.current_actor !== actor_id) throw new Error("NOT_ACTORS_TURN");

  const actor = findActor(state, actor_id);
  const target = findActor(state, target_id);
  if (!actor || !target) throw new Error("ACTOR_OR_TARGET_NOT_FOUND");
  if (isDefeated(actor)) throw new Error("ACTOR_DEFEATED");
  if (isDefeated(target)) throw new Error("TARGET_DEFEATED");

  const ability = state.entities.abilities?.[ability_id] || BUILTIN_ABILITIES[ability_id];
  if (!ability) throw new Error("ABILITY_NOT_FOUND");
  if (ability_id !== "basic_attack" && !actor.ability_ids?.includes(ability_id)) throw new Error("ABILITY_NOT_OWNED");

  const ceCost = Number(ability.ce_cost || 0);
  if (Number(actor.resources?.ce?.current || 0) < ceCost) throw new Error("NOT_ENOUGH_CE");
  if (ceCost > 0) actor.resources.ce.current -= ceCost;

  const result = {
    combat_id: combat.combat_id,
    round: combat.round,
    actor_id,
    target_id,
    ability: { id: ability.id, name: ability.name, type: ability.type },
    ce_spent: ceCost
  };

  if (ability.type === "attack") {
    const check = runCheck(state, {
      actor_id,
      attribute: ability.attribute || "physical",
      difficulty: Number(target.combat?.defense_dc || RULES.difficulties.normal),
      reason: `combat:${ability.name}`
    });
    result.check = check;
    result.hit = check.success;

    if (check.success) {
      const damage = rollAttackDamage(ability.damage, ability.power || "low");
      const strongHit = strongHitFromCheck(check);
      const baseDamage = Number(damage.total);
      const resolvedDamage = strongHit
        ? Math.floor(baseDamage * CINEMATIC_COMBAT.strong_hit_multiplier)
        : baseDamage;

      const before = Number(target.resources.hp.current);
      const after = clamp(before - resolvedDamage, 0, Number(target.resources.hp.max));
      target.resources.hp.current = after;

      result.strong_hit = strongHit;
      result.damage = {
        ...damage,
        base_damage: baseDamage,
        strong_hit: strongHit,
        strong_hit_multiplier: strongHit ? CINEMATIC_COMBAT.strong_hit_multiplier : 1,
        total: resolvedDamage,
        before_hp: before,
        after_hp: after,
        final_damage: before - after
      };
      result.target_defeated = after <= 0;
    } else {
      result.damage = null;
      result.target_defeated = false;
    }
  } else if (ability.type === "heal") {
    const healing = rollFormula(ability.healing || ABILITY_POWER_PROFILES.low);
    const before = Number(target.resources.hp.current);
    const after = clamp(before + healing.total, 0, Number(target.resources.hp.max));
    target.resources.hp.current = after;
    result.healing = { ...healing, before_hp: before, after_hp: after, final_healing: after - before };
  } else {
    result.check = runCheck(state, {
      actor_id,
      attribute: ability.attribute || "technique",
      difficulty: RULES.difficulties.normal,
      reason: `utility:${ability.name}`
    });
    result.effect_kind = ability.effect_kind || "narrative_utility";
  }

  advanceTurn(state);
  result.combat_after = {
    active: state.combat_state.active,
    round: state.combat_state.round,
    current_actor: state.combat_state.current_actor,
    turn_order: state.combat_state.turn_order
  };
  return result;
}

function captureCombatActionSnapshot(state, request) {
  const ids = [...new Set([request.actor_id, request.target_id].filter(Boolean))];
  const actors = {};

  for (const id of ids) {
    const actor = findActor(state, id);
    if (!actor) throw new Error("ACTOR_OR_TARGET_NOT_FOUND");
    actors[id] = clonePlain(actor);
  }

  return {
    actors,
    combat_state: clonePlain(state.combat_state)
  };
}

function restoreActorSnapshot(state, id, snapshot) {
  if (state.player?.id === id) {
    state.player = clonePlain(snapshot);
    return;
  }

  if (state.entities?.enemies?.[id]) {
    state.entities.enemies[id] = clonePlain(snapshot);
    return;
  }

  if (state.entities?.npcs?.[id]) {
    state.entities.npcs[id] = clonePlain(snapshot);
    return;
  }

  throw new Error("REROLL_SNAPSHOT_INVALID");
}

function restoreCombatActionSnapshot(state, snapshot) {
  if (!snapshot?.actors || !snapshot?.combat_state) {
    throw new Error("REROLL_SNAPSHOT_INVALID");
  }

  for (const [id, actor] of Object.entries(snapshot.actors)) {
    restoreActorSnapshot(state, id, actor);
  }

  state.combat_state = clonePlain(snapshot.combat_state);
}

export function resolveTrackedCombatAction(state, args = {}) {
  const meta = ensureEngineMeta(state);
  const request = {
    actor_id: args.actor_id,
    target_id: args.target_id,
    ability_id: args.ability_id || "basic_attack"
  };

  const beforeSnapshot = captureCombatActionSnapshot(state, request);
  const preRevision = meta.mechanics_revision;
  const actionId = makeId("combat_action");
  const resolutionId = makeId("resolution");

  const result = resolveCombatAction(state, request);

  meta.mechanics_revision = preRevision + 1;
  const postRevision = meta.mechanics_revision;

  Object.assign(result, {
    action_id: actionId,
    resolution_id: resolutionId,
    reroll_count: 0
  });

  meta.last_combat_action = {
    action_id: actionId,
    resolution_id: resolutionId,
    reroll_count: 0,
    request,
    before_snapshot: beforeSnapshot,
    pre_revision: preRevision,
    post_revision: postRevision,
    resolved_at: new Date().toISOString()
  };

  return result;
}

export function rerollLastCombatAction(state, { expected_action_id = "" } = {}) {
  const meta = ensureEngineMeta(state);
  const last = meta.last_combat_action;

  if (!last?.request || !last?.before_snapshot || !last?.action_id) {
    throw new Error("NO_COMBAT_ACTION_TO_REROLL");
  }

  if (expected_action_id && expected_action_id !== last.action_id) {
    throw new Error("REROLL_COMBAT_ACTION_MISMATCH");
  }

  if (meta.mechanics_revision !== last.post_revision) {
    throw new Error("REROLL_STALE_COMBAT_ACTION");
  }

  // Keep the current post-action mechanical state in case the redo itself
  // unexpectedly fails. A failed reroll must never corrupt the campaign.
  const currentSnapshot = captureCombatActionSnapshot(state, last.request);
  const currentRevision = meta.mechanics_revision;
  const previousResolutionId = last.resolution_id;

  try {
    restoreCombatActionSnapshot(state, last.before_snapshot);
    meta.mechanics_revision = last.pre_revision;

    const result = resolveCombatAction(state, last.request);
    const newResolutionId = makeId("resolution");
    const rerollCount = Number(last.reroll_count || 0) + 1;

    // This is a replacement of the previous resolution, not an additional
    // combat turn, so the mechanics revision returns to the same post-action
    // revision number.
    meta.mechanics_revision = last.post_revision;

    Object.assign(result, {
      action_id: last.action_id,
      resolution_id: newResolutionId,
      reroll: true,
      reroll_count: rerollCount,
      replaces_resolution_id: previousResolutionId
    });

    meta.last_combat_action = {
      ...last,
      resolution_id: newResolutionId,
      reroll_count: rerollCount,
      resolved_at: new Date().toISOString()
    };

    return result;
  } catch (error) {
    restoreCombatActionSnapshot(state, currentSnapshot);
    meta.mechanics_revision = currentRevision;
    throw error;
  }
}


import crypto from "node:crypto";
import {
  ABILITY_COSTS,
  ABILITY_POWER_PROFILES,
  BUILTIN_ABILITIES,
  ENEMY_GRADE_PROFILES,
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

export function createAbility(state, {
  owner_id,
  name,
  type = "attack",
  attribute = "technique",
  power = "medium",
  cost = "medium",
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

  const ability = {
    id,
    name: String(name || "未命名术式").slice(0, 80),
    type,
    attribute,
    power: normalizedPower,
    ce_cost: ABILITY_COSTS[normalizedCost],
    damage: type === "attack" ? { ...ABILITY_POWER_PROFILES[normalizedPower] } : null,
    healing: type === "heal" ? { ...ABILITY_POWER_PROFILES[normalizedPower] } : null,
    effect_kind: String(effect_kind || "").slice(0, 60),
    description: String(description || "").slice(0, 300),
    generated_by: { type: "ai_dynamic", created_at: new Date().toISOString() }
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
    rolls,
    dice_total: rolls.reduce((a, b) => a + b, 0),
    flat: Number(formula.flat || 0),
    total: rolls.reduce((a, b) => a + b, 0) + Number(formula.flat || 0)
  };
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
      const damage = rollFormula(ability.damage || ABILITY_POWER_PROFILES.low);
      const before = Number(target.resources.hp.current);
      const after = clamp(before - damage.total, 0, Number(target.resources.hp.max));
      target.resources.hp.current = after;
      result.damage = { ...damage, before_hp: before, after_hp: after, final_damage: before - after };
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

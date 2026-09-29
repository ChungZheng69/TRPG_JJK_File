export const RULES = Object.freeze({
  schema_version: 3,
  attribute_max: 100,
  stat_per_positive_die: 20,
  max_positive_dice: 5,
  dice_type: 20,
  difficulties: {
    easy: 6,
    normal: 10,
    hard: 14,
    very_hard: 17,
    extreme: 20
  },
  check_degrees: {
    strong_success_margin: 5,
    overwhelming_success_margin: 10,
    severe_failure_margin: -5
  }
});

export const ENEMY_GRADE_PROFILES = Object.freeze({
  "Grade 4": {
    attribute: [20, 40], hp: [20, 30], ce: [10, 30], defense_dc: [8, 10], speed: [20, 40]
  },
  "Grade 3": {
    attribute: [30, 55], hp: [30, 45], ce: [20, 45], defense_dc: [9, 11], speed: [30, 55]
  },
  "Grade 2": {
    attribute: [45, 75], hp: [45, 70], ce: [40, 80], defense_dc: [10, 13], speed: [40, 70]
  },
  "Grade 1": {
    attribute: [60, 90], hp: [70, 110], ce: [70, 130], defense_dc: [12, 15], speed: [55, 85]
  },
  "Special Grade": {
    attribute: [80, 100], hp: [120, 190], ce: [120, 250], defense_dc: [14, 18], speed: [70, 100]
  }
});

export const ABILITY_NUMERIC_LIMITS = Object.freeze({
  damage_min: 1,
  damage_max: 120,
  ce_cost_min: 0,
  ce_cost_max: 100
});

// These are narrative reference ranges, not automatic combat rolls.
export const ABILITY_REFERENCE_RANGES = Object.freeze({
  low: { min: 18, max: 30 },
  medium: { min: 28, max: 45 },
  high: { min: 40, max: 65 },
  extreme: { min: 60, max: 90 }
});

export const ABILITY_COSTS = Object.freeze({
  none: 0,
  low: 5,
  medium: 10,
  high: 18,
  extreme: 30
});

export const GROWTH_LIMITS = Object.freeze({
  attribute_delta_per_stat: 10,
  attribute_delta_total: 15,
  hp_max_delta: 25,
  ce_max_delta: 30,
  ledger_max_entries: 120,
  history_max_entries: 120
});

export const BUILTIN_ABILITIES = Object.freeze({
  basic_attack: {
    id: "basic_attack",
    name: "普通攻击",
    type: "attack",
    attribute: "physical",
    ce_cost: 0,
    power: "low",
    damage: { mode: "range", min: 10, max: 18 },
    effect_kind: "",
    description: "不消耗 CE 的基础近战攻击。Damage 范围仅作为 GM 叙事裁定参考。",
    builtin: true,
    mastery_notes: [],
    evolution_history: []
  }
});

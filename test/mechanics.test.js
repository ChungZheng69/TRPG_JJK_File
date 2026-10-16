import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultState, normalizeRecord } from "../src/storage.js";
import { applyResourceOperation, rerollLastCheck, runTrackedCheck } from "../src/engine.js";

test("HP and CE clamps and restoration retain the existing resource behavior", () => {
  const state = createDefaultState({ player: { resources: { hp: { current: 42, max: 90 }, ce: { current: 30, max: 70 } } },
    narrative_history: ["Preserve"], growth: { history: [{ growth_id: "old" }] } });
  const target_id = state.player.id;
  const spend = applyResourceOperation(state, { target_id, operation: "spend_ce", amount: 35 });
  assert.deepEqual([spend.before, spend.after, spend.applied_change], [30, 0, -30]);
  assert.equal(state.player.resources.hp.current, 42);
  const restore = applyResourceOperation(state, { target_id, operation: "restore_ce", amount: 100 });
  assert.equal(restore.after, 70);
  const damage = applyResourceOperation(state, { target_id, operation: "damage", amount: 100 });
  assert.deepEqual([damage.before, damage.after, damage.applied_change, damage.depleted], [42, 0, -42, true]);
  const heal = applyResourceOperation(state, { target_id, operation: "heal", amount: 200 });
  assert.equal(heal.after, 90);
  assert.equal(state.player.resources.ce.current, 70);
  const restored = normalizeRecord({ state }, "restored").state;
  assert.deepEqual(restored, state);
  assert.deepEqual(restored.narrative_history, ["Preserve"]);
  assert.deepEqual(restored.growth.history, [{ growth_id: "old" }]);
});

test("dice counts, reroll checks and zero-dice failure retain the existing rules", () => {
  const state = createDefaultState({ player: { attributes: { physical: 80, technique: 0, mind: 40 } } });
  const before = structuredClone(state.player.resources);
  const check = runTrackedCheck(state, { actor_id: state.player.id, attribute: "physical", difficulty: 12 });
  assert.equal(check.base_dice, 4);
  assert.equal(check.final_dice, 4);
  assert.equal(check.rolls.length, 4);
  assert.ok(check.rolls.every((roll) => Number.isInteger(roll) && roll >= 1 && roll <= 20));
  assert.equal(check.highest_roll, Math.max(...check.rolls));
  assert.equal(check.success, check.highest_roll >= 12);
  assert.throws(() => rerollLastCheck(state, { expected_check_id: "wrong" }), { message: "REROLL_CHECK_MISMATCH" });
  const reroll = rerollLastCheck(state, { expected_check_id: check.check_id });
  assert.equal(reroll.original_check_id, check.check_id);
  assert.equal(reroll.reroll_count, 1);
  assert.equal(reroll.final_dice, 4);
  const zero = runTrackedCheck(state, { actor_id: state.player.id, attribute: "technique", difficulty: 12 });
  assert.equal(zero.degree, "automatic_failure_no_positive_dice");
  assert.equal(zero.success, false);
  assert.deepEqual(zero.rolls, []);
  assert.deepEqual(state.player.resources, before);
});

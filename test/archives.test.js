import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultState, normalizeRecord } from "../src/storage.js";
import { applyCharacterGrowth, evolveAbility, recordGrowthEvidence, updateEntityState } from "../src/engine.js";

test("growth and ability mutations retain archives beyond their old retention limits", () => {
  const originalHistory = Array.from({ length: 150 }, (_, index) => ({ growth_id: `old_${index}` }));
  const originalLedger = Array.from({ length: 150 }, (_, index) => ({ evidence_id: `old_evidence_${index}`, consumed_by: null }));
  const originalEvolutions = Array.from({ length: 60 }, (_, index) => ({ evolution_id: `old_evolution_${index}` }));
  const originalNotes = Array.from({ length: 25 }, (_, index) => `note_${index}`);
  const state = createDefaultState({
    player: { state_notes: originalNotes.slice() },
    growth: { ledger: originalLedger.slice(), history: originalHistory.slice() },
    entities: { abilities: { custom: { id: "custom", name: "Custom", type: "attack", ce_cost: 2,
      damage: { mode: "range", min: 2, max: 4 }, mastery_notes: originalNotes.slice(), evolution_history: originalEvolutions.slice() } } }
  });
  const first = recordGrowthEvidence(state, { category: "physical", note: "Practice" });
  assert.equal(state.growth.ledger.length, 151);
  const growth = applyCharacterGrowth(state, { evidence_ids: [first.evidence_id], reason: "Practice", physical_delta: 1 });
  assert.equal(growth.after.physical, growth.before.physical + 1);
  assert.equal(state.growth.history.length, 151);
  const second = recordGrowthEvidence(state, { category: "ability", note: "Refinement", related_ability_id: "custom" });
  evolveAbility(state, { ability_id: "custom", evidence_ids: [second.evidence_id], reason: "Refinement", new_name: "Refined", mastery_note: "New note" });
  assert.equal(state.entities.abilities.custom.evolution_history.length, 61);
  assert.equal(state.entities.abilities.custom.mastery_notes.length, 26);
  assert.equal(state.growth.history.length, 152);
  updateEntityState(state, { target_id: state.player.id, note: "New state note" });
  assert.equal(state.player.state_notes.length, 26);
  assert.deepEqual(state.growth.history.slice(0, 150), originalHistory);
  assert.deepEqual(state.entities.abilities.custom.evolution_history.slice(0, 60), originalEvolutions);
  assert.deepEqual(normalizeRecord({ state }, "fixture").state, state);
});

test("archived growth evidence remains saved without changing the original eligibility window", () => {
  const state = createDefaultState({ growth: { ledger: Array.from({ length: 130 }, (_, index) => ({
    evidence_id: `evidence_${index}`, category: "physical", consumed_by: null
  })) } });
  const args = { evidence_ids: ["evidence_0"], reason: "Test", physical_delta: 1 };
  assert.throws(() => applyCharacterGrowth(state, args), { message: "GROWTH_EVIDENCE_NOT_FOUND" });
  assert.equal(state.growth.ledger[0].evidence_id, "evidence_0");
  const growth = applyCharacterGrowth(state, { ...args, evidence_ids: ["evidence_129"] });
  assert.equal(growth.after.physical, growth.before.physical + 1);
  assert.throws(() => applyCharacterGrowth(state, { ...args, evidence_ids: ["evidence_129"] }), { message: "GROWTH_EVIDENCE_ALREADY_USED" });
  assert.throws(() => applyCharacterGrowth(state, { ...args, evidence_ids: ["evidence_128"], physical_delta: 11 }), { message: "INVALID_GROWTH_DELTA" });
  assert.equal(state.growth.ledger.length, 130);
});

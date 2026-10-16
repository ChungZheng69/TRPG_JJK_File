# V3 Action response handling

- Call `loadCampaignContext` at campaign continuation. Its `state` is a compact
  view of the authoritative save; returned numeric values remain authoritative.
- Read `context.omitted_sections`. Omitted fields are not empty, reset or deleted.
  A listed section can contain a shortened descriptive preview or a partial
  collection. Do not treat that preview as the complete saved narrative.
  Before relying on missing facts, abilities, inventory or NPC knowledge, call
  `readCampaignSection` with the precise JSON Pointer for the needed field/entity.
- For paged sections, start at offset zero. Follow `next_offset`, passing the first
  response's `updated_at` as `expected_updated_at` on each later call. Concatenate
  the decoded `serialized_json` strings and parse the completed JSON when
  `next_offset` is null. On `CAMPAIGN_CHANGED`, restart at offset zero.
- Mutation actions return operation results without a full campaign state.
  `updateCampaignNarrative` returns `changed_fields` and save metadata. Treat a
  successful response as acknowledgement; do not require an echoed save.
- Use operation results for immediate narration. Reload compact context only when
  additional state is needed. If `response_context.partial` is present, retrieve
  the relevant saved entity/field before relying on omitted result details.
- Use `readCampaignHistory` to browse older saved records by collection. Its
  `offset` and `next_offset` are record indexes; use a limit of at most 20 and pass
  the first page's `updated_at` as `expected_updated_at` on later pages. An item
  marked `partial=true` has oversized content; use its `pointer` with
  `readCampaignSection` to obtain that record in full. History pages and section
  chunks use different offset units.
- Keep narrative updates focused. Preserve unresolved facts and NPC knowledge
  boundaries. Do not copy the entire save/history into `rolling_summary` or
  `recent_events`, and never use a compact response as a full replacement save.
- These instructions concern transport and memory retrieval only. Existing V3
  combat, dice, resources and growth rules continue to apply.

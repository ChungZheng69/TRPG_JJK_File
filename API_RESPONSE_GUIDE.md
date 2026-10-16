# Compact Action responses and campaign recovery

## Findings

The V3 code previously returned the entire PostgreSQL save from
`loadCampaignContext` (`GET /campaigns/:campaignId`). Every mutation also returned
the full state, including `updateCampaignNarrative`. There was no response-size
logging. A long campaign could therefore make even a small narrative patch or HP
change return a very large response.

Sources of response growth and duplication:

- `recent_events`, `rolling_summary`, facts, quests, relationships and flags have no
  aggregate response-size limit. Similar narrative material may appear across
  these fields, but the code cannot establish that two facts are semantically
  redundant. This change does not deduplicate or delete saved narrative.
- Ability evolution stores before/after snapshots in `evolution_history`; growth
  adds ledger/history entries, and entities accumulate state notes/mastery notes.
- Mutation responses repeated the full state alongside `player`, `ability`,
  `enemy`, `check`, `growth` or other operation results. The operation result and
  state often repeated the same fields.
- Loading/normalizing a save previously removed unknown JSON fields and sliced
  growth collections. Mutation code also pruned archive collections. Those archive
  pruning steps are removed so response compaction never requires deleting history.

The public Render health endpoint reported engine 3.0.0, schema 3, narrative combat
and healthy PostgreSQL storage during inspection. Production Action traces and
campaign contents were not accessed. Oversize responses are reproduced with
synthetic data; confirmation of which live Action failed requires the new logs.

## Response contract

Action response budgets are **16,000 Unicode characters and 32,000 UTF-8 bytes**,
including JSON escaping and the response envelope. These are conservative project
budgets, not a claim about a particular external platform's limit.

- `loadCampaignContext` keeps `campaign_id`, `updated_at`, and `state`, and adds
  `view: "compact"` and `context`. Player mechanics have priority. The view includes
  current scene, statuses, facts, recent events, and a rolling summary preview of
  at most 1,000 UTF-16 units. Large descriptive fields have bounded previews.
  History stays outside this view, and recent events show at most the latest ten.
  Active enemies exclude explicitly inactive and zero-HP enemies; an explicit
  `scene.active_enemy_ids` list takes priority when present. Abilities are selected
  from the player, active enemies and present NPCs rather than save insertion order.
  Large collections can still be partial and must be retrieved when needed.
- `context.partial` and `context.omitted_sections` explicitly identify incomplete
  sections. Missing fields are **not empty, reset, or deleted**.
- All Action mutations return `success`, `campaign_id`, `updated_at`, and their
  operation result, without a full `state`. Narrative updates return
  `changed_fields`. Relevant `updated` fields report entity resources/status,
  last-check metadata, ability owner IDs or the resulting player/ability sheet.
  A large operation result is also bounded and marked in
  `response_context` when fields/history are omitted.
- `readCampaignSection` retrieves any saved field by JSON Pointer, for example
  `/state/important_facts`, `/state/growth/history` or
  `/state/entities/abilities/ability_id`. Escape `~` as `~0` and `/` as `~1` in
  individual pointer tokens.

Section responses contain a `serialized_json` text chunk. Start with `offset=0`,
then pass `next_offset` and the first page's `updated_at` as
`expected_updated_at` on every later call. Concatenate the decoded string chunks
in order and JSON-parse the result when `next_offset` is null. Offsets are UTF-16
units and chunks do not split surrogate pairs. A 409 `CAMPAIGN_CHANGED` means
restart at zero. Retrieve specific fields/entities rather than the entire save
when only a small part is needed.

`readCampaignHistory` (`GET /campaigns/:campaignId/history`) is a separate route
protected independently by the existing bearer authentication. It requires the
same API key, without introducing another credential or database schema change.
Choose `collection=recent_events`, `narrative_history`, `important_facts`,
`canon_changes`, `growth_history`, `growth_ledger` or `logs`. It reads all saved
records, including records older than the compact view's latest events.

History pagination uses **record indexes**, unlike section pagination's UTF-16
offsets. Start with `offset=0` and `limit=10` (maximum 20); follow `next_offset`,
passing the first page's `updated_at` as `expected_updated_at`. Each item has its
original `index`, `value`, `partial` flag and JSON `pointer`. If one record is too
large for a page, its value is previewed and `partial=true`; pass its pointer to
`readCampaignSection` for full lossless content. Pagination never writes a save.

Normal narrative PATCH behavior is unchanged: supplied fields replace those
fields and unspecified fields remain saved. A caller must never send the compact
view to the full-save route as a replacement campaign.

## Render logs

Each request has an `X-Request-Id` and a structured `http_request` entry containing
the method, fixed route template and Action operation ID. The matching
`http_response` entry records status, duration, JSON Unicode character count,
UTF-16 unit count and UTF-8 byte size. Measurements use the actual JSON string sent
by Express, including escaping. Aborted requests are marked `http_aborted`.

Logs exclude campaign IDs, URLs/query values, authorization headers, request
bodies, response bodies, error stacks and private campaign contents. Unexpected
engine errors use a fixed error label rather than logging database messages.

In Render, filter for `"operation_id":"loadCampaignContext"` or
`"operation_id":"updateCampaignNarrative"`, and inspect `json_utf8_bytes` and
`json_characters`. Correlate entries with `request_id`. Large manual exports are
expected and remain measured.

## Manual backup and restore

`GET /campaigns/:campaignId/export` requires the existing bearer API key and
returns the complete raw saved record. This route is deliberately excluded from
the Action schema because it can be large. Keep its output private.

The existing authenticated manual `PUT /campaigns/:campaignId` accepts
`{"state": <the exported state object>}`. Its recovery body limit is 10 MiB;
other requests retain the 256 KiB limit. Normal V3 state can be exported and
restored without losing archives or unknown extension fields. Existing numeric
setup normalization still applies. Restoring to an existing campaign ID replaces
that save, so use a separate recovery ID when verifying a backup.

No campaign deletion, database schema migration or new database column is part of
this change. All archive collections continue to live in the existing JSONB state.
Combat calculations and growth eligibility/balance rules are unchanged. Full saves
will grow over time; this patch bounds API output rather than discarding history.
In particular, all evidence remains archived, while only the most recent 120
ledger records remain eligible for growth, preserving the existing gameplay
window. Persisted V3 profile and narrative-position text also survives loading and
restoration without reapplying creation-time text limits.

## Validation and rollout

Run `npm ci` and `npm test` on Node 20 or newer. Tests use synthetic campaigns and
a mocked PostgreSQL query boundary; they never connect to Neon or access real
campaign saves. Coverage includes multi-megabyte saves, every Action mutation,
Unicode/escaping, privacy, errors/auth, archive retention, section reconstruction,
history pagination, stale-version rejection, full export/restore, HP/CE clamps,
dice/reroll behavior and the existing growth eligibility window.

The 16-test suite passes. The lockfile also supports a clean `npm ci`. One synthetic fixture measured:

| Response | Unicode characters | UTF-8 bytes |
| --- | ---: | ---: |
| Original full campaign load | 5,363,033 | 6,805,123 |
| Compact campaign load with descriptive previews | 4,594 | 5,412 |
| Narrative update acknowledgement | 115 | 115 |

The compact load marks omitted sections; the full fixture is retained and its
export/restore state compares equal. These measurements describe synthetic data,
not the size of any production campaign.

After review, merge the fix into the Render-connected branch and deploy. Replace
the Custom GPT Action schema with the updated `openapi.yaml`, then append
`CUSTOM_GPT_RESPONSE_ADDON.md` to the GPT instructions. The API's default response
contract changes, so other consumers of full GET/mutation state must use the
compact contract, section retrieval, or manual export.

Verify Render health and run a normal load/narrative-save Action while inspecting
size logs. This patch was prepared and tested locally; it was not deployed and no
production data was changed.

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
  `view: "compact"` and `context`. Player mechanics have priority. History is
  omitted; recent events show at most the latest ten. Large fields or collections
  that do not fit are omitted without changing the values that are returned.
- `context.partial` and `context.omitted_sections` explicitly identify incomplete
  sections. Missing fields are **not empty, reset, or deleted**.
- All Action mutations return `success`, `campaign_id`, `updated_at`, and their
  operation result, without a full `state`. Narrative updates return
  `changed_fields`. A large operation result is also bounded and marked in
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

## Validation and rollout

Run `npm ci` and `npm test` on Node 20 or newer. Tests use synthetic campaigns and
a mocked PostgreSQL query boundary; they never connect to Neon or access real
campaign saves. Coverage includes multi-megabyte saves, every Action mutation,
Unicode/escaping, privacy, errors/auth, archive retention, section reconstruction,
stale-version rejection, and full export/restore.

The 11-test suite passes after a clean `npm ci`. One synthetic fixture measured:

| Response | Unicode characters | UTF-8 bytes |
| --- | ---: | ---: |
| Original full campaign load | 5,363,033 | 6,805,123 |
| Compact campaign load | 1,807 | 1,897 |
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

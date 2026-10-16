import { randomUUID } from "node:crypto";
import { jsonSize } from "./api-responses.js";

// Only fixed route templates and numeric metadata enter logs. Never log URLs,
// query strings, headers, campaign IDs, request bodies, or response payloads.
export function requestLogging({ logger = console.log, operations = {} } = {}) {
  const endpoints = Object.entries(operations).map(([key, operation]) => {
    const [method, route] = key.split(" ");
    return { method, route, operation, pattern: new RegExp(`^${route.replace(":campaignId", "[^/]+")}/?$`, "i") };
  });
  return (req, res, next) => {
    const requestId = randomUUID();
    const start = performance.now();
    let size = null;
    res.setHeader("X-Request-Id", requestId);
    const endpoint = endpoints.find((entry) => entry.method === req.method && entry.pattern.test(req.path));
    const knownRoute = { route: endpoint?.route || "unmatched", operation_id: endpoint?.operation || "unmapped" };
    logger(JSON.stringify({ event: "http_request", request_id: requestId, method: req.method, ...knownRoute }));
    const send = res.send;
    res.send = function (body) {
      if (typeof body === "string" && String(res.getHeader("Content-Type")).includes("application/json")) size = jsonSize(body);
      return send.call(this, body);
    };
    const routeInfo = () => {
      const route = req.route?.path;
      const key = `${req.method} ${route}`;
      return { route: typeof route === "string" ? route : knownRoute.route, operation_id: operations[key] || knownRoute.operation_id };
    };
    let finished = false;
    res.once("finish", () => {
      finished = true;
      logger(JSON.stringify({
        event: "http_response", request_id: requestId, method: req.method, ...routeInfo(),
        status: res.statusCode, duration_ms: Math.round(performance.now() - start),
        json_characters: size?.characters ?? null, json_utf16_units: size?.utf16_units ?? null,
        json_utf8_bytes: size?.bytes ?? null
      }));
    });
    res.once("close", () => {
      if (!finished) logger(JSON.stringify({ event: "http_aborted", request_id: requestId, method: req.method, ...routeInfo() }));
    });
    next();
  };
}

export const ACTION_OPERATIONS = Object.freeze({
  "GET /campaigns/:campaignId": "loadCampaignContext",
  "GET /campaigns/:campaignId/sections": "readCampaignSection",
  "GET /campaigns/:campaignId/history": "readCampaignHistory",
  "GET /campaigns/:campaignId/export": "exportCampaign",
  "POST /campaigns/:campaignId/character/create": "createCharacterCampaign",
  "PATCH /campaigns/:campaignId/character": "updatePlayerCharacter",
  "PATCH /campaigns/:campaignId/narrative": "updateCampaignNarrative",
  "POST /campaigns/:campaignId/check": "runAttributeCheck",
  "POST /campaigns/:campaignId/check/reroll": "rerollLastCheck",
  "POST /campaigns/:campaignId/resources/change": "applyResourceChange",
  "POST /campaigns/:campaignId/enemies": "createDynamicEnemy",
  "POST /campaigns/:campaignId/abilities": "createDynamicAbility",
  "PATCH /campaigns/:campaignId/entities/state": "updateEntityState",
  "POST /campaigns/:campaignId/growth/evidence": "recordGrowthEvidence",
  "POST /campaigns/:campaignId/growth/apply": "applyCharacterGrowth",
  "PATCH /campaigns/:campaignId/abilities/evolve": "evolveAbility",
  "PUT /campaigns/:campaignId": "restoreCampaign"
});

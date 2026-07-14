import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.TRPG_API_KEY;
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");

app.use(express.json({ limit: "128kb" }));

function requireApiKey(req, res, next) {
  if (!API_KEY) return res.status(500).json({ error: "Server is missing TRPG_API_KEY." });
  const authorization = req.get("authorization") || "";
  if (authorization !== `Bearer ${API_KEY}`) return res.status(401).json({ error: "Unauthorized." });
  next();
}

function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,50}$/.test(value);
}

function fileFor(id) { return path.join(DATA_DIR, `${id}.json`); }

async function readCampaign(id) {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeCampaign(id, payload) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const finalPath = fileFor(id);
  const tempPath = `${finalPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, finalPath);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/campaigns/:campaignId", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  try {
    const campaign = await readCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: "Campaign not found.", campaign_id: campaignId });
    res.json(campaign);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load campaign." });
  }
});

app.put("/campaigns/:campaignId", requireApiKey, async (req, res) => {
  const { campaignId } = req.params;
  const { state } = req.body ?? {};
  if (!validId(campaignId)) return res.status(400).json({ error: "Invalid campaignId." });
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return res.status(400).json({ error: 'Request body must contain an object named "state".' });
  }
  const saved = { campaign_id: campaignId, updated_at: new Date().toISOString(), state };
  try {
    await writeCampaign(campaignId, saved);
    res.json({ success: true, campaign_id: campaignId, updated_at: saved.updated_at });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to save campaign." });
  }
});

app.use((_req, res) => res.status(404).json({ error: "Route not found." }));
app.listen(PORT, () => console.log(`JJK TRPG save API listening on port ${PORT}`));

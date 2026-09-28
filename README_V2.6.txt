JJK TRPG Engine v2.6 — PostgreSQL Persistence Patch

CORE FIX
Campaign saves no longer use Render's local ./data folder.
They are stored in PostgreSQL JSONB through DATABASE_URL.

REPLACE IN GITHUB
1. server.js
2. src/storage.js
3. package.json

KEEP EXISTING
- src/engine.js from v2.5
- src/rules.js from v2.4
- openapi-v2.5.yaml
- Custom GPT Action authentication/API key

REPLACE CUSTOM GPT INSTRUCTIONS
4. JJK_TRPG_SYSTEM_INSTRUCTIONS_V2.6_COMPACT.txt

RENDER
- Add DATABASE_URL = Neon pooled Postgres connection string
- Build Command: npm install
- Start Command: npm start

HEALTH CHECK
Expected:
engine_version = 2.6.0
storage.ok = true
storage.mode = postgres

The engine automatically creates a table named campaigns.

# 从旧 Save API 升级到 JJK TRPG Engine v2

## 先看结论

旧项目只是“读取/保存 JSON”。v2 把以下内容移到服务器：
- 20 属性 = 1 颗正向 d20，最多 5 颗，取最高值
- HP / CE 权威修改
- 动态敌人数值生成
- 动态技能数值生成
- 战斗命中、CE 消耗、伤害/治疗、击倒、回合推进

GPT 继续负责：剧情、NPC 扮演、判断何时检定、敌人/能力概念、场景与任务叙事。

---

## A. 旧文件怎么处理

### 必须替换
1. `server.js` → 用 v2 版本替换
2. `openapi.yaml` → 用 v2 版本替换，并把服务器 URL 改成你的 Render HTTPS 地址
3. `CUSTOM_GPT_INSTRUCTIONS_ADDON.md` → 用 v2 版本替换
4. `README.md` → 建议用 v2 版本替换
5. `.gitignore` → 用 v2 版本替换，防止 `.env.txt` 等密钥文件被提交

### 新增
- `src/rules.js`
- `src/storage.js`
- `src/engine.js`

### 可以直接保留
- `package-lock.json`：依赖仍然只有 Express + dotenv；如果你替换了 `package.json`，最稳妥是在本地跑一次 `npm install` 后提交新的 lock file。
- 旧 `data/main.json`：不要手工重写。v2 读取旧 state 时会尽量迁移成新结构。

### 建议替换但不是必须
- `package.json`：v2 包内提供了新的名称、版本和 `npm run check`，依赖没有新增。
- `.env.example`：改成 v2 示例即可。

### 不要上传/提交
- `.env`
- `.env.txt`
- 任何包含真实 `TRPG_API_KEY` 的文件

---

## B. 部署前先备份旧存档

在修改 GitHub / Render 前：

1. 复制你的旧 Render 域名，例如：
   `https://your-service.onrender.com`
2. 用旧 API 读取：
   `GET /campaigns/main`
3. 把返回的完整 JSON 保存到本地，例如：
   `backup-main-before-v2.json`
4. GitHub 也建议先建立一个 branch/tag，例如：
   `backup-v1`

如果你目前的 Render 没有 Persistent Disk，重新部署或重启有可能让本地 data 丢失；因此先备份很重要。

---

## C. GitHub 文件结构

升级后应类似：

```text
project-root/
├── server.js
├── package.json
├── package-lock.json
├── openapi.yaml
├── README.md
├── CUSTOM_GPT_INSTRUCTIONS_ADDON.md
├── .env.example
├── .gitignore
├── src/
│   ├── rules.js
│   ├── storage.js
│   └── engine.js
└── data/
    └── main.json   # 如果你本来就把存档放在 repo；长期不建议这样做
```

---

## D. Render 环境变量

在 Render → Service → Environment：

- `TRPG_API_KEY`：换成一个全新的长随机字符串
- `DATA_DIR`：
  - 普通测试可以是 `./data`
  - 如果使用 Render Persistent Disk，建议设成该磁盘的 mount path，例如 `/var/data`（以你实际设置为准）

Render 会自己提供 `PORT`，通常不需要手工固定。

由于旧真实 API key 曾经放在 `.env.txt`，请不要继续使用旧 key。

---

## E. GitHub 更新步骤

1. 新建备份 branch/tag。
2. 删除 GitHub 中任何包含真实密钥的 `.env.txt`（如果曾经提交过）。
3. 替换：`server.js`、`openapi.yaml`、`CUSTOM_GPT_INSTRUCTIONS_ADDON.md`、`.gitignore`。
4. 新建 `src/` 并上传 3 个 js 文件。
5. 可选：替换 `package.json`、`.env.example`、`README.md`。
6. 本地执行：

```bash
npm install
npm run check
npm start
```

7. 本地检查：

```bash
curl http://localhost:3000/health
```

应看到类似：

```json
{"ok":true,"engine_version":"2.0.0","schema_version":2}
```

---

## F. Render 重新部署后测试

先测：

```bash
curl https://YOUR-DOMAIN/health
```

然后用新的 Bearer key 读取原存档：

```bash
curl -H "Authorization: Bearer YOUR_NEW_KEY" \
  https://YOUR-DOMAIN/campaigns/main
```

如果旧存档存在，第一次读取时服务器会把旧 player/stat/resource 格式尽量正规化成 v2。

注意：先不要测试 `initialize` 覆盖旧 main；它默认会在已有 campaign 时返回 409，避免意外清档。

---

## G. Custom GPT Action 更新

1. 打开 Custom GPT → Configure → Actions。
2. Authentication 继续选择 API Key / Bearer。
3. 把 key 改成 Render 中新的 `TRPG_API_KEY`。
4. 打开 v2 `openapi.yaml`。
5. 把：

```text
https://REPLACE-WITH-YOUR-DEPLOYED-DOMAIN
```

替换成真实 Render HTTPS 域名。
6. 把完整 YAML 贴进 Action schema。
7. 确认能看到这些 operation：
   - `loadCampaignContext`
   - `initializeCampaign`
   - `updateCampaignNarrative`
   - `runAttributeCheck`
   - `applyResourceChange`
   - `createDynamicEnemy`
   - `createDynamicAbility`
   - `startCombat`
   - `resolveCombatAction`
8. 把旧 Instructions 中 “GPT 自己投骰/计算伤害” 的部分删除，改用 v2 `CUSTOM_GPT_INSTRUCTIONS_ADDON.md`。

---

## H. 最小测试流程

### 1. 读取存档
叫 GPT：
“读取 main 存档并告诉我角色当前 HP/CE。”

### 2. 骰子测试
如果 Technique=60，让 GPT 做普通难度检定。
服务器应给：
- base dice = 3
- 3d20
- 取最高

### 3. 动态敌人
叫 GPT：
“生成一只 Grade 3、速度型、以镜子为主题的咒灵。”

GPT 应调用 `createDynamicEnemy`，而不是自己写具体 HP/属性。

### 4. 动态技能
叫 GPT：
“让这个敌人拥有一个中等威力、中等消耗、Technique 型镜面攻击。”

GPT 应调用 `createDynamicAbility`，并把返回的 ability id 加到该敌人。

### 5. 战斗
让 GPT 开战。
应调用 `startCombat`，随后每回合调用 `resolveCombatAction`。

检查：
- 命中骰是否由服务器返回
- CE 是否由服务器扣除
- Damage 是否由服务器掷出
- HP 是否由服务器修改
- current_actor 是否自动前进

---

## I. v2 目前有意保持简单的地方

第一版先不实现：
- 复杂 Status Effect tick
- 自动敌人 AI 决策
- 装备/护甲独立减伤
- 冷却时间
- 领域展开特殊规则
- 黑闪特殊规则
- 复杂位置/距离系统

这些适合在 v2 稳定后加入，避免一次改太多导致 Debug 困难。

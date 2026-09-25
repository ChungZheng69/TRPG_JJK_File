# JJK TRPG Engine API v2

这是旧 Save API 的向后兼容升级版。

## 主要能力
- 读取 campaign
- 初始化 campaign
- Narrative-only 更新
- 属性检定：每 20 属性 = 1d20，最多 5d20，取最高
- HP / CE 权威修改
- AI 提供概念、Engine 生成数值的动态敌人
- AI 提供概念、Engine 生成数值的动态技能
- 回合制战斗：命中、CE、伤害/治疗、HP、击倒、回合推进

## 快速开始

```bash
cp .env.example .env
npm install
npm run check
npm start
```

健康检查：

```bash
curl http://localhost:3000/health
```

详细升级步骤请看 `MIGRATION_GUIDE_CN.md`。

## Custom GPT

1. 在 `openapi.yaml` 替换 Render HTTPS 域名。
2. Actions 使用 Bearer API key。
3. 把 `CUSTOM_GPT_INSTRUCTIONS_ADDON.md` 内容放进 GPT Instructions。

## 数据存储

默认使用 `DATA_DIR=./data` 的 JSON 文件。
长期部署请使用持久磁盘或后续升级到数据库，否则云服务重启/重新部署可能导致本地文件丢失。

# JJK TRPG Save API

这个项目只有两个接口：

- `GET /campaigns/{campaignId}`：读取存档
- `PUT /campaigns/{campaignId}`：保存完整的紧凑状态

它不投骰，也不处理战斗。

## 各部分放在哪里

### 你的服务器 / GitHub 项目

这些文件运行在 ChatGPT 外部：
- `server.js`
- `package.json`
- `.env`
- `data/main.json`

把整个文件夹部署到能够提供公开 HTTPS 地址的服务器。

### Custom GPT → Configure → Actions

把 `openapi.yaml` 内容贴进去。

先把：
`https://REPLACE-WITH-YOUR-DEPLOYED-DOMAIN`

替换成你的真实 HTTPS 地址。

### Custom GPT → Instructions

追加 `CUSTOM_GPT_INSTRUCTIONS_ADDON.md` 的内容。

## 本地测试

1. 安装 Node.js 20+
2. 把 `.env.example` 复制为 `.env`
3. 设置一个很长的 `TRPG_API_KEY`
4. 执行：

```bash
npm install
npm start
```

测试：

```bash
curl http://localhost:3000/health
```

```bash
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:3000/campaigns/main
```

## 连接 Custom GPT

1. 在 GPT 编辑器中往下滚到 **Actions**。
2. 选择 **Create new action**。
3. Authentication 选择 **API Key**。
4. 类型选择 **Bearer**。
5. 输入与 `TRPG_API_KEY` 相同的值。
6. 贴入修改后的 `openapi.yaml`。
7. 在 Preview 测试两个 action。

## 储存提醒

内附 JSON 适合本地与早期测试。很多云端主机的普通本地文件在重启或重新部署时可能丢失；长期使用时应配置持久磁盘或小型持久数据库。

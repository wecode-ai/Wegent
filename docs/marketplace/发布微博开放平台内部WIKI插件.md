---
sidebar_position: 3
---

# 发布「微博开放平台内部WIKI」到企业内部市场

拉 Wegent 代码并执行数据库迁移**不会**自动出现该插件。
需要在本机（或目标环境）对 Backend 再执行一次官方发布：把插件 ZIP 写入对象存储，并写入 `plugins` / `plugin_releases`。

发布后会出现在 Wework 插件市场的 **企业内部** Tab（`visibility=workspace`）。

展示名：**微博开放平台内部WIKI**；slug：`weibo-api-wiki`。

## 前置条件

1. Wegent 仓库已拉到最新，Backend 可连本机/目标 MySQL。
2. Alembic 已升级：`cd backend && uv run alembic upgrade head`。
3. 插件对象存储（S3/MinIO）已按 Backend `.env` 配置且可写。
4. 与 Wegent **同级**检出 `wework-plugins`（含 `plugins/weibo-api-wiki`）。
   即目录布局为 `ai3c_workspace/Wegent` 与 `ai3c_workspace/wework-plugins`。

### 检出插件源码仓库

在 Wegent 仓库的上一级目录执行：

```bash
git clone ssh://git@git.intra.weibo.com:2222/weibo_rd/common/wecode/wework-plugins.git \
  wework-plugins
cd wework-plugins && git pull
```

确认目录存在：

```bash
ls ../wework-plugins/plugins/weibo-api-wiki/.codex-plugin/plugin.json
# 若当前在 Wegent/backend 下，则为：
# ls ../../wework-plugins/plugins/weibo-api-wiki/.codex-plugin/plugin.json
```

当前版本见该文件中的 `"version"` 字段（例如 `0.2.0`）。

## 发布步骤

在 Wegent 仓库内：

```bash
cd backend

# wework-plugins 与 Wegent 同级时，从 backend/ 出发用 ../../wework-plugins
# 1）可选：只打包扫描，不写库
uv run python scripts/publish_official_plugin.py \
  ../../wework-plugins/plugins/weibo-api-wiki \
  --slug weibo-api-wiki \
  --listing-type plugin \
  --visibility workspace \
  --dry-run

# 2）正式发布（企业内部）
uv run python scripts/publish_official_plugin.py \
  ../../wework-plugins/plugins/weibo-api-wiki \
  --slug weibo-api-wiki \
  --listing-type plugin \
  --visibility workspace \
  --created-by-user-id 1 \
  --publisher local-dev
```

成功时 stdout 类似：

```json
{
  "created": true,
  "name": "weibo-api-wiki",
  "version": "0.1.0",
  "pluginId": 6,
  "releaseId": 9,
  "storageKey": "plugins/.../....zip"
}
```

说明：

- `--visibility workspace` → 桌面端「企业内部」。
- 同一 `slug + version + SHA256` 可幂等重试；**同版本改了内容会失败**，需在源码里升 SemVer 后再发。
- **不要**把 Cookie / `.env` 打进插件包；扫描会拒绝敏感文件。
- **不要**给该插件配 `plugin_upstreams`（那是 GitHub 等 mirror 用的）。

## 验证

```sql
SELECT id, slug, source_type, source_provider, visibility, status, latest_release_id
FROM plugins
WHERE slug = 'weibo-api-wiki';

SELECT id, version, status, scan_status, storage_key
FROM plugin_releases
WHERE plugin_id = (SELECT id FROM plugins WHERE slug = 'weibo-api-wiki')
ORDER BY id DESC;
```

期望：

| 字段 | 值 |
| --- | --- |
| `source_type` | `native` |
| `source_provider` | `wework` |
| `visibility` | `workspace` |
| `status` | `published` |
| `scan_status` | `passed` |
| `storage_key` | 非空 |

然后打开 Wework → **插件** → **企业内部** → 应能看到 **微博开放平台内部WIKI**。

## 运行时注意

登录由 Wework **原生 `local_qr` Connector**（`weibo-wiki`）完成，不再使用内置
浏览器，也不再由 LLM 编排扫码：

1. **安装时**：`authPolicy=on_install` 会弹出扫码窗；只有登录成功才完成安装。
2. **聊天查询前**：宿主对插件执行 `health`；失效时在主对话区显示二维码卡片，
   成功后自动发送原任务。
3. **中途过期**：CLI 返回结构化 `connector_auth_required`；宿主显示同一卡片并
   自动重试。
4. 会话保存在本机系统凭据库（Keychain / DPAPI / Secret Service），不进入云端
   Connector token。

手动清理本机会话：

```bash
sh scripts/run-weibo-wiki.sh auth logout
```

不要导出或粘贴 Cookie。Agent 不能代替用户完成扫码或授权。

## 相关文档

- 通用官方发布流程：[发布官方插件说明.md](./发布官方插件说明.md)
- 插件 README：`wework-plugins/plugins/weibo-api-wiki/README.md`
- 开发规范：[wework-plugin-marketplace-dev.md](../zh/wework/developer-guide/wework-plugin-marketplace-dev.md)

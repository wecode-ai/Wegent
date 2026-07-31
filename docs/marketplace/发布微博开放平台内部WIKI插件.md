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

当前版本见该文件中的 `"version"` 字段（例如 `0.1.0`）。

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

Wiki 仅支持浏览器扫码登录。安装插件后，每位开发者需要：

1. 浏览器打开 `http://wiki.intra.weibo.com/` 并扫码。
2. 导出 Cookie 到 `~/.wegent/weibo-wiki/cookies.txt`（可用 env `WEIBO_WIKI_COOKIE_PATH` 覆盖）。
3. 对话中先用 `$check-weibo-wiki` 测会话，再用 `$weibo-api-wiki` 查文档。

可选环境变量：

```bash
WEIBO_WIKI_BASE_URL=http://wiki.intra.weibo.com
WEIBO_WIKI_COOKIE_PATH=~/.wegent/weibo-wiki/cookies.txt
WEIBO_WIKI_CACHE_DIR=~/.wegent/weibo-wiki/cache
```

Agent **不能**代替用户完成扫码。会话过期后重新导出 Cookie 即可；本地 Markdown 缓存可继续离线检索。

## 相关文档

- 通用官方发布流程：[发布官方插件说明.md](./发布官方插件说明.md)
- 插件 README：`wework-plugins/plugins/weibo-api-wiki/README.md`
- 开发规范：[wework-plugin-marketplace-dev.md](../zh/wework/developer-guide/wework-plugin-marketplace-dev.md)

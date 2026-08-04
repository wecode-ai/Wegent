---
sidebar_position: 2
---

# 发布 EchoID 到企业内部市场

拉 Wegent 代码并执行数据库迁移**不会**自动出现 EchoID。  
需要在本机（或目标环境）对 Backend 再执行一次官方发布：把插件 ZIP 写入对象存储，并写入 `plugins` / `plugin_releases`。

发布后会出现在 Wework 插件市场的 **企业内部** Tab（`visibility=workspace`）。

## 前置条件

1. Wegent 仓库已拉到最新，Backend 可连本机/目标 MySQL。
2. Alembic 已升级：`cd backend && uv run alembic upgrade head`。
3. 插件对象存储（S3/MinIO）已按 Backend `.env` 配置且可写。
4. 与 Wegent **同级**检出 `wework-plugins`（含 `plugins/echoid`）。

### 检出插件源码仓库

EchoID 属于**企业内部**插件，源码在内网仓（与 GitHub 公开仓内容不同，不要从公开仓发）：

```bash
git clone ssh://git@git.intra.weibo.com:2222/weibo_rd/common/wecode/wework-plugins.git \
  ../wework-plugins
cd ../wework-plugins && git pull
```

确认目录存在：

```bash
ls ../wework-plugins/plugins/echoid/.codex-plugin/plugin.json
```

当前汉化目录版本见该文件中的 `"version"` 字段（例如 `0.1.1`）。

## 发布步骤

在 Wegent 仓库内：

```bash
cd backend

# 1）可选：只打包扫描，不写库
uv run python scripts/publish_official_plugin.py \
  ../wework-plugins/plugins/echoid \
  --slug echoid \
  --listing-type plugin \
  --visibility workspace \
  --dry-run

# 2）正式发布（企业内部）
uv run python scripts/publish_official_plugin.py \
  ../wework-plugins/plugins/echoid \
  --slug echoid \
  --listing-type plugin \
  --visibility workspace \
  --created-by-user-id 1 \
  --publisher local-dev
```

成功时 stdout 类似：

```json
{
  "created": true,
  "name": "echoid",
  "version": "0.1.1",
  "pluginId": 5,
  "releaseId": 8,
  "storageKey": "plugins/.../....zip"
}
```

说明：

- `--visibility workspace` → 桌面端「企业内部」。公开仓插件应使用 `public`（Wework官方 Tab），不要把 EchoID 发成 `public`。
- 同一 `slug + version + SHA256` 可幂等重试；**同版本改了内容会失败**，需在源码里升 SemVer 后再发。
- **不要**手工 `INSERT` `plugin_releases`，也**不要**给 EchoID 配 `plugin_upstreams`（那是 GitHub 等 mirror 用的）。

## 验证

```sql
SELECT id, slug, source_type, source_provider, visibility, status, latest_release_id
FROM plugins
WHERE slug = 'echoid';

SELECT id, version, status, scan_status, storage_key
FROM plugin_releases
WHERE plugin_id = (SELECT id FROM plugins WHERE slug = 'echoid')
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
| `storage_key` | 非空（安装时从对象存储下载，不是 git 镜像地址） |

然后打开 Wework → **插件** → **企业内部** → 应能看到 **EchoID**，安装后即可使用。

## 运行时注意

EchoID 需要 Agent 运行时可访问的 `/api/v1` 服务。如需改地址：

```bash
ECHOID_BASE_URL=http://echoid-host:14008
ECHOID_TOKEN=   # 可选
```

建议先用 `$check-echoid` 测连通，再用 `$echoid` 提交媒体与转写稿。

## 相关文档

- 通用官方发布流程：[发布官方插件说明.md](./发布官方插件说明.md)
- 插件源码仓库 README：`wework-plugins/README.md`

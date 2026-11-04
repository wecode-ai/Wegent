---
sidebar_position: 35
---

# 打包和发布文档技能

`backend/skill_catalogs/document.json` 定义五个普通 Skill ZIP。Chat 使用带 provider
和工具的 `document`，ClaudeCode 和 Codex 使用 `docx`、`xlsx`、`pptx`、`pdf`。
设备通过标准 Skill 下载接口读取所选包，并按内容哈希缓存。每轮执行使用自己的技能
快照。

从受信任的技能源取得完整、版本固定的包。`chat` 源根目录应包含原始
`document/`，`native` 源根目录应包含四种格式的完整技能目录。

```bash
cd backend
uv run python scripts/package_skill_catalog.py skill_catalogs/document.json \
  --source chat=/release/chat-skills \
  --source native=/release/native-skills \
  --output-dir /release/document-skill-zips
```

脚本在本地校验所有包，再将 ZIP 写入一个新的输出目录。它不需要连接 Backend 或配置数据库。

管理员在现有技能管理界面逐个上传 ZIP。首次发布可使用
`POST /api/v1/kinds/skills/public/upload`，并按界面要求选择市场标签。
若技能已经存在，用 `PUT /api/v1/kinds/skills/public/{skill_id}/upload`
更新原有 ID。保留上一次发布使用的原始 ZIP，需要恢复版本时可逐个上传旧包。
发布接口可能清理下载包中的 MCP 声明，恢复时使用原始发布包。

发布包与绑定分开处理。已有 Chat `document` 绑定继续使用原 ID。
需要在 ClaudeCode 或 Codex 中使用文档功能时，通过常规技能配置启用需要的格式。
若原生智能体、模板或默认技能已显式预加载 `document`，先通过对应的管理界面
替换为所需格式，再更新 `document` 为 Chat 专用版本。个人及群组原有绑定的
启用状态、例外和预加载设置由各自的配置保留。发布包不会批量改写绑定。

聚焦测试验证 ZIP 的 Shell 元数据、资源完整性和可重复打包。现有
`claude-runtime` 桌面检查点通过标准 API 上传并使用两版普通格式技能，
验证共享 Home 下并发执行各自读取正确版本的技能和资源。

---
sidebar_position: 35
---

# 技能资产发布与绑定迁移

技能正文、脚本和资源由外部技能源维护。Backend 保存普通 Skill ZIP，Executor
通过标准下载接口和内容哈希缓存，将所选技能链接到每次执行的私有快照。
智能体 Home、会话历史继续共享；发布新包不会改变已运行执行的包。
设备镜像不再预装 document 专用技能目录。

## 文档技能升级

`backend/skill_catalogs/document.json` 是发布清单，不是运行时依赖协议。
它发布 Chat 专用 `document` 和设备端普通 `docx`、`xlsx`、`pptx`、`pdf`。
从技能市场或技能仓库取得完整、经过审核的源包，固定发布使用的版本。
`chat` 源根目录下应有原始 Chat `document/`（包括 provider 和工具）；
`native` 源根目录下应有四种完整格式技能目录。不要只复制 `SKILL.md`。

在目标环境使用正常的 Backend 数据库配置，在发布维护窗口执行：

```bash
cd backend
uv run python scripts/publish_skill_catalog.py skill_catalogs/document.json \
  --source chat=/release/chat-skills \
  --source native=/release/native-skills
```

默认执行完整验证并回滚。检查输出中的数据库、资源 ID 和绑定记录后，使用同一批
源包追加 `--apply` 写入。需要指定配置文件时加 `--env-file /release/backend.env`。
新环境先完成普通资源初始化，再执行同一发布命令；现有环境也必须执行此步骤。
该操作不会在请求时访问外部仓库，也不会修改开发者的本地技能源。

发布复用 Skill 校验和保存服务，保持公共资源的 ID 不变，在同一事务中迁移
Ghost、SkillBinding、InstalledSkill 和 Template 的准确引用。用户自建同名技能、
已有目标绑定、绑定例外、强制预加载和停用状态会保留。普通绑定同时保留 Chat
document 与四种格式技能，由实际 Shell 选择兼容项；显式不兼容选择仍报错。
个人和群组 SkillBinding 使用现有管理接口的标准命名，迁移后仍可修改设置、停用和
恢复。上一版生成的 `catalog-*` 绑定原位改名；若标准绑定已存在，保留其设置并
停用旧别名。群组目标按整个群组查找，避免因创建人不同而重复创建绑定。

Chat Ghost 的显式预加载保持不变；仅供原生 Shell 使用的 Ghost 和模板将文档
预加载替换为兼容格式技能。若同一个 Ghost 在 Chat 和原生 Shell 之间共享了
document 的强制预加载，发布会报出准确 Ghost ID 并回滚整个事务：先拆分其
显式预加载绑定再发布。不要跳过该错误或删除校验。发布前备份目标 Skill ZIP
和受影响的 Kind JSON；回退应用代码不会自动回退数据库中的技能版本与绑定。

## 验证

聚焦测试覆盖新环境、原位升级、回滚、重复发布、同名私有技能、停用和预加载。
真实并发回归位于现有 `claude-runtime` 桌面 E2E 场景：通过标准接口上传四种
格式技能的两个版本，验证资源完整、Home 共享、执行配置和技能快照隔离。
GitHub `wework-e2e.yml` 运行该场景，同时验证迁移后可以通过标准接口修改、
停用和恢复技能绑定。

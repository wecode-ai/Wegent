---
sidebar_position: 6
---

# Skill 创建智能体设计

## 目标

新增一个内置公开智能体，基于现有官方 `skill-creator` Skill，帮助用户创建、迭代并上传 Skill。创建完成后，智能体必须通过交互卡片让用户选择上传目标，再把 Skill 发布到用户个人或群组 Skill 库。

用户体验目标：

- 用户选择该智能体后，可以直接说“帮我创建一个 Skill”。
- 智能体遵循 `skill-creator` 的创建流程，不绕过校验和打包。
- 发布前使用卡片选择上传位置，而不是普通文本追问。
- 默认上传到个人 Skill 库；支持选择可管理群组；保留自定义 namespace 入口。
- 已存在同名 Skill 时，使用二次确认卡片决定是否覆盖。

## 当前状态

项目已有以下基础能力：

- `backend/init_data/skills/skill-creator/`：内置公开 Skill，包含 `SKILL.md`、初始化、校验、打包、导出和发布脚本。
- `backend/init_data/skills/skill-creator/scripts/publish_skill.sh`：读取 `TASK_INFO` 中的任务 token，通过 `/api/v1/kinds/skills/upload` 上传到用户 Skill 库，支持 namespace 和 `--overwrite`。
- `backend/init_data/skills/interactive-form-question/`：提供 `interactive_form_question` 工具，支持在 Chat、Agno、ClaudeCode 中渲染选择卡片。
- `/api/v1/kinds/skills/upload`：上传个人或群组 Skill。
- `/api/groups`：返回当前用户参与的群组及 `my_role`，可用于筛选可写入目标。
- `backend/init_data/02-public-resources.yaml`：内置公开 Ghost、Bot、Team 的初始化来源。

因此本次不需要新增 Skill 上传 API 或新的前端卡片协议。

## 方案

采用现有 `interactive-form-question` 作为发布目标选择卡片。

新增公开资源：

- `skill-creator-ghost`
- `skill-creator-bot`
- `skill-creator-team`

`skill-creator-ghost` 使用 ClaudeCode 运行场景，绑定以下 Skills：

- `skill-creator`
- `interactive-form-question`
- `ui-links`

`skill-creator` 负责创建、校验、打包和发布。`interactive-form-question` 负责发布目标和覆盖确认。`ui-links` 用于发布成功后输出设置页导航链接。

## 智能体行为

系统提示词要求智能体按以下顺序工作：

1. 理解用户要创建或更新的 Skill，必要时用 `interactive_form_question` 收集需求。
2. 按 `skill-creator` 指令创建 Skill 目录、资源文件和 `SKILL.md`。
3. 运行 `quick_validate.py` 校验 Skill。
4. 需要发布时，先构建发布目标选项：
   - 固定选项：个人 Skill 库，值为 `default`。
   - 动态选项：当前用户有 Owner 或 Maintainer 权限的群组 namespace。
   - 兜底选项：自定义 namespace。
5. 调用 `interactive_form_question` 展示发布目标选择卡片。
6. 根据用户选择调用 `publish_skill.sh <skill_path> <skill_name> <namespace>`。
7. 如果脚本返回同名 Skill 已存在，调用二次确认卡片；用户确认后追加 `--overwrite` 重新发布。
8. 发布成功后返回 Skill 名称、ID、namespace，并输出跳转到设置页 Skill 管理入口的 `wegent://open/settings` 链接。

## 群组目标发现

优先在 `skill-creator` Skill 中补一个轻量脚本，例如 `scripts/list_publish_targets.sh`。脚本职责：

- 从 `TASK_INFO` 读取 `auth_token`。
- 从 `TASK_API_DOMAIN` 读取 Backend 地址。
- 调用 `/api/groups?limit=100`。
- 输出 JSON：

```json
{
  "targets": [
    {"label": "个人 Skill 库", "namespace": "default", "type": "personal"},
    {"label": "团队 A", "namespace": "team-a", "type": "group", "role": "Owner"}
  ]
}
```

脚本只把 `Owner` 和 `Maintainer` 群组加入推荐目标。自定义 namespace 仍允许用户输入，但最终权限由上传 API 和后端服务校验。

如果群组接口不可用或解析失败，智能体仍可展示个人 Skill 库和自定义 namespace 两个选项，并说明群组列表暂时无法自动读取。

## 发布确认卡片

目标选择卡片使用单选：

- 问题：`请选择 Skill 上传位置`
- 选项：
  - `个人 Skill 库`
  - 动态群组列表
  - `自定义 namespace`

如果用户选择自定义 namespace，再展示文本输入卡片。

覆盖确认卡片使用单选：

- 问题：`目标位置已存在同名 Skill，是否覆盖？`
- 选项：
  - `覆盖并发布`
  - `取消发布`

默认推荐取消，避免意外覆盖。

## 后端和初始化资源

在 `backend/init_data/02-public-resources.yaml` 新增一组公开 CRD：

- Ghost：包含 Skill 创建和发布流程提示词。
- Bot：引用该 Ghost 和公开 `ClaudeCode` Shell。
- Team：solo 模式，`bind_mode: ["task"]`，显示名建议为 `Skill Creator` 或 `Skill 创建助手`。

不新增表结构，不新增上传接口，不改变 Skill 查找优先级。

## Skill 包调整

更新 `backend/init_data/skills/skill-creator/SKILL.md`：

- 明确 Wegent 场景下创建完成后应使用交互卡片选择发布目标。
- 引用 `scripts/list_publish_targets.sh`，指导智能体生成目标卡片选项。
- 保留现有 `publish_skill.sh` 发布流程。

新增 `scripts/list_publish_targets.sh`：

- 依赖现有 `common.sh` 的认证和 API Base 解析逻辑。
- 使用 `curl` 和 `jq`，与 `publish_skill.sh` 保持一致。
- 输出机器可读 JSON，减少智能体解析文本的错误。

## 权限边界

- 个人空间始终使用 `namespace=default`，上传后 Skill 属于当前用户。
- 群组空间只推荐 Owner/Maintainer 群组。
- 自定义 namespace 不在前端或脚本中做强行通过；后端继续做权限校验。
- 公共 Skill 上传仍只允许管理员路径，本智能体不提供公共发布能力。
- 覆盖已有 Skill 必须经过用户确认。

## 错误处理

- 缺少 `TASK_INFO` 或 token：提示当前任务无法直接发布，只能导出 ZIP。
- `/api/groups` 失败：降级为个人空间和自定义 namespace。
- Skill 校验失败：先修复 Skill 内容，不进入发布卡片。
- 上传失败：展示后端错误，并建议重新选择 namespace 或启用覆盖。
- 覆盖被取消：保留本地 Skill 目录，不继续发布。

## 测试

后端测试：

- 初始化 YAML 能解析新增 Ghost/Bot/Team。
- 新 Ghost 的 `spec.skills` 包含 `skill-creator` 和 `interactive-form-question`。
- `skill-creator` 包新增脚本后仍能通过 Skill ZIP 校验。

脚本测试：

- `list_publish_targets.sh` 在缺少认证时返回清晰错误。
- mock `/api/groups` 响应时，只输出 `Owner` 和 `Maintainer` 群组。
- `publish_skill.sh` 现有发布和覆盖路径不被破坏。

运行验证：

- 运行相关 Python 测试。
- 至少用脚本级 mock 验证目标 JSON 输出。

## 非目标

- 不新增专用前端卡片类型。
- 不新增数据库表。
- 不实现公共 Skill 发布。
- 不重构 Skill 上传 API。
- 不改变现有设置页 Skill 管理体验。

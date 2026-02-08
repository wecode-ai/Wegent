---
sidebar_position: 16
---

# 会话级工作目录（本地设备执行器）

本文档把“本地设备执行器（ClaudeCode）支持为不同会话设置不同工作目录”的方案落实为可实现的产品与工程设计，包含现状、目标、数据契约、安全边界与分阶段交付计划。

---

## 背景与问题

Wegent 已支持将 Claude Code 包装为本地设备执行器（Local Executor），把用户电脑当作执行设备。现有实现会将代码、附件、Claude 配置与部分会话状态统一放在设备的 `LOCAL_WORKSPACE_ROOT/<task_id>/` 下，并在 Claude SDK 客户端创建时设置 `cwd`。

需求：用户希望能为不同会话选择不同工作目录，例如：

- A 会话固定在目录 A（例如 `~/Projects/A`）
- B 会话固定在目录 B（例如 `~/Projects/B`）

---

## 现状（代码行为摘要）

> 说明：以下为当前仓库代码的真实行为总结，便于理解为什么需要改造。

### 目录与 `cwd` 的来源

- 后端下发给执行器的 `task_data` **不包含**工作目录字段；数据组装位于 `backend/app/services/adapters/executor_kinds.py` 的 `_format_subtasks_response()`。
- Local 模式的默认工作区根目录来自 `executor/config/config.py`：
  - `LOCAL_WORKSPACE_ROOT`（默认 `~/.wegent-executor/workspace`）
  - `get_workspace_root()` 在 Local 模式返回 `LOCAL_WORKSPACE_ROOT`
- ClaudeCode 的 `cwd` 目前主要来自两处：
  1) bot 配置：`executor/agents/claude_code/config_manager.py` 的 `extract_claude_options()` 会读取 bot_config 里的 `cwd` 写入 `options["cwd"]`
  2) fallback：`executor/agents/claude_code/claude_code_agent.py` 的 `_create_and_connect_client()` 若 `options["cwd"]` 为空，则设置为 `WORKSPACE_ROOT/<task_id>/`

### 与目录强耦合的组件

- Git clone：`executor/agents/base.py` 的 `download_code()` 默认 clone 到 `WORKSPACE_ROOT/<task_id>/<repo_name>/`
- 附件下载：`executor/agents/claude_code/attachment_handler.py` 默认下载到 `WORKSPACE_ROOT/<task_id>/`
- Claude 会话文件：`executor/agents/claude_code/session_manager.py` 将 `.claude_session_id` 放在 `WORKSPACE_ROOT/<task_id>/`
- Claude 配置目录（Local mode strategy）：`executor/agents/claude_code/local_mode_strategy.py` 使用 `WORKSPACE_ROOT/<task_id>/.claude/`

结论：目前“每个 task_id 一套隔离目录”是成立的，但“用户把会话绑定到任意本机目录”尚未打通，并且 clone/附件/会话文件等仍默认落在 `WORKSPACE_ROOT/<task_id>/`。

---

## 目标与非目标

### 目标（Goals）

- 支持为**每个会话（Task）**配置工作目录（Workdir），并在本地设备执行器中使用该目录作为 Claude 的 `cwd`
- Workdir 与设备绑定（同一个 Task 未来可能在不同设备执行；路径只对某一设备有意义）
- 安全：路径输入不可信，必须有**设备侧 allowlist**与**逃逸防护**
- 兼容：未设置 workdir 的历史任务保持现有行为

### 非目标（Non-goals）

- 不在 Phase 1 追求把所有产物（clone/附件/会话文件）都迁移到用户目录；先把“Claude 工作目录”打通
- 不在后端做跨设备的“本机路径同步”；本机路径只在单台设备语义成立

---

## 产品设计（Proposed）

### 绑定模型

建议将 Workdir 视为“会话级配置”，并与设备关联：

- 绑定键：`(task_id, device_id)`
- 显示与复用：在会话详情中展示当前 workdir；当同一任务继续对话时（同 device_id）自动复用

### 策略（Policy）

UI 可提供三种策略（默认第一种）：

1) **Managed（自动管理）**：沿用 `LOCAL_WORKSPACE_ROOT/<task_id>/`
2) **Existing（使用已有目录）**：用户指定本机绝对路径（如 `~/Projects/foo`）
3) **Repo Bound（仓库绑定目录）**（后置）：将 `(git_url, branch)` 绑定到一个本机目录，后续新会话可一键复用

### 切换规则

当会话运行中变更 workdir 时，建议默认策略为：

- 触发 `close-session`（结束旧 Claude 会话/进程）
- 以新 workdir 创建新 Claude client（避免复用旧 session 导致路径与上下文混乱）

---

## 安全设计（必须）

### 设备侧 Allowlist Roots

本机路径输入必须视为不可信。设备执行器需要配置允许访问的根目录列表：

- 新增环境变量：`LOCAL_WORKDIR_ALLOWED_ROOTS`
- 示例：`LOCAL_WORKDIR_ALLOWED_ROOTS="~/.wegent-executor/workspace,~/Projects"`
- 默认值：仅允许 `LOCAL_WORKSPACE_ROOT`

### 路径校验（建议要求）

workdir 在 executor 侧解析为 “effective cwd” 前必须满足：

- 规范化：展开 `~`、转换为绝对路径、`realpath` 解析符号链接
- 禁止逃逸：拒绝不在 allowlist roots 下的路径（包含 symlink 逃逸）
- 可选：拒绝系统敏感目录（例如 `/`, `/System`, `~/.ssh` 等），作为额外防线

失败策略：校验失败时回退到 `Managed`（`WORKSPACE_ROOT/<task_id>/`），并通过 thinking/progress 明确告知用户回退原因。

---

## 工程设计（Proposed）

### 数据契约（Backend → Local Executor）

Phase 1 建议先在 `task_data` 增加字段（示例）：

```json
{
  "task_id": 123,
  "device_id": "mac-mini-1",
  "workdir": "/Users/alice/Projects/foo",
  "workdir_policy": "existing"
}
```

同时将其写入 Task CRD（仅用于“同设备继续会话时复用”，不作为跨设备语义）。

### executor 侧入口

建议新增一个单一职责模块（示例命名）：

- `executor/utils/workdir_resolver.py`
  - 输入：`task_id`, `device_id`, `requested_workdir`, `policy`, `LOCAL_WORKDIR_ALLOWED_ROOTS`
  - 输出：`effective_cwd`（string）或错误（用于 UI 提示）

并将解析结果统一注入到：

- Claude options 的 `cwd`
- 后续 Phase 2 的 clone/附件/会话持久化根目录

---

## 分阶段交付计划

### Phase 1（MVP）：会话级 `cwd`

目标：实现 “A 会话在 A 目录 / B 会话在 B 目录”，先只保证 Claude 的 `cwd` 正确。

- Backend
  - 扩展 `TaskCreate` 支持 `workdir/workdir_policy`（仅本地设备执行时启用）
  - 将字段写入 Task CRD spec（并与 `device_id` 一起存储）
  - 下发到本地设备：在 `_format_subtasks_response()` 把字段透传到 `task_data`
- Executor
  - 实现 allowlist + 路径校验与归一化
  - 将 `task_data.workdir` 写入 Claude options 的 `cwd`（优先级高于 bot 默认）
  - 失败回退到 `Managed`
- Frontend
  - 本地设备执行时提供 workdir 选择（Managed / Existing）
  - 展示当前 workdir（只读）
- 测试
  - executor：路径解析与逃逸防护单测（重点）
  - backend：字段贯通（create → spec → dispatch）测试

### Phase 2：产物对齐 workdir（体验完整）

目标：clone/附件/会话文件与 workdir 对齐，避免“cwd 在用户目录但附件在别处”的割裂。

- clone：在 `Existing/RepoBound` 策略下，将 repo 克隆/复用到 workdir（并校验 remote 匹配）
- 附件：下载到 `workdir/.wegent/attachments/...`
- 会话文件：迁移到 `workdir/.wegent/session/...`（保留一次性读取旧位置的迁移逻辑）
- Claude 配置：将 `.claude/` 放到 `workdir/.wegent/.claude/` 或通过 `CLAUDE_CONFIG_DIR` 指向 workdir 下隔离目录

### Phase 3：体验增强

- 最近使用目录列表（前端本地存储）
- Repo→本机目录绑定（设备设置项）
- 一键打开目录（可选，取决于安全策略与产品定位）

---

## 验收标准（Phase 1）

- 同一台设备上创建两个任务，分别设置不同 workdir，ClaudeCode 执行时 `cwd` 生效且互不影响
- workdir 不在 allowlist 下时，任务不写入该目录，并明确提示回退到 Managed
- 未设置 workdir 的任务行为与当前一致（兼容性）


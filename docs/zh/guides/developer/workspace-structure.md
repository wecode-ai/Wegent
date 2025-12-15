# Executor 工作目录结构

本指南介绍 Wegent Executor 的工作目录结构设计，支持多工程、多分支并行开发。

> **状态**: 已实现  
> **版本**: 1.1

## 概述

Executor 的工作目录结构设计用于支持：

1. **多工程支持**：用户可以在容器里同时操作多个工程
2. **多分支并行开发**：每个工程可以有多个分支同时开发
3. **跨工程需求**：一个需求可能涉及多个工程，同一需求共享分支名
4. **Claude 工作目录**：每个需求有一个独立的工作目录供 Claude 发挥

## 核心概念

### 1. 仓库（Repository）

代码仓库的 bare clone，只存储 Git 对象，不包含工作文件。多个 worktree 共享同一个仓库，节省磁盘空间。

### 2. 工作树（Worktree）

Git worktree 机制，允许同一仓库在不同目录检出不同分支。每个 worktree 是一个独立的工作目录，可以独立编译、测试。

### 3. 需求/特性（Feature）

一个业务需求，可能涉及多个仓库。同一需求下的所有仓库使用相同的分支名，有一个独立的工作目录供 Claude 使用。

### 4. 任务（Task）

用户下发的具体任务。任务下发时只有 task_id，分支名由 Claude 创建或用户指定。

### 5. 分支命名约定

系统中有两种分支概念，需要明确区分：

| 概念 | 字段名 | 说明 | 示例 |
|------|--------|------|------|
| **来源分支** | `branch_name` / `source_branch` | 用户选择的基础分支，代码从这个分支检出 | `develop`, `main`, `master` |
| **需求分支** | `feature_branch` | 新创建的功能分支名，用作 feature 目录名 | `feature-123-add-login` |

**工作流程**：
1. 用户在前端选择一个来源分支（如 `develop`）
2. 系统从来源分支检出代码
3. 如果指定了 `feature_branch`，则创建 feature 目录并基于来源分支创建新的功能分支
4. 如果没有指定 `feature_branch`，则创建 task 目录，Claude 可以稍后决定分支名

## 目录结构

```
/workspace/
├── repos/                          # 所有仓库的 bare clone
│   ├── github.com/
│   │   └── org/
│   │       ├── frontend.git/       # bare repository
│   │       └── backend.git/        # bare repository
│   └── gitlab.example.com/
│       └── team/
│           └── service.git/        # bare repository
│
├── features/                       # 按需求组织的工作目录
│   ├── feature-123-add-login/      # 需求目录（分支名）
│   │   ├── .feature.json           # 需求元数据
│   │   ├── frontend/               # worktree -> repos/github.com/org/frontend.git
│   │   ├── backend/                # worktree -> repos/github.com/org/backend.git
│   │   └── _workspace/             # Claude 的工作目录（临时文件、笔记等）
│   │
│   └── feature-456-fix-bug/        # 另一个需求
│       ├── .feature.json
│       ├── backend/
│       └── _workspace/
│
├── tasks/                          # 任务临时目录（用于任务初始化阶段）
│   └── task-789/                   # 任务 ID
│       ├── .task.json              # 任务元数据
│       └── _workspace/             # 任务初始工作目录
│
└── shared/                         # 共享资源
    ├── tools/                      # 共享工具
    └── cache/                      # 构建缓存等
```

## 工作流程

### 场景 1：新任务下发（无需求分支名）

```
任务下发 (task_id=789, git_url=xxx, branch_name=develop, feature_branch=null)
    │
    ▼
创建任务目录 /workspace/tasks/task-789/
    │
    ▼
从 develop 分支克隆代码到任务目录
    │
    ▼
Claude 分析任务，决定需求分支名 (如 feature-789-implement-xxx)
    │
    ▼
调用 convert_to_feature_workspace 转换为 feature 目录
    │
    ├─ 如果 feature 目录不存在：
    │   1. 创建 /workspace/features/feature-789-implement-xxx/
    │   2. 确保 bare repo 存在（clone 或复用）
    │   3. 基于 develop 分支创建 worktree 并检出新分支 feature-789-implement-xxx
    │
    └─ 如果 feature 目录已存在：
        1. 直接使用现有 worktree
        2. 可能需要 git pull 更新
    │
    ▼
设置 Claude 的 cwd 为 feature 目录
    │
    ▼
Claude 开始工作
```

### 场景 2：新任务下发（有需求分支名）

```
任务下发 (task_id=790, git_url=xxx, branch_name=develop, feature_branch=feature-123-add-login)
    │
    ▼
检查 feature 目录是否存在
    │
    ├─ 存在：直接使用
    │
    └─ 不存在：
        1. 创建 /workspace/features/feature-123-add-login/ 目录
        2. 基于 develop 分支创建 worktree 并检出新分支 feature-123-add-login
    │
    ▼
设置 Claude 的 cwd 为 feature 目录
```

### 场景 3：跨仓库需求

```
任务下发 (task_id=791, repos=[frontend, backend], branch_name=develop, feature_branch=feature-100-new-api)
    │
    ▼
创建 feature 目录 /workspace/features/feature-100-new-api/
    │
    ▼
为每个仓库创建 worktree（基于 develop 分支创建新分支）：
    ├─ frontend/ -> repos/github.com/org/frontend.git (branch: feature-100-new-api, base: develop)
    └─ backend/  -> repos/github.com/org/backend.git  (branch: feature-100-new-api, base: develop)
    │
    ▼
Claude 可以在 feature 目录下同时操作多个仓库
```

## 元数据文件

### .feature.json

```json
{
  "name": "feature-123-add-login",
  "created_at": "2024-01-15T10:00:00Z",
  "created_by_task": 789,
  "repositories": [
    {
      "name": "frontend",
      "git_url": "https://github.com/org/frontend.git",
      "branch": "feature-123-add-login",
      "worktree_path": "frontend",
      "bare_repo_path": "/workspace/repos/github.com/org/frontend.git",
      "source_branch": "develop"
    },
    {
      "name": "backend",
      "git_url": "https://github.com/org/backend.git",
      "branch": "feature-123-add-login",
      "worktree_path": "backend",
      "bare_repo_path": "/workspace/repos/github.com/org/backend.git",
      "source_branch": "develop"
    }
  ],
  "tasks": [789, 792, 795],
  "last_accessed": "2024-01-15T12:00:00Z"
}
```

### .task.json

```json
{
  "task_id": 789,
  "created_at": "2024-01-15T10:00:00Z",
  "feature_name": null,
  "status": "running",
  "prompt": "实现用户登录功能...",
  "git_url": "https://github.com/org/frontend.git",
  "branch_name": "develop"
}
```

> **注意**：`.task.json` 中的 `branch_name` 存储的是来源分支（source branch），而不是需求分支。当任务转换为 feature 时，`feature_name` 会被设置为需求分支名。

## 模块结构

workspace 模块位于 `executor/workspace/`：

```
executor/workspace/
├── __init__.py              # 模块入口，导出主要类
├── repo_manager.py          # Bare repository 管理
├── worktree_manager.py      # Git worktree 管理
├── feature_manager.py       # Feature 目录管理
└── workspace_setup.py       # 高级 API，工作空间设置
```

## 配置项

在 `executor/config/config.py` 中的配置：

```python
# 工作目录根路径
WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace")

# 子目录路径
REPOS_DIR = os.path.join(WORKSPACE_ROOT, "repos")
FEATURES_DIR = os.path.join(WORKSPACE_ROOT, "features")
TASKS_DIR = os.path.join(WORKSPACE_ROOT, "tasks")
SHARED_DIR = os.path.join(WORKSPACE_ROOT, "shared")

# 兼容模式开关
USE_LEGACY_WORKSPACE = os.environ.get("USE_LEGACY_WORKSPACE", "false").lower() == "true"

# 清理配置
TASK_WORKSPACE_MAX_AGE_HOURS = int(os.environ.get("TASK_WORKSPACE_MAX_AGE_HOURS", "24"))
FEATURE_WORKSPACE_MAX_AGE_DAYS = int(os.environ.get("FEATURE_WORKSPACE_MAX_AGE_DAYS", "7"))
```

## 使用方式

### 1. 基本使用（自动模式）

Agent 的 `download_code()` 方法会自动根据配置选择使用新结构或旧结构：

```python
class MyAgent(Agent):
    def pre_execute(self):
        # 自动使用新的 workspace 结构
        self.download_code()
        return TaskStatus.SUCCESS
```

### 2. 直接使用 WorkspaceSetup

```python
from executor.workspace import WorkspaceSetup

setup = WorkspaceSetup()

# 设置 feature 工作空间（有分支名）
result = setup.setup_workspace(
    task_id=123,
    git_url="https://github.com/org/repo.git",
    branch_name="feature-123-add-login",
    prompt="实现登录功能",
    git_token="xxx",
    git_login="user"
)

# 设置任务工作空间（无分支名）
result = setup.setup_workspace(
    task_id=456,
    git_url="https://github.com/org/repo.git",
    branch_name=None,  # Claude 会自己创建分支
    prompt="修复 bug"
)

# 检查结果
if result.success:
    print(f"工作目录: {result.workspace_path}")
    print(f"项目路径: {result.project_path}")
    print(f"是否 feature: {result.is_feature_workspace}")
```

### 3. 转换任务到 Feature

当 Claude 决定了分支名后，可以将任务工作空间转换为 feature 工作空间：

```python
# 在 Agent 中
success = self.convert_to_feature_workspace("feature-456-fix-bug")
if success:
    print(f"已转换为 feature: {self.feature_name}")
```

### 4. 跨仓库 Feature

```python
result = setup.setup_workspace(
    task_id=789,
    git_url="https://github.com/org/frontend.git",
    branch_name="feature-789-new-api",
    additional_repos=[
        {"git_url": "https://github.com/org/backend.git"},
        {"git_url": "https://github.com/org/common.git"}
    ]
)
```

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `WORKSPACE_ROOT` | `/workspace` | 工作目录根路径 |
| `USE_LEGACY_WORKSPACE` | `false` | 是否使用旧的目录结构 |
| `TASK_WORKSPACE_MAX_AGE_HOURS` | `24` | 任务目录最大保留时间（小时） |
| `FEATURE_WORKSPACE_MAX_AGE_DAYS` | `7` | Feature 目录最大保留时间（天） |

## 清理策略

### 自动清理规则

1. **任务目录**：任务完成后 24 小时自动清理
2. **Feature 目录**：
   - 最后活动时间超过 7 天的自动清理
   - 分支已合并到 main 的自动清理
3. **Bare Repository**：
   - 没有关联 worktree 的自动清理
   - 保留最近 30 天内使用过的

## 测试

运行测试：

```bash
cd executor
pytest tests/workspace/ -v
```

## 向后兼容

设置 `USE_LEGACY_WORKSPACE=true` 可以使用旧的目录结构，适用于：
- 迁移过渡期
- 调试问题
- 特殊场景

## 注意事项

1. **Git Token 加密**：系统会自动处理加密的 git token
2. **分支创建**：如果分支不存在，会自动基于 main/master 创建
3. **Worktree 清理**：删除 feature 时会正确清理 worktree 引用
4. **磁盘空间**：bare repository 共享可以显著节省磁盘空间

## 优势

1. **磁盘空间优化**：bare repository + worktree 避免重复存储
2. **分支隔离**：每个 feature 独立目录，互不干扰
3. **跨仓库支持**：同一 feature 可以包含多个仓库
4. **灵活的分支创建**：支持预指定和 Claude 自动创建
5. **清晰的目录结构**：按需求组织，易于理解和管理

## 更多信息

- [AGENTS.md - Executor 部分](../../../../AGENTS.md#executor)
- [测试指南](./testing.md)
- [开发环境搭建](./setup.md)
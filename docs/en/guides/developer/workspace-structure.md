# Executor Workspace Structure

This guide covers the workspace directory structure design for Wegent Executor, supporting multi-project and multi-branch parallel development.

> **Status**: Implemented  
> **Version**: 1.1

## Overview

The Executor workspace structure is designed to support:

1. **Multi-project support**: Users can work on multiple projects simultaneously in a container
2. **Multi-branch parallel development**: Each project can have multiple branches being developed in parallel
3. **Cross-project features**: A feature may span multiple projects, sharing the same branch name
4. **Claude workspace**: Each feature has an independent workspace for Claude to work in

## Core Concepts

### 1. Repository

A bare clone of the code repository, storing only Git objects without working files. Multiple worktrees share the same repository, saving disk space.

### 2. Worktree

Git worktree mechanism that allows the same repository to checkout different branches in different directories. Each worktree is an independent working directory that can be compiled and tested independently.

### 3. Feature

A business requirement that may involve multiple repositories. All repositories under the same feature use the same branch name and have an independent workspace for Claude.

### 4. Task

A specific task assigned by the user. When a task is assigned, it only has a task_id; the branch name is created by Claude or specified by the user.

### 5. Branch Naming Convention

There are two branch concepts in the system that need to be clearly distinguished:

| Concept | Field Name | Description | Example |
|---------|------------|-------------|---------|
| **Source Branch** | `branch_name` / `source_branch` | The base branch selected by the user, code is checked out from this branch | `develop`, `main`, `master` |
| **Feature Branch** | `feature_branch` | The newly created feature branch name, used as the feature directory name | `feature-123-add-login` |

**Workflow**:
1. User selects a source branch in the frontend (e.g., `develop`)
2. System checks out code from the source branch
3. If `feature_branch` is specified, create a feature directory and create a new feature branch based on the source branch
4. If `feature_branch` is not specified, create a task directory; Claude can decide the branch name later

## Directory Structure

```
/workspace/
├── repos/                          # Bare clones of all repositories
│   ├── github.com/
│   │   └── org/
│   │       ├── frontend.git/       # bare repository
│   │       └── backend.git/        # bare repository
│   └── gitlab.example.com/
│       └── team/
│           └── service.git/        # bare repository
│
├── features/                       # Working directories organized by feature
│   ├── feature-123-add-login/      # Feature directory (branch name)
│   │   ├── .feature.json           # Feature metadata
│   │   ├── frontend/               # worktree -> repos/github.com/org/frontend.git
│   │   ├── backend/                # worktree -> repos/github.com/org/backend.git
│   │   └── _workspace/             # Claude's workspace (temp files, notes, etc.)
│   │
│   └── feature-456-fix-bug/        # Another feature
│       ├── .feature.json
│       ├── backend/
│       └── _workspace/
│
├── tasks/                          # Task temporary directories (for task initialization)
│   └── task-789/                   # Task ID
│       ├── .task.json              # Task metadata
│       └── _workspace/             # Task initial workspace
│
└── shared/                         # Shared resources
    ├── tools/                      # Shared tools
    └── cache/                      # Build cache, etc.
```

## Workflows

### Scenario 1: New Task (No Feature Branch Name)

```
Task assigned (task_id=789, git_url=xxx, branch_name=develop, feature_branch=null)
    │
    ▼
Create task directory /workspace/tasks/task-789/
    │
    ▼
Clone code from develop branch to task directory
    │
    ▼
Claude analyzes task, decides feature branch name (e.g., feature-789-implement-xxx)
    │
    ▼
Call convert_to_feature_workspace to convert to feature directory
    │
    ├─ If feature directory doesn't exist:
    │   1. Create /workspace/features/feature-789-implement-xxx/
    │   2. Ensure bare repo exists (clone or reuse)
    │   3. Create worktree based on develop branch and checkout new branch feature-789-implement-xxx
    │
    └─ If feature directory exists:
        1. Use existing worktree directly
        2. May need git pull to update
    │
    ▼
Set Claude's cwd to feature directory
    │
    ▼
Claude starts working
```

### Scenario 2: New Task (With Feature Branch Name)

```
Task assigned (task_id=790, git_url=xxx, branch_name=develop, feature_branch=feature-123-add-login)
    │
    ▼
Check if feature directory exists
    │
    ├─ Exists: Use directly
    │
    └─ Doesn't exist:
        1. Create /workspace/features/feature-123-add-login/ directory
        2. Create worktree based on develop branch and checkout new branch feature-123-add-login
    │
    ▼
Set Claude's cwd to feature directory
```

### Scenario 3: Cross-Repository Feature

```
Task assigned (task_id=791, repos=[frontend, backend], branch_name=develop, feature_branch=feature-100-new-api)
    │
    ▼
Create feature directory /workspace/features/feature-100-new-api/
    │
    ▼
Create worktree for each repository (create new branch based on develop):
    ├─ frontend/ -> repos/github.com/org/frontend.git (branch: feature-100-new-api, base: develop)
    └─ backend/  -> repos/github.com/org/backend.git  (branch: feature-100-new-api, base: develop)
    │
    ▼
Claude can work on multiple repositories simultaneously in the feature directory
```

## Metadata Files

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
  "prompt": "Implement user login feature...",
  "git_url": "https://github.com/org/frontend.git",
  "branch_name": "develop"
}
```

> **Note**: The `branch_name` in `.task.json` stores the source branch, not the feature branch. When a task is converted to a feature, `feature_name` will be set to the feature branch name.

## Module Structure

The workspace module is located at `executor/workspace/`:

```
executor/workspace/
├── __init__.py              # Module entry, exports main classes
├── repo_manager.py          # Bare repository management
├── worktree_manager.py      # Git worktree management
├── feature_manager.py       # Feature directory management
└── workspace_setup.py       # High-level API, workspace setup
```

## Configuration

Configuration in `executor/config/config.py`:

```python
# Workspace root path
WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace")

# Subdirectory paths
REPOS_DIR = os.path.join(WORKSPACE_ROOT, "repos")
FEATURES_DIR = os.path.join(WORKSPACE_ROOT, "features")
TASKS_DIR = os.path.join(WORKSPACE_ROOT, "tasks")
SHARED_DIR = os.path.join(WORKSPACE_ROOT, "shared")

# Compatibility mode switch
USE_LEGACY_WORKSPACE = os.environ.get("USE_LEGACY_WORKSPACE", "false").lower() == "true"

# Cleanup configuration
TASK_WORKSPACE_MAX_AGE_HOURS = int(os.environ.get("TASK_WORKSPACE_MAX_AGE_HOURS", "24"))
FEATURE_WORKSPACE_MAX_AGE_DAYS = int(os.environ.get("FEATURE_WORKSPACE_MAX_AGE_DAYS", "7"))
```

## Usage

### 1. Basic Usage (Automatic Mode)

The Agent's `download_code()` method automatically chooses between the new or old structure based on configuration:

```python
class MyAgent(Agent):
    def pre_execute(self):
        # Automatically uses new workspace structure
        self.download_code()
        return TaskStatus.SUCCESS
```

### 2. Direct Use of WorkspaceSetup

```python
from executor.workspace import WorkspaceSetup

setup = WorkspaceSetup()

# Setup feature workspace (with branch name)
result = setup.setup_workspace(
    task_id=123,
    git_url="https://github.com/org/repo.git",
    branch_name="feature-123-add-login",
    prompt="Implement login feature",
    git_token="xxx",
    git_login="user"
)

# Setup task workspace (without branch name)
result = setup.setup_workspace(
    task_id=456,
    git_url="https://github.com/org/repo.git",
    branch_name=None,  # Claude will create branch
    prompt="Fix bug"
)

# Check result
if result.success:
    print(f"Workspace: {result.workspace_path}")
    print(f"Project path: {result.project_path}")
    print(f"Is feature: {result.is_feature_workspace}")
```

### 3. Convert Task to Feature

When Claude decides on a branch name, the task workspace can be converted to a feature workspace:

```python
# In Agent
success = self.convert_to_feature_workspace("feature-456-fix-bug")
if success:
    print(f"Converted to feature: {self.feature_name}")
```

### 4. Cross-Repository Feature

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_ROOT` | `/workspace` | Workspace root path |
| `USE_LEGACY_WORKSPACE` | `false` | Whether to use old directory structure |
| `TASK_WORKSPACE_MAX_AGE_HOURS` | `24` | Maximum retention time for task directories (hours) |
| `FEATURE_WORKSPACE_MAX_AGE_DAYS` | `7` | Maximum retention time for feature directories (days) |

## Cleanup Strategy

### Automatic Cleanup Rules

1. **Task directories**: Automatically cleaned up 24 hours after task completion
2. **Feature directories**:
   - Automatically cleaned up if last activity exceeds 7 days
   - Automatically cleaned up if branch has been merged to main
3. **Bare Repositories**:
   - Automatically cleaned up if no associated worktrees
   - Retain those used within the last 30 days

## Testing

Run tests:

```bash
cd executor
pytest tests/workspace/ -v
```

## Backward Compatibility

Set `USE_LEGACY_WORKSPACE=true` to use the old directory structure, suitable for:
- Migration transition period
- Debugging issues
- Special scenarios

## Important Notes

1. **Git Token Encryption**: The system automatically handles encrypted git tokens
2. **Branch Creation**: If a branch doesn't exist, it will be automatically created based on main/master
3. **Worktree Cleanup**: Worktree references are properly cleaned up when deleting features
4. **Disk Space**: Bare repository sharing can significantly save disk space

## Advantages

1. **Disk Space Optimization**: Bare repository + worktree avoids duplicate storage
2. **Branch Isolation**: Each feature has an independent directory, no interference
3. **Cross-Repository Support**: Same feature can contain multiple repositories
4. **Flexible Branch Creation**: Supports both pre-specified and Claude auto-creation
5. **Clear Directory Structure**: Organized by feature, easy to understand and manage

## For More Information

- [AGENTS.md - Executor Section](../../../../AGENTS.md#executor)
- [Testing Guide](./testing.md)
- [Development Setup](./setup.md)
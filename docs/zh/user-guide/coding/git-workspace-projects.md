---
sidebar_position: 4
---

# Git 项目

Git 项目用于把一个远程仓库克隆为 Wework 左侧项目列表中的项目工作区。创建后，同一个项目下的新对话会复用同一份本地代码目录，适合围绕同一仓库连续开发、排查和验证。

## 前置条件

- 本地或云端执行设备处于在线状态。
- 已在设置中配置可访问目标仓库的 Git Token。
- 目标仓库和默认分支对当前账号可见。
- 执行设备能够访问 Git 服务地址。

## 从 Git 克隆项目

1. 在 Wework 左侧栏的“项目”标题右侧点击新建按钮。
2. 选择“从 Git 克隆”。
3. 在弹窗中选择执行设备。
4. 选择 Git 仓库。
5. 选择默认分支。
6. 点击“创建项目”。

弹窗会先打开，再异步加载仓库和分支数据。仓库加载期间，仓库选择框会显示“正在加载仓库...”。

## 目录规则

Git 项目会克隆到执行设备的项目根目录下：

```bash
~/.wecode/wegent-executor/workspace/projects/<repoName>
```

例如仓库名为 `pluto` 时，最终目录是：

```bash
~/.wecode/wegent-executor/workspace/projects/pluto
```

任务执行时也会进入同一个目录。也就是说，项目创建阶段的 `git clone` 目录和后续任务的工作目录保持一致。

## 执行模式

在本地 workspace 项目的新对话输入区，可以选择任务使用哪种工作目录。项目可以来自“从 Git 克隆”，也可以来自“使用现有目录”；只要发送任务时该目录是 Git 仓库，就可以使用新工作树。

- “在本地处理”：任务直接进入项目绑定的目录，例如 `projects/<repoKey>/<repoName>` 或用户选择的已有目录。
- “新工作树”：发送新任务前，Wegent 会在同一执行设备上运行 `git worktree add`，为这次任务创建独立工作树。

新工作树会创建在执行设备 workspace 根目录下：

```bash
~/.wecode/wegent-executor/workspace/worktrees/<taskId>/<projectName>
```

工作树 ID 使用任务 ID。任务只记录执行目录来源为 `git_worktree`，实际路径会在执行和管理工作树时通过任务 ID 与项目目录规则推导出来；分支名、base ref、原始 checkout 路径和绝对工作树路径不作为任务字段重复保存。工作树设置页会通过扫描执行设备上的 `worktrees` 目录展示已创建的工作树。删除工作树时，Wegent 会删除对应工作树目录，并软删除使用该工作树的任务。

“新工作树”只对绑定本地执行设备和本地目录的项目新对话可选。已有任务会锁定执行目录，避免同一个任务在中途切换工作区。如果目录当前不是 Git 仓库，发送时会提示无法创建工作树；后续用户手工把该目录变成 Git 仓库后，不需要修改项目配置即可重新选择新工作树。

## 目录已存在

如果目标目录已经存在，Wegent 不会创建新目录，也不会尝试复用或覆盖已有目录。界面会提示项目目录已存在。

处理方式：

- 如果这是旧的无用目录，先在执行设备上删除或重命名该目录，再重新创建项目。
- 如果要保留旧目录，可以选择其他仓库或先调整目录名称。
- 如果目录中已有同名仓库，也需要先手动处理；Wegent 不会自动切换分支或拉取更新。

## 排查 Git 克隆失败

在执行设备上检查以下信息：

```bash
echo "$WECODE_HOME"
echo "$WEGENT_EXECUTOR_PROJECTS_DIR"

ROOT="${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}"
ls -la "$ROOT"
```

然后在项目根目录下验证仓库和分支：

```bash
cd "$ROOT"
git ls-remote --heads <git_url> <branch>
git clone --branch <branch> --single-branch <git_url> <repoName>
```

常见原因：

| 现象                              | 可能原因                         |
| --------------------------------- | -------------------------------- |
| Authentication failed             | Git Token 未配置、过期或权限不足 |
| Repository not found              | 仓库地址错误或当前账号无权限     |
| Remote branch not found           | 选择的默认分支不存在             |
| destination path already exists   | 目标目录已存在                   |
| Could not resolve host 或 timeout | 执行设备无法访问 Git 服务        |

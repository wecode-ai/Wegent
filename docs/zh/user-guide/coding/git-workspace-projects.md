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

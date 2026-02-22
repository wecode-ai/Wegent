# 预执行钩子

预执行钩子允许您在 Executor 执行任务之前运行自定义脚本。这对于自定义初始化、安全检查、环境设置或与外部系统集成非常有用。

---

## 概述

预执行钩子系统提供了一种在每个任务启动前执行外部命令的方式。钩子接收有关任务的信息，可以执行任何必要的设置或验证。

---

## 配置

### 环境变量

| 变量 | 描述 | 默认值 |
|------|------|--------|
| `WEGENT_HOOK_PRE_EXECUTE` | 钩子脚本路径 | 未设置（禁用） |
| `WEGENT_HOOK_PRE_EXECUTE_TIMEOUT` | 超时时间（秒） | 30 |

### 启用钩子

将 `WEGENT_HOOK_PRE_EXECUTE` 环境变量设置为钩子脚本的路径：

```bash
export WEGENT_HOOK_PRE_EXECUTE=/path/to/your/pre-execute-hook.sh
```

---

## 钩子接口

### 参数

钩子脚本的调用方式：

```bash
bash <script_path> <task_dir>
```

| 参数 | 描述 |
|------|------|
| `task_dir` | 任务的工作目录路径 |

### 环境变量

以下环境变量会传递给钩子：

| 变量 | 描述 |
|------|------|
| `WEGENT_TASK_DIR` | 任务工作目录 |
| `WEGENT_TASK_ID` | 任务 ID |
| `WEGENT_GIT_URL` | Git 仓库 URL |

### 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 - 任务继续执行 |
| 非零 | 失败 - 记录警告，任务继续执行 |
| `-1`（内部） | 超时或脚本未找到 |

---

## 示例钩子脚本

```bash
#!/bin/bash
# 预执行钩子示例
# 保存为：/opt/wegent/hooks/pre-execute.sh

TASK_DIR="$1"

echo "预执行钩子运行中"
echo "任务目录: $TASK_DIR"
echo "任务 ID: $WEGENT_TASK_ID"
echo "Git URL: $WEGENT_GIT_URL"

# 示例：创建标记文件
touch "$TASK_DIR/.hook-executed"

# 示例：运行安全扫描
# /opt/security/scan.sh "$TASK_DIR"

# 示例：设置自定义环境
# source /opt/custom/env.sh

exit 0
```

---

## 使用场景

### 1. 安全扫描

在执行前对仓库进行安全检查：

```bash
#!/bin/bash
TASK_DIR="$1"

# 运行安全扫描
if ! /opt/security/scanner --path "$TASK_DIR"; then
    echo "安全扫描失败"
    exit 1
fi

exit 0
```

### 2. 自定义初始化

设置自定义工具或配置：

```bash
#!/bin/bash
TASK_DIR="$1"

# 复制自定义配置文件
cp /opt/configs/.custom "$TASK_DIR/"

# 初始化自定义工具
/opt/tools/init.sh "$TASK_DIR"

exit 0
```

### 3. 日志和审计

记录任务执行以供审计：

```bash
#!/bin/bash
TASK_DIR="$1"

# 记录到审计系统
echo "$(date) - 任务 $WEGENT_TASK_ID 已启动 - $WEGENT_GIT_URL" >> /var/log/wegent/audit.log

exit 0
```

---

## Docker 配置

在 Docker 中运行 Wegent 时，挂载钩子脚本并设置环境变量：

```yaml
# docker-compose.yml
services:
  executor:
    environment:
      - WEGENT_HOOK_PRE_EXECUTE=/hooks/pre-execute.sh
      - WEGENT_HOOK_PRE_EXECUTE_TIMEOUT=60
    volumes:
      - ./hooks:/hooks:ro
```

---

## 故障排除

### 钩子未执行

1. 验证脚本路径是否正确且可访问
2. 检查脚本是否有执行权限（`chmod +x`）
3. 检查 Executor 日志中的钩子相关消息

### 钩子超时

如果钩子需要超过默认的 30 秒：

```bash
export WEGENT_HOOK_PRE_EXECUTE_TIMEOUT=120
```

### 调试

启用详细日志以在 Executor 日志中查看钩子执行详情：

```bash
# 钩子日志包括：
# - 正在执行的命令
# - 任务目录和 ID
# - 脚本的 stdout 和 stderr
# - 退出码
```

---

## 相关内容

- [系统架构](../../concepts/architecture.md) - Wegent 架构概述
- [开发者设置](./setup.md) - 设置开发环境

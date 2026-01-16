# Executor Manager

中文 | [English](README.md)

## 快速开始（推荐）

使用一键启动脚本自动设置：

```bash
cd executor_manager
./start.sh
```

脚本会自动完成：
- 检查 Python 版本（需要 3.8+）
- 安装 uv（如果未安装）
- 使用 uv 同步依赖
- 检查 Docker 安装和状态
- 创建 Docker 网络（如果需要）
- 设置 PYTHONPATH
- 检测 Docker 主机 IP
- 启动 Executor Manager 服务器

**自定义配置：**
```bash
# 使用自定义端口
./start.sh --port 8002

# 使用自定义 executor 镜像
./start.sh --executor-image ghcr.io/wecode-ai/wegent-executor:latest

# 使用自定义后端 API
./start.sh --task-api-domain http://backend:8000

# 查看所有选项
./start.sh --help
```

**端口验证：**
- 脚本会验证端口号（1-65535）
- 检查端口是否已被占用
- 提供清晰的错误信息和故障排除提示

## 手动设置

如果您更喜欢手动设置：

### 前置要求

- 已安装 [uv](https://github.com/astral-sh/uv)
- 已安装并运行 Docker

### 设置

1. 初始化环境并安装依赖：
    ```bash
    uv sync
    ```

2. 设置 `PYTHONPATH` 以包含项目根目录（`shared` 模块需要）：
    ```bash
    # 从项目根目录（Wegent 目录）运行此命令
    export PYTHONPATH=$(pwd):$PYTHONPATH
    ```

### 运行

运行应用程序（带环境变量的示例）：
```bash
# 导航到 executor_manager 目录
cd executor_manager

# 使用 uv 运行
EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:latest DOCKER_HOST_ADDR={LocalHost IP} uv run main.py
```

> EXECUTOR_IMAGE: 查看 docker-compose.yml 获取最新的 wegent-executor 镜像版本
> DOCKER_HOST_ADDR: 设置为宿主机的 IP 地址（容器可以访问的 IP）

### 测试

运行测试：
```bash
# 确保已按上述方式设置 PYTHONPATH
uv run pytest
```

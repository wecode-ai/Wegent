# Executor Manager

中文 | [English](README.md)

## 本地开发

### 前置要求

- 已安装 [uv](https://github.com/astral-sh/uv)。

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
EXECUTOR_IMAGE=ghcr.io/wecode-ai/wegent-executor:{version} DOCKER_HOST_ADDR={LocalHost IP} uv run main.py
```

> EXECUTOR_IMAGE: 查看 docker-compose.yml 获取最新的 wegent-executor 镜像版本
> DOCKER_HOST_ADDR: 设置为宿主机的 IP 地址（容器可以访问的 IP）

### 测试

运行测试：
```bash
# 确保已按上述方式设置 PYTHONPATH
uv run pytest
```

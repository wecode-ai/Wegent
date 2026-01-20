# envd Connect RPC Services

Python Connect RPC 服务端实现，提供 Process 和 Filesystem 服务。

## 目录结构

```
executor/envd/
├── process/              # Process 服务 proto 定义
│   └── process.proto
├── filesystem/           # Filesystem 服务 proto 定义
│   └── filesystem.proto
├── gen/                  # 生成的 protobuf 代码
│   ├── process/
│   └── filesystem/
├── process_service.py    # Process 服务实现
├── filesystem_service.py # Filesystem 服务实现
├── server.py             # Connect RPC 服务器
├── generate.sh           # protobuf 代码生成脚本
└── README.md
```

## 服务说明

### Process 服务

提供进程管理功能：

- `List` - 列出所有运行中的进程
- `Start` - 启动新进程并流式传输输出
- `Connect` - 连接到已存在的进程
- `Update` - 更新进程设置（如 PTY 大小）
- `SendInput` - 向进程发送输入
- `StreamInput` - 流式发送输入到进程
- `SendSignal` - 向进程发送信号（SIGTERM/SIGKILL）

### Filesystem 服务

提供文件系统操作功能：

- `Stat` - 获取文件/目录信息
- `MakeDir` - 创建目录
- `Move` - 移动/重命名文件或目录
- `ListDir` - 列出目录内容（支持递归）
- `Remove` - 删除文件或目录
- `WatchDir` - 监控目录变化（流式）
- `CreateWatcher` - 创建非流式目录监控器
- `GetWatcherEvents` - 获取监控器事件
- `RemoveWatcher` - 移除监控器

## 安装依赖

```bash
cd /Users/yixiang1/Desktop/Wegent/executor
pip install -r requirements.txt
```

## 生成 protobuf 代码

首次使用前需要生成 protobuf 代码：

```bash
cd /Users/yixiang1/Desktop/Wegent/executor/envd
./generate.sh
```

这将生成：
- `gen/process/process_pb2.py` - Process 服务消息定义
- `gen/process/process_pb2_grpc.py` - Process 服务 gRPC 代码
- `gen/process/process_connect.py` - Process 服务 Connect RPC 代码
- `gen/filesystem/filesystem_pb2.py` - Filesystem 服务消息定义
- `gen/filesystem/filesystem_pb2_grpc.py` - Filesystem 服务 gRPC 代码
- `gen/filesystem/filesystem_connect.py` - Filesystem 服务 Connect RPC 代码

## 启动服务器

### 方式 1: 集成在 main.py 中

设置环境变量来启用 envd 服务器：

```bash
export ENVD_ENABLED=true
export ENVD_PORT=50051  # 可选，默认 50051

cd /Users/yixiang1/Desktop/Wegent/executor
python main.py
```

服务器将在以下端口启动：
- FastAPI HTTP 服务: 10001（默认）
- envd Connect RPC 服务: 50051（默认）

### 方式 2: 单独启动 envd 服务器

```python
import asyncio
from executor.envd.server import start_envd_server

async def main():
    server = await start_envd_server(host="0.0.0.0", port=50051)
    await server.wait_for_termination()

asyncio.run(main())
```

## 环境变量

- `ENVD_ENABLED` - 是否启用 envd 服务器（"true" 或 "false"，默认 "false"）
- `ENVD_PORT` - envd 服务器端口（默认 50051）

## 使用示例

### Python 客户端示例

```python
import asyncio
from connectrpc.client import ConnectClient
from executor.envd.gen.process import process_pb2

async def start_process():
    client = ConnectClient(base_url="http://localhost:50051")

    # 启动一个进程
    request = process_pb2.StartRequest(
        process=process_pb2.ProcessConfig(
            cmd="python",
            args=["-c", "print('Hello from subprocess')"],
        )
    )

    async for response in client.stream("process.Process/Start", request):
        if response.event.HasField("start"):
            print(f"Process started with PID: {response.event.start.pid}")
        elif response.event.HasField("data"):
            if response.event.data.HasField("stdout"):
                print(f"stdout: {response.event.data.stdout.decode()}")
        elif response.event.HasField("end"):
            print(f"Process ended with code: {response.event.end.exit_code}")

asyncio.run(start_process())
```

### Filesystem 客户端示例

```python
import asyncio
from connectrpc.client import ConnectClient
from executor.envd.gen.filesystem import filesystem_pb2

async def list_directory():
    client = ConnectClient(base_url="http://localhost:50051")

    request = filesystem_pb2.ListDirRequest(
        path="/tmp",
        depth=1  # 递归深度
    )

    response = await client.call("filesystem.Filesystem/ListDir", request)

    for entry in response.entries:
        print(f"{entry.permissions} {entry.owner:8} {entry.group:8} {entry.size:10} {entry.name}")

asyncio.run(list_directory())
```

## 特性

### Process 服务特性

- **进程管理**: 启动、连接、更新和信号发送
- **PTY 支持**: 支持伪终端模式
- **流式输出**: 实时流式传输进程输出
- **标签支持**: 可以通过 PID 或自定义标签选择进程
- **双向通信**: 支持向进程发送输入

### Filesystem 服务特性

- **完整的文件操作**: 创建、移动、删除、列表
- **递归列表**: 支持递归列出目录内容
- **实时监控**: 使用 watchdog 监控文件系统变化
- **流式和非流式监控**: 提供两种监控模式
- **详细的文件信息**: 包括权限、所有者、大小、修改时间等

## 错误处理

服务使用 Connect RPC 错误代码：

- `NOT_FOUND` - 资源未找到（进程、文件等）
- `INVALID_ARGUMENT` - 无效参数
- `FAILED_PRECONDITION` - 前置条件失败
- `INTERNAL` - 内部错误

## 日志

服务使用 `shared.logger` 进行日志记录：

- `process_service` - Process 服务日志
- `filesystem_service` - Filesystem 服务日志
- `envd_server` - 服务器日志

## 注意事项

1. **安全性**: 此服务提供了强大的系统访问能力，请确保在受信任的环境中运行
2. **权限**: 某些操作可能需要特定的文件系统权限
3. **资源管理**: Process 服务会跟踪所有启动的进程，但不会自动清理僵尸进程
4. **PTY 限制**: PTY 模式在 Windows 上可能不可用

## 开发

### 修改 proto 定义后重新生成

```bash
cd /Users/yixiang1/Desktop/Wegent/executor/envd
./generate.sh
```

### 运行测试

```bash
cd /Users/yixiang1/Desktop/Wegent/executor
pytest tests/
```

## License

Apache-2.0

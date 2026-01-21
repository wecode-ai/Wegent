# envd Connect RPC 服务快速开始指南

## 概述

envd Connect RPC 服务已集成到主 FastAPI 应用中，无需单独端口。所有服务通过主应用端口（默认 10001）提供。

## 1. 安装依赖

```bash
cd /Users/yixiang1/Desktop/Wegent/executor
pip install -r requirements.txt
```

新增的依赖包括：
- `grpcio` - gRPC 核心库
- `grpcio-tools` - gRPC 代码生成工具
- `connectrpc` - Connect RPC Python 实现
- `protobuf` - Protocol Buffers
- `watchdog` - 文件系统监控库

## 2. 生成 protobuf 代码

```bash
cd /Users/yixiang1/Desktop/Wegent/executor/envd
./generate.sh
```

这将根据 `process/process.proto` 和 `filesystem/filesystem.proto` 生成必要的 Python 代码。

## 3. 启动服务

```bash
# 设置环境变量启用 envd 服务
export ENVD_ENABLED=true

# 启动主服务
cd /Users/yixiang1/Desktop/Wegent/executor
python main.py
```

服务将在 **单个端口** 上运行：
- HTTP API: `http://0.0.0.0:10001`
- envd Connect RPC: `http://0.0.0.0:10001/process.Process/*` 和 `http://0.0.0.0:10001/filesystem.Filesystem/*`

## 4. 服务端点

### Process 服务

所有 Process 服务端点的完整路径：

- `POST http://localhost:10001/process.Process/List` - 列出所有进程
- `POST http://localhost:10001/process.Process/Start` - 启动新进程（流式）
- `POST http://localhost:10001/process.Process/Connect` - 连接到已有进程（流式）
- `POST http://localhost:10001/process.Process/Update` - 更新进程设置
- `POST http://localhost:10001/process.Process/SendInput` - 发送输入
- `POST http://localhost:10001/process.Process/StreamInput` - 流式输入（流式）
- `POST http://localhost:10001/process.Process/SendSignal` - 发送信号

### Filesystem 服务

所有 Filesystem 服务端点的完整路径：

- `POST http://localhost:10001/filesystem.Filesystem/Stat` - 获取文件信息
- `POST http://localhost:10001/filesystem.Filesystem/MakeDir` - 创建目录
- `POST http://localhost:10001/filesystem.Filesystem/Move` - 移动文件/目录
- `POST http://localhost:10001/filesystem.Filesystem/ListDir` - 列出目录
- `POST http://localhost:10001/filesystem.Filesystem/Remove` - 删除文件/目录
- `POST http://localhost:10001/filesystem.Filesystem/WatchDir` - 监控目录（流式）
- `POST http://localhost:10001/filesystem.Filesystem/CreateWatcher` - 创建监控器
- `POST http://localhost:10001/filesystem.Filesystem/GetWatcherEvents` - 获取监控事件
- `POST http://localhost:10001/filesystem.Filesystem/RemoveWatcher` - 移除监控器

## 5. 使用示例

### 使用 curl 测试

```bash
# 列出所有进程（JSON 格式）
curl -X POST http://localhost:10001/process.Process/List \
  -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  -d '{}'

# 获取文件信息
curl -X POST http://localhost:10001/filesystem.Filesystem/Stat \
  -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  -d '{"path": "/tmp"}'
```

### 使用 Go Connect 客户端

```go
package main

import (
    "context"
    "fmt"
    "net/http"

    "connectrpc.com/connect"
    processv1 "your/gen/process"
    "your/gen/process/processconnect"
)

func main() {
    client := processconnect.NewProcessClient(
        http.DefaultClient,
        "http://localhost:10001",
    )

    resp, err := client.List(context.Background(), connect.NewRequest(&processv1.ListRequest{}))
    if err != nil {
        panic(err)
    }

    fmt.Println("Processes:", resp.Msg.Processes)
}
```

## 6. 环境变量配置

- `ENVD_ENABLED` - 是否启用 envd 路由（"true" 启用，默认 "false"）
- `PORT` - 主服务端口（默认 10001）

## 7. 架构说明

### 路由注册

envd 服务通过 `register_envd_routes(app)` 函数注册到主 FastAPI 应用。路由遵循 Connect 协议规范：

```
POST /package.Service/Method
```

例如：
- `/process.Process/List` - Process 包的 Process 服务的 List 方法
- `/filesystem.Filesystem/Stat` - Filesystem 包的 Filesystem 服务的 Stat 方法

### 协议支持

支持两种内容类型：

1. **JSON** (`application/json` 或 `application/connect+json`)
   - 请求和响应使用 JSON 编码
   - 流式响应使用换行符分隔的 JSON (NDJSON)

2. **Protocol Buffers** (`application/proto`)
   - 请求和响应使用二进制 protobuf 编码
   - 流式响应使用长度前缀的消息

### Connect 协议头

所有响应包含：
- `Connect-Protocol-Version: 1` - Connect 协议版本
- `Connect-Streaming: true` - 仅用于流式响应

## 8. 故障排查

### 问题：路由未注册

**检查**: 确认 `ENVD_ENABLED=true` 已设置

```bash
export ENVD_ENABLED=true
python main.py
```

### 问题：导入错误 "cannot import process_pb2"

**解决方案**: 运行代码生成脚本

```bash
cd /Users/yixiang1/Desktop/Wegent/executor/envd
./generate.sh
```

### 问题：404 Not Found

**检查**: 确认使用正确的 URL 路径

```bash
# 正确 ✓
curl http://localhost:10001/process.Process/List

# 错误 ✗
curl http://localhost:50051/process.Process/List  # 错误的端口
curl http://localhost:10001/Process/List          # 缺少包名
```

## 9. 与 Go Connect 客户端的兼容性

此实现完全兼容 Go Connect 客户端。路由格式遵循 Connect 规范：

- Go 常量: `ProcessListProcedure = "/process.Process/List"`
- Python 路由: `@app.post("/process.Process/List")`

两者完全匹配，确保 Go 客户端可以无缝连接到 Python 服务器。

## 10. 优势

相比独立端口方案的优势：

1. **单一端口** - 所有服务通过一个端口访问，简化部署
2. **统一日志** - 所有请求通过主应用中间件，日志和监控统一
3. **共享配置** - 复用 FastAPI 配置、CORS、认证等
4. **简化网络** - 无需额外的端口转发和防火墙配置
5. **资源高效** - 不需要额外的服务器进程

## 帮助

如有问题，请参考：
- `README.md` - 完整文档
- `process/process.proto` - Process 服务定义
- `filesystem/filesystem.proto` - Filesystem 服务定义

# 端口冲突检测与自动规避功能说明

## 功能概述

`start.sh` 脚本现在支持端口冲突检测功能：

- **默认行为**: 检测到端口冲突时停止启动，并提示用户解决方案
- **自动规避模式**: 使用 `--auto-adjust-ports` 参数时，自动寻找可用端口并启动服务

## 默认端口

- **Backend**: 8000
- **Chat Shell**: 8100
- **Executor Manager**: 8001
- **Frontend**: 3000

## 工作原理

1. **端口检测**: 启动前检查所有服务的默认端口是否被占用
2. **自动调整**: 如果端口被占用，自动从该端口开始向上搜索（最多尝试100个端口）
3. **依赖更新**: 自动更新服务间的依赖配置（如 Chat Shell 连接 Backend 的 URL）
4. **用户通知**: 在控制台显示端口调整信息

## 使用示例

### 场景 1: 无端口冲突（默认行为）
```bash
./start.sh
```
输出：
```
Checking port availability...
✓ All ports available

Configuration:
  Backend Port:     8000
  Chat Shell Port:  8100
  Executor Mgr Port: 8001
  Frontend Port:    3000
```

### 场景 2: 有端口冲突（默认行为 - 停止启动）
```bash
./start.sh
```
输出：
```
Checking port availability...
Port conflict detected! The following ports are already in use:
  ● Port 8000 (Backend)

Solutions:
  1. Stop the process occupying the port:
     lsof -i :PORT  # View occupying process
     kill -9 PID    # Stop process

  2. Run ./start.sh --stop to stop previously started services

  3. Use ./start.sh --auto-adjust-ports to automatically find available ports
```

### 场景 3: 使用自动规避模式
```bash
./start.sh --auto-adjust-ports
```
输出：
```
Checking port availability...
⚠ Backend port 8000 is in use, using port 8001 instead

✓ Ports configured (auto-adjusted if needed)

Configuration:
  Backend Port:     8001
  Chat Shell Port:  8100
  Executor Mgr Port: 8002
  Frontend Port:    3000
```

### 场景 4: 指定 Frontend 端口 + 自动规避
```bash
./start.sh -p 3000 --auto-adjust-ports  # 3000 端口被占用
```
输出：
```
Checking port availability...
⚠ Frontend port 3000 is in use, using port 3001 instead

✓ Ports configured (auto-adjusted if needed)

Configuration:
  Backend Port:     8000
  Chat Shell Port:  8100
  Executor Mgr Port: 8001
  Frontend Port:    3001
```

## 测试端口冲突

使用提供的测试脚本：

```bash
# 启动测试服务器占用端口 8000
./test_port_conflict.sh

# 在另一个终端运行
./start.sh
# 应该看到 Backend 自动使用端口 8001
```

## 技术细节

### 核心函数

1. **`check_port(port)`**: 检查端口是否被占用
2. **`find_available_port(start_port)`**: 从指定端口开始查找可用端口
3. **`check_all_ports()`**: 检查所有服务端口，发现冲突时报错并退出
4. **`auto_adjust_ports()`**: 自动调整所有服务端口到可用端口

### 端口查找逻辑

```bash
find_available_port() {
    local start_port=$1
    local max_attempts=100
    local port=$start_port
    
    for ((i=0; i<max_attempts; i++)); do
        if check_port "$port"; then
            echo "$port"
            return 0
        fi
        port=$((port + 1))
    done
    
    # 如果找不到可用端口，返回原始端口
    echo "$start_port"
    return 1
}
```

### 服务间依赖自动更新

- **Chat Shell** → Backend: `CHAT_SHELL_REMOTE_STORAGE_URL=http://localhost:$BACKEND_PORT/api/internal`
- **Executor Manager** → Backend: `TASK_API_DOMAIN=http://$(get_local_ip):$BACKEND_PORT`
- **Frontend** → Backend: `RUNTIME_INTERNAL_API_URL` 和 `RUNTIME_SOCKET_DIRECT_URL` 自动更新

## 查看实际使用的端口

```bash
# 查看服务状态（包括实际端口）
./start.sh --status
```

输出示例：
```
Wegent Service Status:

  ● backend (PID: 12345, Port: 8001)
  ● chat_shell (PID: 12346, Port: 8100)
  ● executor_manager (PID: 12347, Port: 8002)
  ● frontend (PID: 12348, Port: 3000)
```

## 注意事项

1. **端口范围**: 脚本会尝试从默认端口开始向上搜索最多 100 个端口
2. **权限**: 某些端口（如 1-1024）可能需要 root 权限
3. **防火墙**: 确保防火墙允许使用的端口
4. **服务发现**: 如果使用外部服务发现机制，需要手动更新配置

## 兼容性

- ✅ macOS
- ✅ Linux (Ubuntu, CentOS, etc.)
- ✅ WSL (Windows Subsystem for Linux)

## 故障排除

### 问题: 端口仍然冲突
**解决方案**: 检查是否有僵尸进程占用端口
```bash
lsof -i :8000
kill -9 <PID>
```

### 问题: 服务无法相互通信
**解决方案**: 检查日志文件确认实际使用的端口
```bash
cat .pids/backend.log
cat .pids/chat_shell.log
```

### 问题: 找不到可用端口
**解决方案**: 手动停止占用端口的服务，或使用 `--stop` 清理之前的服务
```bash
./start.sh --stop
./start.sh
```

# 🔧 Troubleshooting Guide

This guide helps you diagnose and resolve common issues when using the Wegent platform.

---

## 📋 Table of Contents

- [Installation & Startup Issues](#-installation--startup-issues)
- [Database Issues](#-database-issues)
- [Network & Connection Issues](#-network--connection-issues)
- [Task Execution Issues](#-task-execution-issues)
- [Performance Issues](#-performance-issues)
- [Development Environment Issues](#-development-environment-issues)

---

## 🚀 Installation & Startup Issues

### Issue 1: Docker Compose Start Fails

**Symptoms**: `docker-compose up -d` fails or services won't start

**Possible Causes and Solutions**:

**1. Docker not running**
```bash
# Check Docker status
systemctl status docker  # Linux
# or
open -a Docker  # macOS

# Start Docker
sudo systemctl start docker  # Linux
```

**2. Port already in use**
```bash
# Find process using port
lsof -i :3000  # Frontend
lsof -i :8000  # Backend
lsof -i :3306  # MySQL
lsof -i :6379  # Redis

# Kill process
kill -9 <PID>

# Or modify port mapping in docker-compose.yml
```

**3. Permission issues**
```bash
# Add current user to docker group
sudo usermod -aG docker $USER

# Re-login to apply changes
```

**4. Insufficient disk space**
```bash
# Check disk space
df -h

# Clean Docker resources
docker system prune -a --volumes
```

### Issue 2: Services Exit Immediately After Start

**Diagnostic Steps**:

```bash
# View all container status
docker-compose ps

# View specific service logs
docker-compose logs backend
docker-compose logs frontend
docker-compose logs mysql
docker-compose logs redis

# View full logs
docker-compose logs --tail=100 <service-name>
```

**Common Causes**:

**1. Environment variable misconfiguration**
```bash
# Check if .env exists
ls -la .env

# Verify key variables
docker-compose config
```

**2. Database connection failure**
```bash
# Wait for MySQL to fully start (may take 30-60 seconds)
sleep 30

# Test connection
docker-compose exec mysql mysql -u task_user -p
```

### Issue 3: Database Initialization Fails

**Symptoms**: Database tables not created or initial data not loaded

**Solutions**:

```bash
# 1. Ensure MySQL container is running
docker-compose ps mysql

# 2. Check backend initialization logs
docker-compose logs backend | grep -i "yaml\|initialization"

# 3. If initialization fails, restart backend service
docker-compose restart backend

# 4. If still fails, check YAML configuration
docker-compose exec backend ls -la /app/init_data/

# 5. Last resort: rebuild database (WARNING: Deletes all data)
docker-compose down -v
docker-compose up -d
```

---

## 💾 Database Issues

### Issue 4: Database Connection Failure

**Error Messages**: `Can't connect to MySQL server`, `OperationalError`

**Diagnosis and Solutions**:

**1. Check MySQL status**
```bash
# Docker method
docker-compose ps mysql
docker-compose logs mysql

# Local method
sudo systemctl status mysql
```

**2. Verify connection parameters**
```bash
# Check environment variables
docker-compose exec backend env | grep DATABASE_URL

# Correct format
DATABASE_URL=mysql+pymysql://task_user:password@mysql:3306/task_manager
```

**3. Test connection**
```bash
# Test from backend container
docker-compose exec backend python -c "
from app.db.session import engine
try:
    conn = engine.connect()
    print('✅ Database connection successful')
    conn.close()
except Exception as e:
    print(f'❌ Connection failed: {e}')
"
```

**4. Check network**
```bash
# Ensure services are on same network
docker network ls
docker network inspect wegent-network
```

---

## 🌐 Network & Connection Issues

### Issue 5: Cannot Access Frontend

**Symptoms**: Browser cannot open http://localhost:3000

**Solutions**:

**1. Check frontend service**
```bash
# View status
docker-compose ps frontend

# View logs
docker-compose logs frontend

# Restart service
docker-compose restart frontend
```

**2. Check port usage**
```bash
# Find process using port 3000
lsof -i :3000
netstat -tlnp | grep 3000  # Linux

# Modify port if needed
# Edit docker-compose.yml
ports:
  - "3001:3000"  # Use 3001 instead
```

**3. Check firewall**
```bash
# Ubuntu/Debian
sudo ufw status
sudo ufw allow 3000

# CentOS/RHEL
sudo firewall-cmd --list-ports
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

### Issue 6: API Request Fails (CORS Error)

**Symptoms**: Browser console shows CORS error

**Solutions**:

**1. Check backend CORS configuration**
```python
# backend/app/main.py
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**2. Check frontend API URL**
```bash
# frontend/.env.local or environment variables
# Runtime variables (recommended, can be changed without rebuilding):
RUNTIME_INTERNAL_API_URL=http://localhost:8000
RUNTIME_SOCKET_DIRECT_URL=http://localhost:8000

# Legacy (deprecated):
# NEXT_PUBLIC_API_URL=http://localhost:8000
```

> **Note**: The frontend now uses `RUNTIME_INTERNAL_API_URL` instead of `NEXT_PUBLIC_API_URL`. Runtime variables can be changed without rebuilding the application.

**3. Use browser dev tools for debugging**
- Open F12 developer tools
- Check Network tab
- Inspect request and response headers

### Issue 7: WebSocket Connection Fails

**Symptoms**: Chat not working, real-time updates not received, Socket.IO connection errors in console

**Solutions**:

**1. Check Socket.IO server status**
```bash
# View backend logs for Socket.IO initialization
docker-compose logs backend | grep -i "socket"

# Verify Socket.IO endpoint is accessible
curl -I http://localhost:8000/socket.io/
```

**2. Verify JWT token**
```bash
# Check if token is valid (in browser console)
localStorage.getItem('token')

# Token should be passed in Socket.IO auth
```

**3. Check CORS configuration for WebSocket**
```python
# backend/app/core/socketio.py
# Ensure CORS origins are correctly configured
SOCKETIO_CORS_ORIGINS = "*"  # Or specific origins
```

**4. Verify Redis connection (required for multi-worker)**
```bash
# Redis is required for Socket.IO adapter
docker-compose exec redis redis-cli ping
```

**5. Check frontend Socket.IO configuration**
```typescript
// frontend/src/contexts/SocketContext.tsx
// Verify connection parameters
const socket = io(API_URL + '/chat', {
  path: '/socket.io',
  auth: { token },
  transports: ['websocket', 'polling'],
});
```

**6. Debug WebSocket in browser**
- Open F12 developer tools
- Go to Network tab → WS filter
- Check WebSocket connection status and messages

---

## ⚙️ Task Execution Issues

### Issue 7: Task Stuck in PENDING Status

**Diagnostic Flow**:

**1. Check Executor Manager**
```bash
# View status
docker-compose ps executor_manager

# View logs
docker-compose logs executor_manager

# Restart service
docker-compose restart executor_manager
```

**2. Check available Executors**
```bash
# List all Executor containers
docker ps | grep executor

# View specific Executor logs
docker logs <executor-container-id>
```

**3. Check resource limits**
```bash
# View concurrent limit
docker-compose exec executor_manager env | grep MAX_CONCURRENT_TASKS

# Increase limit (in .env)
MAX_CONCURRENT_TASKS=10
```

**4. Check task configuration**
```bash
# View task details via API
curl http://localhost:8000/api/tasks/<task-id>

# Check if Bot, Shell, Model config is correct
```

### Issue 8: Task Execution Fails

**Common Failure Reasons**:

| Error Type | Possible Cause | Solution |
|-----------|----------------|----------|
| `Bot not found` | Bot config doesn't exist | Check Bot name and config |
| `Model configuration error` | Model config error | Verify API Key and model name |
| `Shell not available` | Shell not supported | Confirm Shell type is correct |
| `Timeout` | Execution timeout | Increase timeout or optimize task |
| `Out of memory` | Insufficient memory | Increase container memory limit |

---

## ⚡ Performance Issues

### Issue 9: System Slow Response

**Diagnosis and Optimization**:

**1. Check resource usage**
```bash
# CPU and memory usage
docker stats

# Disk I/O
iostat -x 1

# Network
netstat -s
```

**2. Optimize database**
```sql
-- View slow queries
SHOW FULL PROCESSLIST;

-- Enable slow query log
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 2;
```

**3. Optimize Redis**
```bash
# Check Redis performance
docker-compose exec redis redis-cli INFO stats

# Clean expired keys
docker-compose exec redis redis-cli FLUSHDB  # Use with caution
```

**4. Increase resource limits**
```yaml
# docker-compose.yml
services:
  backend:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 4G
```

### Issue 10: Insufficient Disk Space

**Cleanup Solutions**:

```bash
# 1. Clean Docker resources
docker system prune -a --volumes

# 2. Clean log files
truncate -s 0 /var/lib/docker/containers/**/*-json.log

# 3. Clean old data
# Login to MySQL
docker-compose exec mysql mysql -u task_user -p task_manager

# Delete old task records
DELETE FROM tasks WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
DELETE FROM task_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY);

# 4. Clean workspace
find /path/to/workspace -type d -mtime +90 -exec rm -rf {} \;
```

---

## 💻 Development Environment Issues

### Issue 11: Python Dependency Installation Fails

**Solutions**:

```bash
# 1. Upgrade pip
pip install --upgrade pip setuptools wheel

# 2. Use mirror
uv pip install --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r pyproject.toml

# 3. Install dependencies separately
uv pip install --no-deps -r pyproject.toml
uv pip install <specific-package>

# 4. Use conda (if pip fails)
conda create -n wegent python=3.10
conda activate wegent
uv sync
```

### Issue 12: Node.js Dependency Installation Fails

**Solutions**:

```bash
# 1. Clean cache
npm cache clean --force
rm -rf node_modules package-lock.json

# 2. Use npm mirror
npm config set registry https://registry.npmmirror.com
npm install

# 3. Use yarn
npm install -g yarn
yarn install

# 4. Downgrade Node.js version (if compatibility issue)
nvm install 18
nvm use 18
npm install
```

---

## 🔍 Debugging Tips

### Enable Verbose Logging

**Backend**:
```bash
# Set in .env
LOG_LEVEL=DEBUG

# Restart service
docker-compose restart backend
```

**Frontend**:
```bash
# In browser console
localStorage.setItem('debug', '*')

# Refresh page
```

**Executor**:
```bash
# Enter container to view detailed logs
docker exec -it <executor-id> /bin/bash
tail -f /var/log/executor.log
```

### Use Development Tools

**1. Browser Dev Tools**:
- Network: View API requests
- Console: View errors and logs
- Application: View local storage

**2. Python Debugging**:
```python
# Use pdb
import pdb; pdb.set_trace()

# Use logging
import logging
logging.basicConfig(level=logging.DEBUG)
```

**3. Docker Debugging**:
```bash
# Enter container
docker exec -it <container-id> /bin/bash

# View environment variables
env

# View processes
ps aux

# View ports
netstat -tlnp
```

---

## 📞 Get Help

If the above methods don't solve your problem:

1. 📖 Check [FAQ](./faq.md)
2. 🔍 Search [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. 💬 Create new Issue with:
   - Detailed error messages
   - Steps to reproduce
   - Environment info (OS, Docker version, etc.)
   - Relevant logs
4. 🌟 Join community discussions

---

## 📝 Best Practices for Reporting Issues

When creating an Issue, include:

```markdown
## Environment
- OS: Ubuntu 22.04
- Docker: 24.0.6
- Wegent Version: v1.0.13

## Problem Description
Brief description...

## Steps to Reproduce
1. Execute xxx
2. Click xxx
3. Error occurs xxx

## Expected Behavior
Should display xxx...

## Actual Behavior
Actually displays xxx...

## Logs
```
Paste relevant logs...
```

## Screenshots
If applicable, add screenshots...
```

---

<p align="center">Hope this guide helps resolve your issues! 🎉</p>

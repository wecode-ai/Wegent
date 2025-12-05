# ❓ Frequently Asked Questions (FAQ)

This document collects common questions and answers about using the Wegent platform.

---

## 📋 Table of Contents

- [Installation & Deployment](#-installation--deployment)
- [Configuration & Usage](#-configuration--usage)
- [Development](#-development)
- [Agents & Teams](#-agents--teams)
- [Performance & Optimization](#-performance--optimization)
- [Troubleshooting](#-troubleshooting)

---

## 🔧 Installation & Deployment

### Q1: Which operating systems does Wegent support?

**A:** Wegent supports all major operating systems:

- **Linux**: Ubuntu 20.04+, Debian 11+, CentOS 8+
- **macOS**: macOS 11+
- **Windows**: Windows 10/11 (via WSL2 or Docker Desktop)

Linux or macOS is recommended for production deployments.

### Q2: What are the minimum hardware requirements?

**A:** Minimum configuration:
- **CPU**: 2 cores
- **Memory**: 4 GB
- **Storage**: 20 GB

Recommended (for production):
- **CPU**: 4+ cores
- **Memory**: 8+ GB
- **Storage**: 50+ GB (SSD preferred)

### Q3: Can I deploy on cloud platforms?

**A:** Yes. Wegent supports deployment on various cloud platforms:

- **AWS**: EC2, ECS, EKS
- **Google Cloud**: Compute Engine, GKE
- **Azure**: Virtual Machines, AKS
- **Alibaba Cloud**: ECS, ACK
- **Tencent Cloud**: CVM, TKE

Docker Compose works in any Docker-supported environment.

### Q4: Do I need a domain and SSL certificate?

**A:**
- **Development**: No, use `localhost`
- **Production**: Highly recommended
  - Use Let's Encrypt for free SSL
  - Use Nginx or Traefik as reverse proxy

### Q5: Are there deployment options besides Docker?

**A:** Yes. Besides Docker Compose:

- **Source deployment**: Run Python and Node.js services directly
- **Kubernetes**: Deploy with K8s (requires custom manifests)
- **Binary deployment**: Build backend as executable (requires additional configuration)

---

## ⚙️ Configuration & Usage

### Q6: How to configure multiple AI models?

**A:** Configure different environment variables in Model resources:

```yaml
# Claude model
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: claude-sonnet
spec:
  modelConfig:
    env:
      ANTHROPIC_MODEL: "claude-sonnet-4"
      ANTHROPIC_API_KEY: "sk-xxx"

---
# GPT model
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: gpt-4
spec:
  modelConfig:
    env:
      OPENAI_API_KEY: "sk-xxx"
      OPENAI_MODEL: "gpt-4"
```

### Q7: What permissions does GitHub Token need?

**A:** GitHub Personal Access Token requires:

- ✅ `repo` - Full repository access
- ✅ `workflow` - Workflow permissions
- ✅ `read:org` - Read organization info (if using org repos)

Steps to create Token:
1. GitHub Settings → Developer settings → Personal access tokens
2. Select "Tokens (classic)"
3. Generate new token
4. Select above permissions
5. Copy Token to Wegent configuration

### Q8: How to configure proxy server?

**A:** Configure proxy in environment variables:

```bash
# HTTP/HTTPS proxy
export HTTP_PROXY=http://proxy.example.com:8080
export HTTPS_PROXY=http://proxy.example.com:8080

# Or in .env file
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=http://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1
```

### Q9: Does it support multiple users?

**A:** Current version supports basic multi-user functionality:

- Each user has independent workspace
- Can configure different GitHub Tokens
- Teams and Bots can be shared (based on namespace)

Future versions will support more comprehensive permission management.

### Q10: How to backup data?

**A:** Main backups needed:

**1. MySQL Database:**
```bash
# Backup
docker-compose exec mysql mysqldump -u task_user -p task_manager > backup.sql

# Restore
docker-compose exec -T mysql mysql -u task_user -p task_manager < backup.sql
```

**2. Workspace Files:**
```bash
# Backup workspace
tar -czf workspace_backup.tar.gz /path/to/workspace

# Restore
tar -xzf workspace_backup.tar.gz -C /path/to/restore
```

**3. Configuration Files:**
- `.env` file
- `docker-compose.yml`
- Custom YAML configurations

---

## 💻 Development

### Q11: How to debug agent execution?

**A:** Several debugging methods:

**1. View Executor logs:**
```bash
# Docker method
docker-compose logs -f executor

# View specific Executor
docker logs -f <executor-container-id>
```

**2. Enable verbose logging:**
```bash
# In .env
LOG_LEVEL=DEBUG
```

**3. Enter Executor container:**
```bash
docker exec -it <executor-container-id> /bin/bash
```

### Q12: How to develop custom Agent?

**A:** Steps to develop custom Agent:

1. Create new Agent in `executor/agents/`
2. Inherit from `BaseAgent` class
3. Implement required methods:
   - `initialize()`
   - `execute()`
   - `cleanup()`
4. Register Agent in `agent_factory.py`
5. Create corresponding Shell configuration

### Q13: Which programming languages are supported?

**A:**

**Core Platform:**
- Backend: Python 3.10+ (FastAPI)
- Frontend: TypeScript (Next.js 15)
- Executor: Python 3.10+

**Agents can use:**
- Python (recommended)
- JavaScript/TypeScript
- Other languages (requires custom Agent implementation)

---

## 🤖 Agents & Teams

### Q14: What's the difference between Ghost, Bot, and Team?

**A:**

- **Ghost**: Agent's "soul" - defines personality and capabilities
- **Bot**: Complete agent instance = Ghost + Shell + Model
- **Team**: Collaboration of multiple Bots, defines workflow

Relationship: `Ghost + Shell + Model → Bot → Team`

See [Core Concepts](./concepts/core-concepts.md)

### Q15: How many Bots can a Team have?

**A:** No theoretical limit, but recommended:

- **Dialogue mode**: 3-5 Bots
- **Coding mode**: 1-3 Bots
- **Complex workflows**: 5-10 Bots

Too many Bots may cause:
- Context confusion
- Performance degradation
- Increased costs

### Q16: How to choose collaboration mode?

**A:** Choose based on task type:

| Mode | Use Case | Example |
|------|----------|---------|
| **Pipeline** | Sequential tasks | Dev→Review→Test→Deploy |
| **Route** | Content-based routing | Route to expert Bot |
| **Coordinate** | Parallel task aggregation | Multi-angle analysis |
| **Collaborate** | Free discussion | Brainstorming, problem-solving |

See [Collaboration Models](./concepts/collaboration-models.md)

### Q17: Can Bots be reused?

**A:** Yes. Bots can be reused across multiple Teams:

```yaml
# Team 1
spec:
  members:
    - botRef:
        name: shared-developer-bot  # Reuse

# Team 2
spec:
  members:
    - botRef:
        name: shared-developer-bot  # Reuse
```

Each Team can configure different task prompts for the same Bot.

### Q18: How to control agent costs?

**A:** Several methods:

1. **Choose appropriate models**:
   - Simple tasks: Haiku (cheap)
   - Complex tasks: Sonnet or Opus

2. **Optimize prompts**:
   - Clear, specific instructions
   - Avoid redundancy

3. **Set limits**:
   - Maximum tokens
   - Timeout
   - Maximum retries

4. **Monitor usage**:
   - Check task logs
   - Track API calls

---

## ⚡ Performance & Optimization

### Q19: How to improve task execution speed?

**A:** Several optimization methods:

1. **Increase concurrent executors**:
```bash
# In .env
MAX_CONCURRENT_TASKS=10  # Default is 5
```

2. **Use faster models**:
   - Haiku faster than Sonnet
   - Local models faster than API

3. **Optimize Docker**:
   - Use SSD
   - Increase memory limits
   - Use image cache

4. **Optimize database**:
   - Regular log cleanup
   - Add indexes
   - Use connection pooling

### Q20: How many concurrent tasks are supported?

**A:** Depends on hardware:

| Hardware | Recommended Concurrent |
|----------|----------------------|
| 2core 4GB | 2-3 |
| 4core 8GB | 5-8 |
| 8core 16GB | 10-15 |
| 16core 32GB | 20-30 |

Adjust via `MAX_CONCURRENT_TASKS` environment variable.

---

## 🔍 Troubleshooting

### Q21: Task stuck in PENDING status?

**A:** Possible causes and solutions:

1. **Executor Manager not running**:
```bash
docker-compose ps executor_manager
docker-compose logs executor_manager
```

2. **No available Executors**:
```bash
docker ps | grep executor
```

3. **Insufficient resources**:
   - Check CPU and memory usage
   - Increase `MAX_CONCURRENT_TASKS`

4. **Configuration error**:
   - Check Bot, Shell, Model configuration
   - View error logs

See [Troubleshooting Guide](./troubleshooting.md)

### Q22: API returns 500 error?

**A:**

1. **Check backend logs**:
```bash
docker-compose logs backend
```

2. **Check database connection**:
```bash
docker-compose exec backend python -c "from app.db import engine; engine.connect()"
```

3. **Check environment variables**:
```bash
docker-compose exec backend env | grep DATABASE_URL
```

### Q23: Frontend cannot connect to backend?

**A:**

1. **Check API URL configuration**:
```bash
# frontend/.env.local
NEXT_PUBLIC_API_URL=http://localhost:8000
```

2. **Check CORS settings**:
   - Ensure backend allows frontend domain

3. **Check firewall**:
   - Ensure port 8000 is not blocked

4. **Check service status**:
```bash
curl http://localhost:8000/api/health
```

---

## 📞 Get More Help

If your question is not listed here:

1. 📖 View [Full Documentation](./README.md)
2. 🔍 Search [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
3. 🐛 Check [Troubleshooting Guide](./troubleshooting.md)
4. 💬 Create new Issue
5. 🌟 Join community discussions

---

## 🔄 Continuous Updates

This FAQ is continuously updated based on user feedback. If you have new questions or suggestions:

- Submit Issue
- Submit Pull Request
- Participate in community discussions

---

<p align="center">Hope these answers help! 🎉</p>

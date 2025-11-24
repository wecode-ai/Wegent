# 🚀 Quick Start

This guide will help you get started with the Wegent platform in 5 minutes.

---

## 📋 Prerequisites

Before you begin, ensure your system has:

- **Docker** and **Docker Compose**
- **Git**

---

## ⚡ Get Started in 5 Steps

### Step 1: Clone the Repository

```bash
git clone https://github.com/wecode-ai/wegent.git
cd wegent
```

### Step 2: Start the Platform

```bash
docker-compose up -d
```

This will start all required services:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:8000
- **API Documentation**: http://localhost:8000/api/docs
- **MySQL**: localhost:3306
- **Redis**: localhost:6379
- **Executor Manager**: http://localhost:8001

### Step 3: Access the Web Interface

Open http://localhost:3000 in your browser

### Step 4: Configure GitHub Access Token

Follow the on-page instructions to configure your GitHub access token for code repository integration.

**Steps to Create a GitHub Token:**

1. Visit GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
2. Click "Generate new token (classic)"
3. Set permission scopes:
   - `repo` - Full repository access
   - `workflow` - Workflow permissions
4. Generate and copy the token
5. Configure this token in the Wegent platform

### Step 5: Configure Bot

Wegent ships with a built-in development bot. For the Claude Code runtime, set the following environment variables:

```json
{
  "env": {
    "ANTHROPIC_MODEL": "openrouter,anthropic/claude-sonnet-4",
    "ANTHROPIC_AUTH_TOKEN": "sk-xxxxxx",
    "ANTHROPIC_BASE_URL": "http://xxxxx",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "openrouter,anthropic/claude-haiku-4.5"
  }
}
```

⚠️ **Note**: Some runtimes may use `ANTHROPIC_API_KEY` instead of `ANTHROPIC_AUTH_TOKEN`. See documentation for details.

📖 **Need more detailed configuration instructions?**
- [Shell (Executor) Configuration Guide](../guides/user/configuring-shells.md)
- [Model Configuration Guide](../guides/user/configuring-models.md)

---

## 🎯 Run Your First Task

1. **Select Project and Branch**
   - On the task page, select your GitHub project
   - Choose the target branch

2. **Describe Development Requirements**

   For example:
   ```
   Implement a bubble sort algorithm using Python, with complete docstrings and unit tests
   ```

3. **Submit Task**

   After submission, the agent team will automatically:
   - Create a new branch
   - Write code
   - Commit changes
   - Create a Pull Request

4. **View Results**

   Check execution progress and results on the task details page

---

## 📖 Next Steps

Congratulations on running your first task! Here's what to explore next:

### 📚 Learn More

- [Detailed Installation Guide](./installation.md) - Learn about production deployment
- [Core Concepts](../concepts/core-concepts.md) - Understand Ghost, Bot, Team, and more
- [Architecture Overview](../concepts/architecture.md) - Learn about Wegent's architecture

### 🎨 Create Custom Agents

- [Creating Ghosts](../guides/user/creating-ghosts.md) - Define the "soul" of your agents
- [Creating Bots](../guides/user/creating-bots.md) - Assemble complete agent instances
- [Creating Teams](../guides/user/creating-teams.md) - Build collaborative teams

### 💻 Development & Extension

- [Development Setup](../guides/developer/setup.md) - Set up local development environment

---

## 🔧 Troubleshooting

### Service Failed to Start?

```bash
# View service logs
docker-compose logs -f

# Restart services
docker-compose restart
```

### Cannot Access Web Interface?

- Ensure port 3000 is not occupied
- Check if Docker containers are running: `docker-compose ps`

### API Connection Failed?

- Ensure backend service is running
- Visit http://localhost:8000/api/docs to check API status

---

## 📞 Get Help

- 📖 [Full Documentation](../README.md)
- 🐛 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
- 💬 [FAQ](../faq.md)

---

<p align="center">Happy coding! 🎉</p>

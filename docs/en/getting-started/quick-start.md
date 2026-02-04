---
sidebar_position: 1
---

# 🚀 Quick Start

This guide will help you get started with the Wegent platform quickly.

---

## 📋 Prerequisites

Before you begin, ensure your system has:

- **Docker** and **Docker Compose**

---

## ⚡ One-Click Start

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

Then open http://localhost:3000 in your browser.

> Optional: Enable RAG features with `docker compose --profile rag up -d`

---

## 📦 Built-in Agents

| Team | Purpose |
|------|---------|
| chat-team | General AI assistant + Mermaid diagrams |
| translator | Multi-language translation |
| dev-team | Git workflow: branch → code → commit → PR |
| wiki-team | Codebase Wiki documentation generation |

---

## 🏗️ Architecture

```
Frontend (Next.js) → Backend (FastAPI) → Executor Manager → Executors (ClaudeCode/Agno/Dify/Chat)
```

**Core Concepts:**
- **Ghost** (prompt) + **Shell** (environment) + **Model** = **Bot**
- Multiple **Bots** + **Collaboration Mode** = **Team**

---

## 📖 Next Steps

Congratulations on starting Wegent! Here's what to explore next:

### 📚 Learn More

- [Detailed Installation Guide](./installation.md) - Learn about production deployment
- [Core Concepts](../concepts/core-concepts.md) - Understand Ghost, Bot, Team, and more
- [Architecture Overview](../concepts/architecture.md) - Learn about Wegent's architecture

### 🎨 Create Custom Agents

- [Agent Settings](../guides/user/agent-settings.md) - Configure agents, bots, prompts, and collaboration modes
- [Collaboration Models](../concepts/collaboration-models.md) - Learn about multi-bot collaboration

### 💻 Development & Extension

- [Development Setup](../guides/developer/setup.md) - Set up local development environment

---

## 🔧 Troubleshooting

### Service Failed to Start?

```bash
# View service logs
docker compose logs -f

# Restart services
docker compose restart
```

### Cannot Access Web Interface?

- Ensure port 3000 is not occupied
- Check if Docker containers are running: `docker compose ps`

### API Connection Failed?

- Ensure backend service is running
- Visit http://localhost:8000/api/docs to check API status

---

## 📞 Get Help

- 📖 [Full Documentation](../README.md)
- 🐛 [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
- 💬 [Discord Community](https://discord.gg/MVzJzyqEUp)

---

<p align="center">Happy coding! 🎉</p>

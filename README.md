# Wegent

> 🚀 An open-source AI-native operating system to define, organize, and run intelligent agent teams

English | [简体中文](README_zh.md)

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.68+-green.svg)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-15+-black.svg)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://docker.com)
[![Claude](https://img.shields.io/badge/Claude-Code-orange.svg)](https://claude.ai)
[![Gemini](https://img.shields.io/badge/Gemini-supported-4285F4.svg)](https://ai.google.dev)
[![Version](https://img.shields.io/badge/version-1.0.20-brightgreen.svg)](https://github.com/wecode-ai/wegent/releases)

<div align="center">

**YAML-driven agent teams | 4 collaboration modes | Real-time group chat | Sandboxed execution**

<img src="./docs/assets/images/example.gif" width="75%" alt="Demo"/>

[Quick Start](#-quick-start) · [Documentation](docs/en/README.md) · [Development Guide](docs/en/guides/developer/setup.md)

</div>

---

## ✨ Core Scenarios

### 💬 Chat Mode
Multi-LLM (Claude/OpenAI/Gemini) · Multimodal · Web Search · Deep Thinking
**Collaboration**: 4 modes · Group chat · Task sharing · On-demand Skills
**Integration**: MCP tools · OpenAI-compatible API · Export PDF/DOCX

### 💻 Code Mode
**Git Integration**: GitHub / GitLab / Gitea / Gitee / Gerrit
**Execution**: ClaudeCode · Agno · Sandboxed isolation · Parallel execution
**Assist**: Requirement clarification · Wiki generation · Error correction

### 📚 Knowledge Mode *(Experimental)*
**RAG**: Vector/Keyword/Hybrid retrieval · Elasticsearch/Qdrant
**Documents**: PDF · Markdown · DOCX · Code files

---

## 🔧 Extensibility

**Agent Wizard** - 4-step creation: Describe → AI clarifies → Live test → One-click create
**YAML Config** - Kubernetes-style CRD, pure config for Ghost/Bot/Team/Skill
**MCP Tools** - Model Context Protocol for external tools and services
**Execution Engines** - ClaudeCode (Docker) · Agno (Docker) · Dify (API) · Chat (Direct)

---

## 🔐 Deployment & Operations
OIDC/SSO · Namespace isolation · API Key management · OpenTelemetry · Admin panel · i18n (en/zh) · Dark Mode

---

## 🚀 Quick Start

```bash
git clone https://github.com/wecode-ai/wegent.git && cd wegent
docker-compose up -d
# Open http://localhost:3000
```

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

`Frontend (Next.js)` → `Backend (FastAPI)` → `Executor Manager` → `Executors (ClaudeCode/Agno/Dify/Chat)`

> **Core Concepts**: Ghost (prompt) + Shell (environment) + Model = Bot → Multiple Bots + Collaboration = Team
> See [Core Concepts](docs/en/concepts/core-concepts.md) | [YAML Spec](docs/en/reference/yaml-specification.md)

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## 📞 Support

- 🐛 Issues: [GitHub Issues](https://github.com/wecode-ai/wegent/issues)

## 👥 Contributors

Thanks to the following developers for their contributions and efforts to make this project better. 💪

<!-- readme: contributors -start -->
<table>
<tr>
    <td align="center">
        <a href="https://github.com/qdaxb">
            <img src="https://avatars.githubusercontent.com/u/4157870?v=4" width="80;" alt="qdaxb"/>
            <br />
            <sub><b>Axb</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/feifei325">
            <img src="https://avatars.githubusercontent.com/u/46489071?v=4" width="80;" alt="feifei325"/>
            <br />
            <sub><b>Feifei</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/Micro66">
            <img src="https://avatars.githubusercontent.com/u/27556103?v=4" width="80;" alt="Micro66"/>
            <br />
            <sub><b>MicroLee</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/cc-yafei">
            <img src="https://avatars.githubusercontent.com/u/78540184?v=4" width="80;" alt="cc-yafei"/>
            <br />
            <sub><b>YaFei Liu</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/johnny0120">
            <img src="https://avatars.githubusercontent.com/u/15564476?v=4" width="80;" alt="johnny0120"/>
            <br />
            <sub><b>Johnny0120</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/moqimoqidea">
            <img src="https://avatars.githubusercontent.com/u/39821951?v=4" width="80;" alt="moqimoqidea"/>
            <br />
            <sub><b>Moqimoqidea</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/kissghosts">
            <img src="https://avatars.githubusercontent.com/u/3409715?v=4" width="80;" alt="kissghosts"/>
            <br />
            <sub><b>Yanhe</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/2561056571">
            <img src="https://avatars.githubusercontent.com/u/112464849?v=4" width="80;" alt="2561056571"/>
            <br />
            <sub><b>Xuemin</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/junbaor">
            <img src="https://avatars.githubusercontent.com/u/10198622?v=4" width="80;" alt="junbaor"/>
            <br />
            <sub><b>Junbaor</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/joyway1978">
            <img src="https://avatars.githubusercontent.com/u/184585080?v=4" width="80;" alt="joyway1978"/>
            <br />
            <sub><b>Joyway78</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/fengkuizhi">
            <img src="https://avatars.githubusercontent.com/u/3616484?v=4" width="80;" alt="fengkuizhi"/>
            <br />
            <sub><b>Fengkuizhi</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/jolestar">
            <img src="https://avatars.githubusercontent.com/u/77268?v=4" width="80;" alt="jolestar"/>
            <br />
            <sub><b>Jolestar</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/andrewzq777">
            <img src="https://avatars.githubusercontent.com/u/223815624?v=4" width="80;" alt="andrewzq777"/>
            <br />
            <sub><b>Andrewzq777</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/graindt">
            <img src="https://avatars.githubusercontent.com/u/3962041?v=4" width="80;" alt="graindt"/>
            <br />
            <sub><b>Graindt</b></sub>
        </a>
    </td></tr>
</table>
<!-- readme: contributors -end -->

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>

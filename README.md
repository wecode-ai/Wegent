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

<img src="https://github.com/user-attachments/assets/677abce3-bd3f-4064-bdab-e247b142c22f" width="100%" alt="Chat Mode Demo"/>

<img src="https://github.com/user-attachments/assets/2b210d33-2569-4bc9-acac-e163de4e12a5" width="100%" alt="Knowledge Demo"/>

<img src="https://github.com/user-attachments/assets/cc25c415-d3f1-4e9f-a64c-1d2614d69c7d" width="100%" alt="Code Mode Demo"/>

[Quick Start](#-quick-start) · [Documentation](docs/en/README.md) · [Development Guide](docs/en/guides/developer/setup.md)

</div>

---

## ✨ Core Features

### 💬 Chat Mode

A fully open-source chat agent with powerful capabilities:

- **Multi-Model Support**: Compatible with Claude, OpenAI, Gemini, DeepSeek, GLM and other mainstream models
- **Conversation History**: Create new conversations, multi-turn dialogues, save and share chat history
- **Group Chat**: AI group chat where AI responds based on conversation context with @mentions
- **Attachment Parsing**: Send txt, pdf, ppt, doc, images and other file formats in single/group chats
- **Follow-up Mode**: AI asks clarifying questions to help refine your requirements
- **Error Correction Mode**: Multiple AI models automatically detect and correct response errors
- **Long-term Memory**: Supports mem0 integration for conversation memory persistence
- **Sandbox Execution**: Execute commands or modify files via sandbox, E2B protocol compatible
- **Extensions**: Customize prompts, MCP tools and Skills (includes chart drawing skill)

### 💻 Code Mode

A cloud-based Claude Code execution engine:

- **Multi-Model Configuration**: Configure various Claude-compatible models
- **Concurrent Execution**: Run multiple coding tasks simultaneously in the cloud
- **Requirement Clarification**: AI analyzes code and asks questions to generate specification documents
- **Git Integration**: Integrate with GitHub/GitLab/Gitea/Gerrit to clone, modify and create PRs
- **MCP/Skill Support**: Configure MCP tools and Skills for agents
- **Multi-turn Conversations**: Continue conversations with follow-up questions

### 📡 Feed Mode

A cloud-based AI task trigger system:

- **Full Capability Access**: Tasks can use all Chat and Code mode capabilities
- **Scheduled/Event Triggers**: Set up cron schedules or event-based AI task execution
- **Information Feed**: Display AI-generated content as an information stream
- **Event Filtering**: Filter conditions like "only notify me if it will rain tomorrow"

### 📚 Knowledge Mode

A cloud-based AI document repository:

- **Document Management**: Upload and manage txt/doc/ppt/xls and other document formats
- **Web Import**: Import web pages and DingTalk multi-dimensional tables
- **NotebookLM Mode**: Select documents directly in notebooks for Q&A
- **Online Editing**: Edit text files directly in notebook mode
- **Chat Integration**: Reference knowledge bases in single/group chats for AI responses

### 🔧 Customization

All features above are fully customizable:

- **Custom Agents**: Create custom agents in the web UI, configure prompts, MCP, Skills and multi-agent collaboration
- **Agent Creation Wizard**: 4-step creation: Describe requirements → AI asks questions → Real-time fine-tuning → One-click create
- **Organization Management**: Create and join groups, share agents, models, Skills within groups

---

## 🔧 Extensibility
- **Agent Creation Wizard**: 4-step creation: Describe requirements → AI asks questions → Real-time fine-tuning → One-click create
- **Collaboration Modes**: 4 out-of-the-box multi-Agent collaboration modes (Sequential/Parallel/Router/Loop)
- **Skill Support**: Dynamically load skill packages to improve Token efficiency
- **MCP Tools**: Model Context Protocol for calling external tools and services
- **Execution Engines**: ClaudeCode / Agno sandboxed isolation, Dify API proxy, Chat direct mode
- **YAML Config**: Kubernetes-style CRD for defining Ghost / Bot / Team / Skill
- **API**: OpenAI-compatible interface for easy integration with other systems

---

## 🚀 Quick Start

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

> See [Core Concepts](docs/en/concepts/core-concepts.md) | [YAML Spec](docs/en/reference/yaml-specification.md)

---

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## 📞 Support

- 🐛 Issues: [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
- 💬 Discord: [Join our community](https://discord.gg/MVzJzyqEUp)

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
        <a href="https://github.com/kissghosts">
            <img src="https://avatars.githubusercontent.com/u/3409715?v=4" width="80;" alt="kissghosts"/>
            <br />
            <sub><b>Yanhe</b></sub>
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
        <a href="https://github.com/moqimoqidea">
            <img src="https://avatars.githubusercontent.com/u/39821951?v=4" width="80;" alt="moqimoqidea"/>
            <br />
            <sub><b>Moqimoqidea</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/2561056571">
            <img src="https://avatars.githubusercontent.com/u/112464849?v=4" width="80;" alt="2561056571"/>
            <br />
            <sub><b>Xuemin</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/yixiangxx">
            <img src="https://avatars.githubusercontent.com/u/3120662?v=4" width="80;" alt="yixiangxx"/>
            <br />
            <sub><b>Yi Xiang</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/junbaor">
            <img src="https://avatars.githubusercontent.com/u/10198622?v=4" width="80;" alt="junbaor"/>
            <br />
            <sub><b>Junbaor</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/icycrystal4">
            <img src="https://avatars.githubusercontent.com/u/946207?v=4" width="80;" alt="icycrystal4"/>
            <br />
            <sub><b>Icycrystal4</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/FicoHu">
            <img src="https://avatars.githubusercontent.com/u/19767574?v=4" width="80;" alt="FicoHu"/>
            <br />
            <sub><b>FicoHu</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/maquan0927">
            <img src="https://avatars.githubusercontent.com/u/40860588?v=4" width="80;" alt="maquan0927"/>
            <br />
            <sub><b>Just Quan</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/fingki">
            <img src="https://avatars.githubusercontent.com/u/11422037?v=4" width="80;" alt="fingki"/>
            <br />
            <sub><b>Fingki</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/parabala">
            <img src="https://avatars.githubusercontent.com/u/115564000?v=4" width="80;" alt="parabala"/>
            <br />
            <sub><b>Parabala</b></sub>
        </a>
    </td></tr>
<tr>
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
        <a href="https://github.com/qwertyerge">
            <img src="https://avatars.githubusercontent.com/u/13088125?v=4" width="80;" alt="qwertyerge"/>
            <br />
            <sub><b>Erdawang</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/sunnights">
            <img src="https://avatars.githubusercontent.com/u/1886887?v=4" width="80;" alt="sunnights"/>
            <br />
            <sub><b>Jake Zhang</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/DeadLion">
            <img src="https://avatars.githubusercontent.com/u/2594907?v=4" width="80;" alt="DeadLion"/>
            <br />
            <sub><b>Jasper Zhong</b></sub>
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
    </td>
    <td align="center">
        <a href="https://github.com/salt-hai">
            <img src="https://avatars.githubusercontent.com/u/43851000?v=4" width="80;" alt="salt-hai"/>
            <br />
            <sub><b>Salt-hai</b></sub>
        </a>
    </td></tr>
</table>
<!-- readme: contributors -end -->

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>

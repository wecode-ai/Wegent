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

## ✨ Core Modes

| 💬 Chat Mode | 💻 Code Mode | 📚 Knowledge Mode |
|:-------------|:-------------|:-----------------------------------|
| **LLM**: Supports Claude / OpenAI / Gemini and other mainstream models<br>**Multimodal**: Supports automatic parsing of images / PPT / Word / PDF / Excel files<br>**Web Search**: Supports integration with various search engines<br>**Deep Research**: Supports deep research mode with automatic search, organization, and report generation<br>**Error Correction**: Multiple AIs automatically detect and correct errors in responses<br>**Follow-up Mode**: AI proactively asks clarifying questions to ensure accurate understanding<br>**Extensions**: Supports Skill packages / MCP tools / Custom tools | **Multi-platform Integration**: Supports GitHub / GitLab / Gitea / Gitee / Gerrit platforms<br>**Automated AI Workflow**: Branch → Code → Commit → PR automation<br>**Requirement Clarification**: AI proactively asks questions to ensure accurate understanding<br>**Wiki Generation**: Automatic codebase documentation generation | **RAG Retrieval**: Vector / Keyword / Hybrid retrieval<br>**Storage Backends**: Elasticsearch / Qdrant<br>**Document Parsing**: PDF / Markdown / DOCX / Code files<br>**Wiki**: Automatic codebase documentation generation |

---

## 🔧 Extensibility

- **Agent Creation Wizard**: 4-step creation: Describe requirements → AI asks questions → Real-time fine-tuning → One-click create
- **Collaboration Modes**: 4 out-of-the-box multi-Agent collaboration modes (Sequential/Parallel/Router/Loop), flexible combination of multiple Bots
- **Skill Support**: Dynamically load skill packages to improve Token efficiency
- **MCP Tools**: Model Context Protocol for calling external tools and services
- **Execution Engines**: Supports ClaudeCode / Agno sandboxed isolation, Dify API proxy, Chat direct mode - 4 execution engines
- **YAML Config**: Kubernetes-style CRD for defining Ghost / Bot / Team / Skill
- **API**: Provides OpenAI-compatible interface for easy integration with other systems

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
        <a href="https://github.com/junbaor">
            <img src="https://avatars.githubusercontent.com/u/10198622?v=4" width="80;" alt="junbaor"/>
            <br />
            <sub><b>Junbaor</b></sub>
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
        <a href="https://github.com/icycrystal4">
            <img src="https://avatars.githubusercontent.com/u/946207?v=4" width="80;" alt="icycrystal4"/>
            <br />
            <sub><b>Icycrystal4</b></sub>
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
        <a href="https://github.com/yixiangxx">
            <img src="https://avatars.githubusercontent.com/u/3120662?v=4" width="80;" alt="yixiangxx"/>
            <br />
            <sub><b>Yi Xiang</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/parabala">
            <img src="https://avatars.githubusercontent.com/u/115564000?v=4" width="80;" alt="parabala"/>
            <br />
            <sub><b>Parabala</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/fengkuizhi">
            <img src="https://avatars.githubusercontent.com/u/3616484?v=4" width="80;" alt="fengkuizhi"/>
            <br />
            <sub><b>Fengkuizhi</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/jolestar">
            <img src="https://avatars.githubusercontent.com/u/77268?v=4" width="80;" alt="jolestar"/>
            <br />
            <sub><b>Jolestar</b></sub>
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
        <a href="https://github.com/fingki">
            <img src="https://avatars.githubusercontent.com/u/11422037?v=4" width="80;" alt="fingki"/>
            <br />
            <sub><b>Fingki</b></sub>
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
            <sub><b>salt-hai</b></sub>
        </a>
    </td></tr>
</table>
<!-- readme: contributors -end -->

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>

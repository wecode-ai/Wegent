# Wegent

> A self-hostable AI workspace for chat, coding, knowledge bases, automation, and local execution.

English | [简体中文](README_zh.md)

[![Python](https://img.shields.io/badge/python-3.10--3.13-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.109+-green.svg)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-15+-black.svg)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://docker.com)
[![Claude](https://img.shields.io/badge/Claude-Code-orange.svg)](https://claude.ai)
[![Gemini](https://img.shields.io/badge/Gemini-supported-4285F4.svg)](https://ai.google.dev)
[![Version](https://img.shields.io/badge/version-1.0.20-brightgreen.svg)](https://github.com/wecode-ai/wegent/releases)

<div align="center">

[Quick Start](#-quick-start) · [Core Scenarios](#core-scenarios) · [How It Grows](#how-it-grows) · [Documentation](https://wecode-ai.github.io/wegent-docs/) · [Development Guide](https://wecode-ai.github.io/wegent-docs/docs/category/developer-guide)

</div>

---

## Why Wegent

Wegent is a self-hostable AI workspace for managing chat, coding tasks, knowledge bases, automation, and local execution in one place. You can ask questions over your own materials, hand code repositories to AI, turn recurring information checks into automated feeds, and let your team use the same assistants from DingTalk, Telegram, or other tools. When a task needs local repositories or intranet access, it can run on your own machine.

- **Start privately**: Launch a self-hosted workspace with one command and begin with chat and knowledge Q&A.
- **Grow into team workflows**: Share common assistants, models, tools, and knowledge bases instead of configuring them repeatedly.
- **Choose where work runs**: Run coding tasks, automation, and local-device jobs in the environment that fits the job.
- **Fit existing tools**: Bring AI into your current workflow through APIs or IM bots.

---

## 🚀 Quick Start

Prerequisite: Docker and Docker Compose.

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- --standalone
```

This starts the default Standalone mode: one container with SQLite for local trials and lightweight deployments.

Then open http://localhost:3000 in your browser.

### Deployment Modes

| Mode | Best For |
|------|----------|
| **Standalone** (default) | Single container + SQLite, best for personal trials and lightweight deployments |
| **Standard** | Multi-container + MySQL + Redis, best for teams and production |
| **Development** | Source startup + hot reload, best for development and extensions |

```bash
# Standalone mode (default)
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- --standalone

# Standard mode
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- --standard

# Development mode
git clone https://github.com/wecode-ai/Wegent.git && cd Wegent && ./start.sh
```

<details>
<summary><b>Common Commands</b></summary>

```bash
# Standalone mode
docker logs -f wegent-standalone
docker restart wegent-standalone

# Standard mode
docker compose logs -f
docker compose down
docker compose up -d

# Development mode
./start.sh --status
./start.sh --restart
./start.sh --stop
```

</details>

See [Standalone Mode](docs/en/deployment/standalone-mode.md) and [Quick Start](docs/en/getting-started/quick-start.md) for details.

---

## Core Scenarios

### Chat, Group Chat, and File Handling

<img src="https://github.com/user-attachments/assets/677abce3-bd3f-4064-bdab-e247b142c22f" width="100%" alt="Chat Mode Demo"/>

Set up a private AI chat entrypoint. Wegent supports multiple models, multi-turn history, group chat with @mentions, file parsing, clarifying questions, answer checking, and long-term memory. When needed, AI can also read files, run commands, or generate diagrams.

### Let AI Work on Code Repositories

<img src="https://github.com/user-attachments/assets/cc25c415-d3f1-4e9f-a64c-1d2614d69c7d" width="100%" alt="Code Mode Demo"/>

Let AI work on code in isolated environments. Wegent connects to GitHub, GitLab, Gitea, and Gerrit so agents can clarify requirements, create branches, modify code, run tests, commit changes, and open pull requests.

### Track Information and Publish Feeds

<img src="https://github.com/user-attachments/assets/6680c33a-f4ba-4ef2-aa8c-e7a53bd003dc" width="100%" alt="Feed Demo"/>

Turn AI into a continuously running task trigger. Set schedules or event triggers so AI can summarize information, analyze webpages, filter notifications, and publish results as a feed.

### Knowledge Q&A

<img src="https://github.com/user-attachments/assets/2b210d33-2569-4bc9-acac-e163de4e12a5" width="100%" alt="Knowledge Demo"/>

Upload documents, import webpages, or sync DingTalk multi-dimensional tables to build team knowledge bases. Wegent handles parsing, conversion, indexing, and retrieval so AI can answer with your own materials.

### Local Device Execution

<img src="https://github.com/user-attachments/assets/ead0cc30-b3a4-4eb6-a6dd-77ffcbd72238" width="100%" alt="AI Device Demo"/>

Install a local runner on your own machine and connect it securely to Wegent. Tasks can switch between cloud environments and local devices, which is useful when AI needs access to local repositories, intranet resources, or dedicated development environments.

### Team Tools and Existing Systems

Connect Wegent agents to DingTalk, Telegram, and other IM tools, or call them from existing applications through an API.

---

## How It Grows

You do not need to learn every concept upfront. Wegent can start as a private AI workspace: choose a model, create an assistant, upload materials, and chat. As your team starts reusing these capabilities, you can turn common assistants, knowledge bases, coding tasks, and IM entrypoints into shared workflows.

| Stage | How You Can Use Wegent |
|-------|------------------------|
| **Personal use** | Start the service and create your own AI assistants and knowledge bases |
| **Team collaboration** | Share common assistants, model settings, knowledge bases, and coding tasks |
| **Automated workflows** | Let AI handle work through schedules, event triggers, or IM bots |
| **Deep integration** | Connect Wegent to existing systems through APIs, tools, and configuration files |

<details>
<summary><b>Core concepts for customization and extension</b></summary>

Internally, Wegent splits an AI assistant into reusable pieces:

```text
Ghost (prompt + MCP + Skills)
  + Shell (Chat / ClaudeCode / Dify)
  + Model (Claude / OpenAI / Gemini / DeepSeek / GLM, etc.)
  = Bot

Multiple Bots + collaboration mode = Team (the user-facing Agent)
Team + Workspace = Task (a traceable execution)
```

These relationships can be created in the web UI or managed with YAML. The web wizard supports "describe requirements → AI follow-up questions → live prompt tuning → one-click creation."

</details>

---

## Deployment and Integration

Wegent can grow from a personal trial to a team deployment:

- **Personal trial**: Standalone mode starts one container, suitable for a laptop or lightweight server.
- **Team deployment**: Standard mode uses dedicated database, cache, and execution services for long-running use.
- **Local devices**: Connect your own machine as a place to run tasks that need local repositories or intranet access.
- **Existing systems**: Connect Wegent to team tools through APIs or IM bots.

<details>
<summary><b>Technical component overview</b></summary>

```mermaid
graph TB
    User["User / API / IM"] --> Frontend["Next.js Web"]
    User --> Backend["FastAPI Backend"]
    Frontend --> Backend

    Backend --> MySQL[("MySQL / SQLite")]
    Backend --> Redis[("Redis")]
    Backend --> ChatShell["Chat Shell<br/>LangGraph + Multi-LLM"]
    Backend --> ExecutorManager["Executor Manager"]
    Backend --> KnowledgeRuntime["Knowledge Runtime"]

    ExecutorManager --> CloudExecutor["Cloud Executor<br/>ClaudeCode / Dify"]
    Backend <--> LocalExecutor["Local Executor<br/>WebSocket"]
    KnowledgeRuntime --> VectorStore["Elasticsearch / Qdrant / Milvus"]
    Backend --> DocConverter["Knowledge Doc Converter<br/>MinerU OCR"]
```

</details>

---

## For Developers and Team Admins

- **Application integration**: Call Wegent agents from your own apps through `/api/v1/responses`.
- **External tools**: Use MCP to let AI call existing tools and services.
- **Reusable capabilities**: Package specialized abilities as Skills and load them only when needed.
- **Flexible runtimes**: Use different runtime engines for chat, coding tasks, multi-agent work, and external app proxying.
- **Central model management**: OpenAI, Claude, Gemini, DeepSeek, GLM, and protocol-compatible model services.
- **Team sharing and permissions**: Groups, shared agents, shared models, shared Skills, and admin management.
- **Observability**: OpenTelemetry support across backend, frontend, and execution services.

---

## Built-in Assistants

| Assistant | Purpose |
|-----------|---------|
| `chat-team` | General AI assistant with Mermaid diagram support |
| `translator` | Multi-language translation |
| `dev-team` | Git workflow: branch, code, commit, PR |
| `wiki-team` | Codebase Wiki documentation generation |

---

## Documentation

- [Quick Start](docs/en/getting-started/quick-start.md)
- [Installation Guide](docs/en/getting-started/installation.md)
- [Core Concepts](docs/en/concepts/core-concepts.md)
- [Skill System](docs/en/concepts/skill-system.md)
- [YAML Specification](docs/en/reference/yaml-specification.md)
- [OpenAPI Responses API](docs/en/reference/openapi-responses-api.md)
- [Developer Guide](docs/en/developer-guide/README.md)

---

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## Support

- 🐛 Issues: [GitHub Issues](https://github.com/wecode-ai/wegent/issues)
- 💬 Discord: [Join our community](https://discord.gg/MVzJzyqEUp)

## Contributors

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
        <a href="https://github.com/Micro66">
            <img src="https://avatars.githubusercontent.com/u/27556103?v=4" width="80;" alt="Micro66"/>
            <br />
            <sub><b>MicroLee</b></sub>
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
        <a href="https://github.com/FicoHu">
            <img src="https://avatars.githubusercontent.com/u/19767574?v=4" width="80;" alt="FicoHu"/>
            <br />
            <sub><b>FicoHu</b></sub>
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
        <a href="https://github.com/icycrystal4">
            <img src="https://avatars.githubusercontent.com/u/946207?v=4" width="80;" alt="icycrystal4"/>
            <br />
            <sub><b>Icycrystal4</b></sub>
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
        <a href="https://github.com/parabala">
            <img src="https://avatars.githubusercontent.com/u/115564000?v=4" width="80;" alt="parabala"/>
            <br />
            <sub><b>Parabala</b></sub>
        </a>
    </td></tr>
<tr>
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
        <a href="https://github.com/yixiangxx">
            <img src="https://avatars.githubusercontent.com/u/3120662?v=4" width="80;" alt="yixiangxx"/>
            <br />
            <sub><b>Yi Xiang</b></sub>
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
        <a href="https://github.com/sunnights">
            <img src="https://avatars.githubusercontent.com/u/1886887?v=4" width="80;" alt="sunnights"/>
            <br />
            <sub><b>Jake Zhang</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/cocowh">
            <img src="https://avatars.githubusercontent.com/u/17496282?v=4" width="80;" alt="cocowh"/>
            <br />
            <sub><b>Birch</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/2561056571">
            <img src="https://avatars.githubusercontent.com/u/112464849?v=4" width="80;" alt="2561056571"/>
            <br />
            <sub><b>Xuemin</b></sub>
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
        <a href="https://github.com/jnhu76">
            <img src="https://avatars.githubusercontent.com/u/5766215?v=4" width="80;" alt="jnhu76"/>
            <br />
            <sub><b>Jm.hu</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/kerwin612">
            <img src="https://avatars.githubusercontent.com/u/3371163?v=4" width="80;" alt="kerwin612"/>
            <br />
            <sub><b>Kerwin Bryant</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/RockysGit">
            <img src="https://avatars.githubusercontent.com/u/61232321?v=4" width="80;" alt="RockysGit"/>
            <br />
            <sub><b>RockysGit</b></sub>
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
        <a href="https://github.com/DavidLeeUX">
            <img src="https://avatars.githubusercontent.com/u/16267902?v=4" width="80;" alt="DavidLeeUX"/>
            <br />
            <sub><b>Kva</b></sub>
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
        <a href="https://github.com/fingki">
            <img src="https://avatars.githubusercontent.com/u/11422037?v=4" width="80;" alt="fingki"/>
            <br />
            <sub><b>Fingki</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/flyhope">
            <img src="https://avatars.githubusercontent.com/u/5442948?v=4" width="80;" alt="flyhope"/>
            <br />
            <sub><b>李枨煊</b></sub>
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
        <a href="https://github.com/code-wangdi">
            <img src="https://avatars.githubusercontent.com/u/11024395?v=4" width="80;" alt="code-wangdi"/>
            <br />
            <sub><b>Code-wangdi</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/haosenwang1018">
            <img src="https://avatars.githubusercontent.com/u/167664334?v=4" width="80;" alt="haosenwang1018"/>
            <br />
            <sub><b>Sense_wang</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/LiDaiyan">
            <img src="https://avatars.githubusercontent.com/u/36092701?v=4" width="80;" alt="LiDaiyan"/>
            <br />
            <sub><b>Li Daiyan</b></sub>
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
        <a href="https://github.com/DeadLion">
            <img src="https://avatars.githubusercontent.com/u/2594907?v=4" width="80;" alt="DeadLion"/>
            <br />
            <sub><b>Jasper Zhong</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/rayzhang0603">
            <img src="https://avatars.githubusercontent.com/u/2917437?v=4" width="80;" alt="rayzhang0603"/>
            <br />
            <sub><b>Ray</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/RichardoMrMu">
            <img src="https://avatars.githubusercontent.com/u/44485717?v=4" width="80;" alt="RichardoMrMu"/>
            <br />
            <sub><b>RichardoMu</b></sub>
        </a>
    </td></tr>
<tr>
    <td align="center">
        <a href="https://github.com/Ged0">
            <img src="https://avatars.githubusercontent.com/u/4569451?v=4" width="80;" alt="Ged0"/>
            <br />
            <sub><b>_</b></sub>
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
        <a href="https://github.com/ch15084">
            <img src="https://avatars.githubusercontent.com/u/2509224?v=4" width="80;" alt="ch15084"/>
            <br />
            <sub><b>Ch15084</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/gdouyang">
            <img src="https://avatars.githubusercontent.com/u/13996763?v=4" width="80;" alt="gdouyang"/>
            <br />
            <sub><b>Gdouyang</b></sub>
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
        <a href="https://github.com/qingchengliu">
            <img src="https://avatars.githubusercontent.com/u/20255838?v=4" width="80;" alt="qingchengliu"/>
            <br />
            <sub><b>Qingcheng</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/salt-hai">
            <img src="https://avatars.githubusercontent.com/u/43851000?v=4" width="80;" alt="salt-hai"/>
            <br />
            <sub><b>Salt-hai</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/wxcfox">
            <img src="https://avatars.githubusercontent.com/u/33141411?v=4" width="80;" alt="wxcfox"/>
            <br />
            <sub><b>Wxcfox</b></sub>
        </a>
    </td></tr>
</table>
<!-- readme: contributors -end -->

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>

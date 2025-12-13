# Wegent
> 🚀 An open-source platform to define, organize, and run Agentic AI

English | [简体中文](README_zh.md)

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.68+-green.svg)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-15+-black.svg)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://docker.com)
[![Claude](https://img.shields.io/badge/Claude-Code-orange.svg)](https://claude.ai)
[![Gemini](https://img.shields.io/badge/Gemini-supported-4285F4.svg)](https://ai.google.dev)
[![Version](https://img.shields.io/badge/version-1.0.20-brightgreen.svg)](https://github.com/wecode-ai/wegent/releases)

<div align="center">

### 🚀 **Build Your Own AI Agent Workforce**

*From coding assistants to news analysts - deploy intelligent agents that actually work*

[Quick Start](docs/en/getting-started/quick-start.md) · [Use Cases](#-what-can-you-build) · [Documentation](docs/en/README.md) · [Development Guide](docs/en/guides/developer/setup.md)

</div>

---

## 💡 What Can You Build?
<img src="./docs/assets/images/example.gif" width="75%" alt="Demo Video"/>
Wegent empowers you to create powerful AI applications through intelligent agent orchestration:

### 💬 **Instant AI Chat**
Get started immediately with the built-in default chat team - no configuration required. Supports multiple LLM providers including Claude, OpenAI, and Gemini. Optional web search integration for real-time information retrieval.

### 🖥️ **Web-Based Coding Assistant**
Build a full-featured development environment in your browser with GitHub integration, supporting independent development spaces locally or in the cloud, capable of running multiple Coding Agents simultaneously.

### 📰 **News Intelligence Platform**
Create a smart news aggregation and analysis system with multi-agent collaboration patterns.

### 🔧 **Custom Agent Applications**
The possibilities are endless - build agents for:
- **Data Analysis**: Automated report generation and visualization
- **Content Creation**: Blog posts, social media, and marketing materials
- **Customer Support**: Intelligent chatbots with contextual understanding
- **DevOps Automation**: CI/CD pipeline management and monitoring
- **Research Assistant**: Literature review and knowledge synthesis

---

## 📖 What is Wegent?

Wegent is an open-source AI native operating system that enables you to define, organize, and run intelligent agents at scale. Built on Kubernetes-style declarative API and CRD (Custom Resource Definition) design patterns, Wegent provides a standardized framework for creating and managing AI agent ecosystems.

### 🌟 Core Capabilities

1. **🎨 Configuration-Driven Agent Teams**: Define and run personalized agent teams through YAML configuration with web UI - no secondary development required. Includes built-in default chat team for instant start
2. **⚙️ Multi Execution Engines**: Built on Agno and Claude Code agent engines, with Chat Shell supporting direct LLM API calls (Claude, OpenAI, Gemini)
3. **🔒 Isolated Sandbox Environments**: Each agent team runs in an independent sandbox, enabling multiple teams to execute simultaneously
4. **🤝 Advanced Collaboration Modes**: Dialogue mode supports parallel, leader-based, solo mode and other agent collaboration patterns for complex workflows like news insights and content retrieval
5. **💻 AI Coding Integration**: Coding mode integrates with GitHub/GitLab and other code services to implement AI-driven development, code review, and other coding workflows
6. **🔍 Web Search Integration**: Optional web search capability for Chat Shell teams, supporting multiple search engines through a generic HTTP adapter (SearXNG, Google Custom Search, Bing, Brave, etc.) with user-selectable engine preferences.

```mermaid
graph LR
    subgraph AIResource ["🌐 AI Native Resource"]
        subgraph YAMLDef ["📄 YAML Definitions"]
            Ghost["👻 Ghost<br/>Agent Soul"]
            Model["🧠 Model<br/>Model Configuration"]
            Shell["🐚 Shell<br/>Agent Program"]
            Bot["🤖 Bot<br/>Agent Instance"]
            CollabModel["🤝 Collaboration<br/>Collaboration Model"]
            Team["👥 Team<br/>Collaborative Team"]
        end
     end
    
    subgraph Wegent ["🚀 Wegent"]
        Workspace["💼 Workspace<br/>Work Environment"]
        TeamInstance["👥 Agent Team Instance<br/>Running Team"]
    end
   
      User["👤 User"]
      Task["🎯 Task<br/>User Task"]
    %% CRD Resource Relationships
    Ghost --> Bot
    Model --> Bot
    Shell --> Bot
    Bot --> Team
    CollabModel --> Team
    Shell --> Team
    
    %% Team Definition to Instance
    AIResource --> Wegent
    Workspace --> TeamInstance
    
    %% User Interaction Flow
    User --> Task
    Task --> TeamInstance
    TeamInstance --> Task
    
    %% Styling
    classDef yamlBox stroke-dasharray: 5 5
    classDef runtimeBox stroke:#ff6b6b,stroke-width:2px
    classDef resourceBox stroke:#4ecdc4,stroke-width:2px
    
    class YAMLDef yamlBox
    class Runtime runtimeBox
    class AIResource resourceBox

```

### 🎯 Key Concepts

> **📖 Terminology Note**: In code, `Team` corresponds to "**智能体 (Agent)**" in the Chinese UI, and `Bot` corresponds to "**机器人 (Bot)**" in the Chinese UI. Users interact with "Teams" (智能体) to execute tasks, while "Bots" (机器人) are the building blocks that make up Teams.

- **👻 Ghost**: The "soul" of an agent - defines personality, capabilities, and behavior patterns
- **🧠 Model**: AI model configuration - defines environment variables and model parameters
- **🐚 Shell**: The "executable" - A program capable of launching an agent
- **🤖 Bot (机器人)**: A complete agent instance combining Ghost + Shell + Model
- **👥 Team (智能体)**: Composed of multiple Bots + Collaboration Model - the user-facing AI agent
- **🤝 Collaboration**: Defines the interaction patterns between Bots in a Team (like Workflow)
- **💼 Workspace**: Isolated work environments for tasks and projects
- **🎯 Task**: Executable units of work assigned to Teams (智能体)

> 💡 **Detailed YAML Configuration Documentation**:
- [Complete YAML configuration examples and field descriptions](docs/en/reference/yaml-specification.md)

## 🚀 Quick Start

### Prerequisites

- Docker and Docker Compose
- Git

1. **Clone the repository**
   ```bash
   git clone https://github.com/wecode-ai/wegent.git
   cd wegent
   ```

2. **Start the platform**
   ```bash
   docker-compose up -d
   ```

3. **Access the web interface**
   - Open http://localhost:3000 in your browser

4. **Configure GitHub Access Tokens**
   - Follow the page instructions to configure your GitHub access token
5. **Configure Bot**

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

   **Important - Environment Variable Names:**

   Different Shell runtimes use different environment variable names for API authentication:

   - **Claude Code Shell**: Uses `ANTHROPIC_AUTH_TOKEN`
   - **Agno Shell**: Uses `ANTHROPIC_API_KEY`
   - **Dify Shell**: Uses `DIFY_API_KEY` and `DIFY_BASE_URL`
   - **Chat Shell**: Uses `OPENAI_API_KEY` (OpenAI), `ANTHROPIC_API_KEY` (Claude), or `GOOGLE_API_KEY` (Gemini)

   Please set the correct variable based on your Shell configuration. Check the Shell's documentation or the `executor/agents/` code for specific requirements.

6. **Run task**

   On the task page, select your project and branch, describe your development requirements, such as implementing a bubble sort algorithm using Python

## 🏗️ Architecture

```mermaid
graph TB
    subgraph "🖥️ Management Platform Layer"
        Frontend["🌐 Next.js Frontend"]
        Backend["⚙️ FastAPI Backend"]
        API["🚀 Declarative API"]
    end
    
    subgraph "📊 Data Layer"
        MySQL[("💾 MySQL Database")]
    end
    
    subgraph "🔍 Execution Layer"
        ExecutorManager["💯 Executor Manager"]
        Executor1["🚀 Executor 1"]
        Executor2["🚀 Executor 2"]
        ExecutorN["🚀 Executor N"]
    end
    
    subgraph "🤖 Agent Layer"
        Claude["🧠 Claude Code"]
        Agno["💻 Agno"]
        Dify["✨ Dify"]
        Chat["💬 Chat<br/>(Claude/OpenAI/Gemini)"]
    end


    %% System Interactions
    Frontend --> API
    API --> Backend
    Backend --> MySQL
    Backend --> ExecutorManager
    ExecutorManager --> Executor1
    ExecutorManager --> Executor2
    ExecutorManager --> ExecutorN

    %% AI Program Integration
    Executor1 --> Claude
    Executor2 --> Agno
    ExecutorN --> Dify
```

## 🛠️ Development

For detailed development setup instructions, please see the [Development Guide](docs/en/guides/developer/setup.md).

### Project Structure

```
wegent/
├── backend/          # FastAPI backend service
├── frontend/         # Next.js web interface
├── executor/         # Task execution engine
├── executor_manager/ # Execution orchestration
├── shared/           # Common utilities and models
├── wegent-cli/       # kubectl-style CLI tool (wectl)
└── docker/           # Container configurations
```

### Quick Development Setup

1. **Backend Development**
   ```bash
   cd backend
   ./start.sh
   # Or manually: uv sync && source .venv/bin/activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```

2. **Frontend Development**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

3. **Run Tests**
   ```bash
   # Backend tests
   cd backend && python -m pytest

   # Frontend tests
   cd frontend && npm test
   ```

For comprehensive setup instructions including database configuration, environment variables, and troubleshooting, refer to the [Development Guide](docs/en/guides/developer/setup.md).


## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

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
        <a href="https://github.com/moqimoqidea">
            <img src="https://avatars.githubusercontent.com/u/39821951?v=4" width="80;" alt="moqimoqidea"/>
            <br />
            <sub><b>moqimoqidea</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/fengkuizhi">
            <img src="https://avatars.githubusercontent.com/u/3616484?v=4" width="80;" alt="fengkuizhi"/>
            <br />
            <sub><b>fengkuizhi</b></sub>
        </a>
    </td>
    <td align="center">
        <a href="https://github.com/jolestar">
            <img src="https://avatars.githubusercontent.com/u/77268?v=4" width="80;" alt="jolestar"/>
            <br />
            <sub><b>Jolestar</b></sub>
        </a>
    </td></tr>
</table>
<!-- readme: contributors -end -->

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>

# Wegent
> 🚀 一个定义、组织和运行智能体 AI的开源平台

[English](README.md) | 简体中文

[![Python](https://img.shields.io/badge/python-3.9+-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.68+-green.svg)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-15+-black.svg)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://docker.com)
[![Claude](https://img.shields.io/badge/Claude-Code-orange.svg)](https://claude.ai)

<div align="center">

### 🚀 **构建你的 AI 智能体工作团队**

*从编程助手到新闻分析 - 部署真正能干活的智能代理*

[快速开始](#-快速开始) · [应用场景](#-你能构建什么) · [文档](docs/zh/资源定义格式.md) · [开发指南](docs/zh/develop-guide.md)

</div>

---

## 💡 你能构建什么？

Wegent 让你通过智能体编排创建强大的 AI 应用：

### 🖥️ **网页版编程助手**
在浏览器中构建全功能开发环境
<img src="./docs/assets/example.gif" width="75%" alt="演示视频"/>

### 📰 **新闻智能平台**
创建智能新闻聚合和分析系统

### 🔧 **自定义智能体应用**
可能性无限 - 为以下场景构建智能体：
- **数据分析**：自动化报告生成和可视化
- **内容创作**：博客文章、社交媒体和营销素材
- **客户支持**：具有上下文理解的智能聊天机器人
- **DevOps 自动化**：CI/CD 流水线管理和监控
- **研究助手**：文献综述和知识合成

---

## 📖 什么是 Wegent？

Wegent 是一个开源的 AI 原生操作系统，使您能够大规模定义、组织和运行智能代理。基于 Kubernetes 风格的声明式 API 和 CRD（自定义资源定义）设计模式，Wegent 为创建和管理 AI 智能体生态系统提供了标准化框架。

### 🌟 核心能力

1. **🎨 配置驱动的智能体团队**：通过 YAML 配置定义和运行个性化 Agent 团队，提供网页 UI，无需二次开发
2. **⚙️ 多引擎架构**：底层支持 Agno 和 Claude Code 两个 Agent 执行引擎，上层支持对话和编码两种模式
3. **🔒 独立沙箱环境**：每个 Agent 团队运行在独立沙箱环境中，支持多个 Agent 团队同时运行
4. **🤝 高级协作模式**：对话模式可以实现并行、Leader 等 Agent 协作模式，完成新闻洞察、内容检索等复杂工作流
5. **💻 AI 编码集成**：编码模式可以与 GitHub/GitLab 等代码服务对接，实现代码开发、review 等 AI Coding 工作流

```mermaid
graph LR
    subgraph AIResource ["🌐 AI 原生资源"]
        subgraph YAMLDef ["📄 YAML 定义"]
            Ghost["👻 Ghost<br/>智能体灵魂"]
            Model["🧠 Model<br/>模型配置"]
            Shell["🐚 Shell<br/>智能体程序"]
            Bot["🤖 Bot<br/>智能体实例"]
            CollabModel["🤝 Collaboration<br/>协作模型"]
            Team["👥 Team<br/>协作团队"]
        end
     end

    subgraph Wegent ["🚀 Wegent"]
        Workspace["💼 Workspace<br/>工作环境"]
        TeamInstance["👥 智能体团队实例<br/>运行中的团队"]
    end

      User["👤 用户"]
      Task["🎯 Task<br/>用户任务"]
    %% CRD 资源关系
    Ghost --> Bot
    Model --> Bot
    Shell --> Bot
    Bot --> Team
    CollabModel --> Team
    Shell --> Team

    %% 团队定义到实例
    AIResource --> Wegent
    Workspace --> TeamInstance

    %% 用户交互流程
    User --> Task
    Task --> TeamInstance
    TeamInstance --> Task

    %% 样式
    classDef yamlBox stroke-dasharray: 5 5
    classDef runtimeBox stroke:#ff6b6b,stroke-width:2px
    classDef resourceBox stroke:#4ecdc4,stroke-width:2px

    class YAMLDef yamlBox
    class Runtime runtimeBox
    class AIResource resourceBox

```

### 🎯 核心概念

- **👻 Ghost**：智能体的"灵魂" - 定义个性、能力和行为模式
- **🧠 Model**：AI 模型配置 - 定义环境变量和模型参数
- **🐚 Shell**："可执行程序" - 能够启动智能体的程序
- **🤖 Bot**：完整的智能体实例，结合了 Ghost + Shell + Model
- **👥 Team**：由多个 Bot + 协作模型组成，定义智能体如何协同工作
- **🤝 Collaboration**：定义团队中 Bot 之间的交互模式（类似工作流）
- **💼 Workspace**：用于任务和项目的隔离工作环境
- **🎯 Task**：分配给团队的可执行工作单元

> 💡 **详细的 YAML 配置文档**:
- [完整的 YAML 配置示例和字段说明](docs/zh/资源定义格式.md)


## 🚀 快速开始

### 前置要求

- Docker 和 Docker Compose
- Git

1. **克隆仓库**
   ```bash
   git clone https://github.com/wecode-ai/wegent.git
   cd wegent
   ```

2. **启动平台**
   ```bash
   docker-compose up -d
   ```

3. **访问 Web 界面**
   - 在浏览器中打开 http://localhost:3000

4. **配置 GitHub 访问令牌**
   - 按照页面说明配置您的 GitHub 访问令牌

5. **配置 Bot**

   Wegent 内置了一个开发 Bot。对于 Claude Code 运行时，请设置以下环境变量：

   ```json
   {
     "env": {
       "ANTHROPIC_MODEL": "openrouter,anthropic/claude-sonnet-4",
       "ANTHROPIC_AUTH_TOKEN": "sk-xxxxxx",
       "ANTHROPIC_BASE_URL": "http://xxxxx",
       "ANTHROPIC_SMALL_FAST_MODEL": "openrouter,anthropic/claude-3.5-haiku"
     }
   }
   ```

   注：部分运行时可能使用 `ANTHROPIC_API_KEY` 而非 `ANTHROPIC_AUTH_TOKEN`，具体以文档说明为准。

6. **运行任务**

   在任务页面，选择您的项目和分支，描述您的开发需求，例如使用 Python 实现冒泡排序算法

## 🏗️ 架构

```mermaid
graph TB
    subgraph "🖥️ 管理平台层"
        Frontend["🌐 Next.js 前端"]
        Backend["⚙️ FastAPI 后端"]
        API["🚀 声明式 API"]
    end

    subgraph "📊 数据层"
        MySQL[("💾 MySQL 数据库")]
    end

    subgraph "🔍 执行层"
        ExecutorManager["💯 执行器管理器"]
        Executor1["🚀 执行器 1"]
        Executor2["🚀 执行器 2"]
        ExecutorN["🚀 执行器 N"]
    end

    subgraph "🤖 智能体层"
        Claude["🧠 Claude Code"]
        Ango["💻 Agno"]
        DifyPlanned["✨ Dify（计划中）"]
    end


    %% 系统交互
    Frontend --> API
    API --> Backend
    Backend --> MySQL
    Backend --> ExecutorManager
    ExecutorManager --> Executor1
    ExecutorManager --> Executor2
    ExecutorManager --> ExecutorN

    %% AI 程序集成（目前仅支持 Claude Code）
    Executor1 --> Claude
    Executor2 --> Claude
    ExecutorN --> Ango
```

## 🛠️ 开发

详细的开发环境搭建说明请参阅 [开发指南](docs/zh/develop-guide.md)。

### 项目结构

```
wegent/
├── backend/          # FastAPI 后端服务
├── frontend/         # Next.js Web 界面
├── executor/         # 任务执行引擎
├── executor_manager/ # 执行编排
├── shared/           # 通用工具和模型
└── docker/           # 容器配置
```

### 快速开发环境设置

1. **后端开发**
   ```bash
   cd backend
   pip install -r requirements.txt
   uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
   ```

2. **前端开发**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

3. **运行测试**
   ```bash
   # 后端测试
   cd backend && python -m pytest

   # 前端测试
   cd frontend && npm test
   ```

完整的开发环境搭建说明（包括数据库配置、环境变量设置和故障排查）请参阅 [开发指南](docs/zh/develop-guide.md)。


## 🤝 贡献

我们欢迎贡献！详情请参阅我们的[贡献指南](CONTRIBUTING.md)。

### 开发工作流

1. Fork 仓库
2. 创建功能分支
3. 进行更改
4. 添加测试
5. 提交 Pull Request

## 📞 支持

- 🐛 问题反馈：[GitHub Issues](https://github.com/wecode-ai/wegent/issues)

## 👥 贡献者

感谢以下开发者对本项目的贡献，为了让项目变得更好 💪

<table>
  <tr>
    <td align="center">
      <a href="https://github.com/qdaxb">
        <img src="https://avatars.githubusercontent.com/qdaxb" width="80px;" alt="qdaxb"/>
        <br />
        <sub><b>qdaxb</b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/cc-yafei">
        <img src="https://avatars.githubusercontent.com/cc-yafei" width="80px;" alt="cc-yafei"/>
        <br />
        <sub><b>cc-yafei</b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/fengkuizhi">
        <img src="https://avatars.githubusercontent.com/fengkuizhi" width="80px;" alt="fengkuizhi"/>
        <br />
        <sub><b>fengkuizhi</b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/feifei325">
        <img src="https://avatars.githubusercontent.com/feifei325" width="80px;" alt="feifei325"/>
        <br />
        <sub><b>feifei325</b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/Micro66">
        <img src="https://avatars.githubusercontent.com/Micro66" width="80px;" alt="Micro66"/>
        <br />
        <sub><b>Micro66</b></sub>
      </a>
    </td>
    <td align="center">
      <a href="https://github.com/moqimoqidea">
        <img src="https://avatars.githubusercontent.com/moqimoqidea" width="80px;" alt="moqimoqidea"/>
        <br />
        <sub><b>moqimoqidea</b></sub>
      </a>
    </td>
  </tr>
</table>

---

<p align="center">由 WeCode-AI 团队用 ❤️ 制作</p>

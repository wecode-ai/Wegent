# Wegent

> 🚀 一个开源的 AI 原生操作系统，用于定义、组织和运行智能体团队

[English](README.md) | 简体中文

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.68+-green.svg)](https://fastapi.tiangolo.com)
[![Next.js](https://img.shields.io/badge/Next.js-15+-black.svg)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](https://docker.com)
[![Claude](https://img.shields.io/badge/Claude-Code-orange.svg)](https://claude.ai)
[![Gemini](https://img.shields.io/badge/Gemini-支持-4285F4.svg)](https://ai.google.dev)
[![Version](https://img.shields.io/badge/版本-1.0.20-brightgreen.svg)](https://github.com/wecode-ai/wegent/releases)

<div align="center">

**YAML 驱动的智能体团队 | 4 种协作模式 | 实时群聊 | 沙箱隔离执行**

<img src="./docs/assets/images/example.gif" width="75%" alt="演示"/>

[快速开始](#-快速开始) · [文档](docs/zh/README.md) · [开发指南](docs/zh/guides/developer/setup.md)

</div>

---

## ✨ 三大核心场景

### 💬 对话模式

| 类别 | 功能 |
|------|------|
| **LLM** | Claude / OpenAI / Gemini |
| **多模态** | 图片输入 (Vision) |
| **搜索** | Google / Bing / SearXNG |
| **协作** | 4 种模式 / 群聊 / 任务分享 |
| **扩展** | Skill 按需加载 / MCP 工具 |
| **API** | OpenAI 兼容接口 |
| **导出** | PDF / DOCX |

### 💻 编码模式

| 类别 | 功能 |
|------|------|
| **Git** | GitHub / GitLab / Gitea / Gitee / Gerrit |
| **执行** | ClaudeCode / Agno 沙箱隔离 |
| **工作流** | 分支 → 编码 → 提交 → PR |
| **辅助** | 需求澄清 / Wiki 生成 / 纠错模式 |

### 📚 知识模式 *(实验性)*

| 类别 | 功能 |
|------|------|
| **RAG** | 向量 / 关键词 / 混合检索 |
| **存储** | Elasticsearch / Qdrant |
| **格式** | PDF / Markdown / DOCX / 代码文件 |
| **Wiki** | 代码库文档自动生成 |

---

## 🔧 扩展能力

| 功能 | 描述 |
|------|------|
| **智能体向导** | 4 步创建：描述需求 → AI 追问 → 实时测试 → 一键创建 |
| **YAML 配置** | Kubernetes 风格 CRD，定义 Ghost / Bot / Team / Skill |
| **MCP 工具** | Model Context Protocol，调用外部工具和服务 |
| **执行引擎** | ClaudeCode (Docker) / Agno (Docker) / Dify (API) / Chat (Direct) |

---

## 🔐 部署与运维

| 类别 | 功能 |
|------|------|
| **认证** | OIDC / SSO |
| **隔离** | 命名空间隔离 |
| **管理** | API Key / 管理员面板 |
| **可观测性** | OpenTelemetry |
| **国际化** | 中文 / 英文 / 深色模式 |

---

## 🚀 快速开始

```bash
git clone https://github.com/wecode-ai/wegent.git && cd wegent
docker-compose up -d
# 访问 http://localhost:3000
```

> 可选：启用 RAG 功能 `docker compose --profile rag up -d`

---

## 📦 预置智能体

| 团队 | 用途 |
|------|------|
| chat-team | 通用 AI 助手 + Mermaid 图表 |
| translator | 多语言翻译 |
| dev-team | Git 工作流：分支 → 编码 → 提交 → PR |
| wiki-team | 代码库 Wiki 文档生成 |

---

## 🏗️ 架构

```
Frontend (Next.js) → Backend (FastAPI) → Executor Manager → Executors (ClaudeCode/Agno/Dify/Chat)
```

**核心概念：**
- **Ghost** (提示词) + **Shell** (执行环境) + **Model** = **Bot**
- 多个 **Bot** + **协作模式** = **Team**

> 详见 [核心概念](docs/zh/concepts/core-concepts.md) | [YAML 规范](docs/zh/reference/yaml-specification.md)

---

## 🤝 贡献

我们欢迎贡献！详情请参阅 [贡献指南](CONTRIBUTING.md)。

## 📞 支持

- 🐛 问题反馈：[GitHub Issues](https://github.com/wecode-ai/wegent/issues)

## 👥 贡献者

感谢以下开发者的贡献，让这个项目变得更好 💪

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

<p align="center">由 WeCode-AI 团队用 ❤️ 制作</p>

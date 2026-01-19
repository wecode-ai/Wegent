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

<img src="https://github.com/user-attachments/assets/677abce3-bd3f-4064-bdab-e247b142c22f" width="100%" alt="Chat Mode Demo"/>

<img src="https://github.com/user-attachments/assets/2b210d33-2569-4bc9-acac-e163de4e12a5" width="100%" alt="Knowledge Demo"/>

<img src="https://github.com/user-attachments/assets/cc25c415-d3f1-4e9f-a64c-1d2614d69c7d" width="100%" alt="Code Mode Demo"/>

[快速开始](#-快速开始) · [文档](docs/zh/README.md) · [开发指南](docs/zh/guides/developer/setup.md)

</div>

---

## ✨ 核心模式

| 💬 对话模式 | 💻 编码模式 | 📚 知识模式 |
|:------------|:------------|:-----------------------|
| **LLM**: 支持Claude / OpenAI / Gemini 等主流模型<br>**多模态**: 支持图片 / PPT / Word / PDF / Excel 文件自动解析<br>**联网搜索**: 支持对接各类搜索引擎<br>**深度调研**: 支持深度调研模式，可自动搜索、整理、生成调研报告<br>**纠错模式**: 由多个AI自动检测并修正回答中的错误<br>**追问模式**: AI 主动追问澄清需求，确保理解准确<br>**扩展能力**: 支持 Skill 技能包 / MCP 工具 / 自定义工具 | **多平台集成**: 支持GitHub / GitLab / Gitea / Gitee / Gerrit平台<br>**自动化AI工作流**: 分支 → 编码 → 提交 → PR 流程自动化<br>**需求澄清**: AI 主动追问，确保理解准确<br>**Wiki 生成**: 自动生成代码库文档 | **RAG 检索**: 向量 / 关键词 / 混合检索<br>**存储后端**: Elasticsearch / Qdrant<br>**文档解析**: PDF / Markdown / DOCX / 代码文件<br>**Wiki**: 代码库文档自动生成 |

---

## 🔧 扩展能力

- **智能体生成向导**: 4 步创建: 描述需求 → AI 追问 → 实时微调 → 一键创建
- **协作模式**: 支持开箱即用的 4 种多Agent协作模式（顺序/并行/路由/循环），灵活组合多个 Bot
- **支持Skill**: 动态加载技能包，提升 Token 效率
- **MCP 工具**: Model Context Protocol，调用外部工具和服务
- **执行引擎**: 支持ClaudeCode / Agno 沙箱隔离执行，Dify API 代理，Chat 直连模式4个执行引擎
- **YAML 配置**: Kubernetes 风格 CRD，定义 Ghost / Bot / Team / Skill
- **API**: 对外提供 OpenAI 兼容接口，方便与其他系统集成

---

## 🚀 快速开始

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash
```

然后在浏览器中访问 http://localhost:3000

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
Frontend (Next.js) → Backend (FastAPI) → Executor Manager → Executors (ClaudeCode/Agno)
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
- 💬 Discord：[加入社区](https://discord.gg/MVzJzyqEUp)

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

<p align="center">由 WeCode-AI 团队用 ❤️ 制作</p>

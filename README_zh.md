# Wegent

> 一套跨越本地桌面、云端智能体与远程工作机的开源 AI 工作系统。

[English](README.md) | 简体中文

[![CI](https://github.com/wecode-ai/Wegent/actions/workflows/test.yml/badge.svg)](https://github.com/wecode-ai/Wegent/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/wecode-ai/Wegent)](LICENSE)
[![GitHub Issues](https://img.shields.io/github/issues/wecode-ai/Wegent)](https://github.com/wecode-ai/Wegent/issues)
    <a href="https://linux.do" alt="LINUX DO">
        <img
            src="https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+" /></a>

Wegent 包含桌面工作台和可自托管的 Web 平台。Wegent Desktop 用于处理本地项目、文件、命令、测试和代码变更；Wegent Web 提供网页端智能体、知识库、自动化和管理功能；Wegent Backend 为这些应用提供共享项目空间、模型和执行设备。

[下载最新版 Wegent Desktop](https://github.com/wecode-ai/Wegent/releases/latest) · [查看文档](https://wecode-ai.github.io/wegent-docs/zh/) · [参与贡献](CONTRIBUTING.md)

## Wegent Desktop

Wegent Desktop 按项目和任务组织本地编码工作。任务界面集中展示会话、工具活动、测试、变更文件和 Diff；项目空间界面提供任务看板、共享文件、自动化和执行状态。

<img src="https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-desktop-workbench.png" width="100%" alt="Wegent Desktop 中真实执行的编码任务，在同一个工作台展示验证结果、变更文件和展开的源码 Diff" />

<p align="center"><sub>在 Wegent Desktop 中执行并审查本地编码任务。</sub></p>

<img src="https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-project-workspace.png" width="100%" alt="Wegent Desktop 中真实的项目工作空间，展示任务看板、项目导航和正在由远程工作机推进的测试任务" />

<p align="center"><sub>Wegent Desktop 中的项目空间，包括任务看板、共享文件、自动化和执行状态。</sub></p>

## 核心功能

- **桌面工作台**：组织本地项目、任务、会话、文件、工具活动、测试和 Diff。
- **可复用智能体**：组合模型、提示词、Skills、知识、工具和协作配置。
- **项目空间**：共享任务看板、文件、讨论、自动化、执行记录和交付物。
- **多种执行位置**：在本机、远程工作机或服务端执行器中运行任务。
- **自托管服务**：部署 Wegent Web 和 Backend，管理团队访问、API、权限、调度和知识服务。

## 为什么选择 Wegent

**基于 Codex 的本地编码体验是 Wegent Desktop 的基础。**它直接在你的项目中使用本地代码、文件、命令和开发环境；当编码工作需要跨越一台电脑或一个人时，再连接 Wegent Backend。连接后，本地工作台和 Web 使用同一套项目、任务和设备资源。

- **让任务在合适的设备上运行**：继续使用本地已有的代码、文件、命令和开发环境，也可以选择远程工作机或服务端执行器运行同一个项目的任务。
- **让团队围绕同一个项目推进**：项目空间将任务看板、共享文件、讨论、执行状态和交付物关联起来，而不只是在各自的电脑上保存会话和代码变更。
- **把重复流程交给自动化**：项目空间可配置自动化与执行队列，用于持续推进项目中的例行工作。
- **由团队掌握服务和数据**：Web 和 Backend 可以自托管，用于共享访问、权限、模型配置、调度、知识服务和远程设备管理。

如果工作始终只在一台电脑上完成，Wegent Desktop 提供熟悉的 Codex 编码体验；当任务需要在多人、多设备或自托管环境之间流转时，连接 Wegent 可在此基础上继续扩展。

## Wegent Web

Wegent Web 提供远程智能体的网页界面。智能体使用配置好的模型、知识、Skills 和工具，Wegent Backend 负责管理任务和执行。

<img src="https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-remote-agent.png" width="100%" alt="Wegent 远程智能体调用工具生成并展示甘特图" />

<p align="center"><sub>Wegent 远程智能体调用工具生成甘特图。</sub></p>

## 工作方式

Wework 是 Wegent 的桌面工作台。Electron 负责桌面窗口、系统能力和进程管理；DeepSeek Harness（DSH）是内嵌的应用与插件运行时，Wework 的产品界面由一组 DSH 插件组合而成。Executor 负责管理任务与会话，并驱动 Codex 在本地项目中完成实际工作。

```mermaid
flowchart LR
    Electron["Electron<br/>桌面宿主"]

    subgraph DSH["DSH Runtime"]
        direction TB
        Core["DSH Core<br/>插件发现、依赖注入与生命周期"]
        App["dsh-app-wework<br/>Wework 产品外壳与 UI 扩展点"]
        UI["dsh-ui-*<br/>任务、项目空间、设置、应用与自动化"]
        ElectronPlugin["dsh-electron-host<br/>Electron 能力桥接"]
        ExecutorPlugin["dsh-executor-runtime<br/>任务执行与事件适配"]
        TerminalPlugin["dsh-terminal-runtime<br/>本地交互式终端"]

        Core --> App
        Core --> UI
        Core --> ElectronPlugin
        Core --> ExecutorPlugin
        Core --> TerminalPlugin
        App --> UI
    end

    Executor["Executor<br/>任务与会话执行"]
    Codex["Codex<br/>编码 Agent"]
    Workspace["本地项目<br/>文件与命令"]

    Electron -->|"启动并托管"| Core
    Electron -->|"启动并监管"| Executor
    ElectronPlugin <-->|"受限桌面能力"| Electron
    UI <-->|"用户操作与界面更新"| ExecutorPlugin
    ExecutorPlugin -->|"创建、追问、审批、取消"| Executor
    Executor -->|"状态、消息、工具事件、结果"| ExecutorPlugin
    Executor <-->|"启动、控制与事件"| Codex
    Codex <-->|"读取、修改与执行"| Workspace
    TerminalPlugin <-->|"PTY"| Workspace
```

DSH 不直接执行编码任务。`dsh-app-wework` 定义产品外壳和扩展点，`dsh-ui-*` 提供具体产品模块，`dsh-electron-host` 桥接受限的 Electron 能力，`dsh-executor-runtime` 在执行过程中与 Executor 双向通信，`dsh-terminal-runtime` 管理本地交互式终端。Executor 是任务执行层，Codex 是由它驱动的具体编码 Agent。

Wework 也可以连接 Wegent Backend 使用共享项目空间、模型和远程执行设备。Wegent Web 是基于同一 Backend 的独立网页界面。

## 快速开始

### Wegent Desktop

1. 从 [最新版本页下载 Wegent Desktop](https://github.com/wecode-ai/Wegent/releases/latest) 并安装。
2. 打开应用，添加或选择一个本地项目。
3. 创建任务并描述需要执行的工作。
4. 查看智能体活动、命令输出和文件变更。

### Wegent Web 和 Backend

使用 Docker 以 Standalone 模式启动自托管 Web 应用和 Backend：

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- --standalone
```

启动后打开 http://localhost:3000，按页面引导设置管理员密码并配置模型。更多部署方式见 [安装指南](docs/zh/wegent/getting-started/installation.md) 和 [Standalone 模式](docs/zh/wegent/deployment/standalone-mode.md)。

## 开发

需要 Node.js 20+ 和 pnpm：

```bash
pnpm install
pnpm --filter wework dev
```

运行 macOS 桌面应用：

```bash
pnpm --filter wework dev:mac
```

桌面端的开发、构建和发布说明见 [wework/README.md](wework/README.md)；`wework/` 是当前桌面应用源码目录。

## 仓库结构

| 目录                       | 职责                                    |
| -------------------------- | --------------------------------------- |
| `wework/`                  | Wegent Desktop（Electron、Vite、React） |
| `executor/`                | 本地与远程的智能体任务执行环境          |
| `frontend/`                | Wegent 平台 Web 管理界面                |
| `backend/`                 | REST API 和核心业务逻辑                 |
| `executor_manager/`        | 执行器调度与编排                        |
| `chat_shell/`              | 对话运行时                              |
| `knowledge_runtime/`       | 知识检索服务                            |
| `knowledge_doc_converter/` | 文档解析与转换                          |
| `shared/`                  | 跨服务共享模块                          |

## 文档

- [Wegent Desktop 文档](docs/zh/wework/README.md)
- [桌面端开发与发布](wework/README.md)
- [Wegent 快速开始](docs/zh/wegent/getting-started/quick-start.md)
- [安装与部署](docs/zh/wegent/getting-started/installation.md)
- [核心概念](docs/zh/wegent/concepts/core-concepts.md)
- [开发者指南](docs/zh/wegent/developer-guide/README.md)
- [故障排查](docs/zh/wegent/troubleshooting.md)

## 参与贡献

欢迎提交问题、改进文档、贡献代码或分享新的使用方式。

- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [问题反馈](https://github.com/wecode-ai/Wegent/issues)
- 钉钉社区群：“wework社区交流”，群号 `190890002451`
- [Discord 社区](https://discord.gg/MVzJzyqEUp)
- [开源许可证](LICENSE)

## 贡献者

感谢所有帮助 Wegent 持续成长的贡献者。

<!-- readme: contributors -start -->
<table>
	<tbody>
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
                <a href="https://github.com/kissghosts">
                    <img src="https://avatars.githubusercontent.com/u/3409715?v=4" width="80;" alt="kissghosts"/>
                    <br />
                    <sub><b>Yanhe</b></sub>
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
                    <sub><b>Moqimoqidea</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/johnny0120">
                    <img src="https://avatars.githubusercontent.com/u/15564476?v=4" width="80;" alt="johnny0120"/>
                    <br />
                    <sub><b>Johnny0120</b></sub>
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
                <a href="https://github.com/sunnights">
                    <img src="https://avatars.githubusercontent.com/u/1886887?v=4" width="80;" alt="sunnights"/>
                    <br />
                    <sub><b>Jake Zhang</b></sub>
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
                <a href="https://github.com/yixiangxx">
                    <img src="https://avatars.githubusercontent.com/u/3120662?v=4" width="80;" alt="yixiangxx"/>
                    <br />
                    <sub><b>Yi Xiang</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/luckjun529-lang">
                    <img src="https://avatars.githubusercontent.com/u/224970532?v=4" width="80;" alt="luckjun529-lang"/>
                    <br />
                    <sub><b>junlong chen</b></sub>
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
                <a href="https://github.com/sdadunderscoresdad">
                    <img src="https://avatars.githubusercontent.com/u/130071748?v=4" width="80;" alt="sdadunderscoresdad"/>
                    <br />
                    <sub><b>+7</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/2561056571">
                    <img src="https://avatars.githubusercontent.com/u/112464849?v=4" width="80;" alt="2561056571"/>
                    <br />
                    <sub><b>Xuemin</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/lvmowei">
                    <img src="https://avatars.githubusercontent.com/u/5328905?v=4" width="80;" alt="lvmowei"/>
                    <br />
                    <sub><b>lvmowei</b></sub>
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
                <a href="https://github.com/jnhu76">
                    <img src="https://avatars.githubusercontent.com/u/5766215?v=4" width="80;" alt="jnhu76"/>
                    <br />
                    <sub><b>Jm.hu</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/hustfisher">
                    <img src="https://avatars.githubusercontent.com/u/1677452?v=4" width="80;" alt="hustfisher"/>
                    <br />
                    <sub><b>fishermen</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/earthAlone2026">
                    <img src="https://avatars.githubusercontent.com/u/270281822?v=4" width="80;" alt="earthAlone2026"/>
                    <br />
                    <sub><b>xiaoqiang</b></sub>
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
		</tr>
		<tr>
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
                <a href="https://github.com/qwertyerge">
                    <img src="https://avatars.githubusercontent.com/u/13088125?v=4" width="80;" alt="qwertyerge"/>
                    <br />
                    <sub><b>Erdawang</b></sub>
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
                <a href="https://github.com/Twelveeee">
                    <img src="https://avatars.githubusercontent.com/u/48245733?v=4" width="80;" alt="Twelveeee"/>
                    <br />
                    <sub><b>Twelveeee</b></sub>
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
            </td>
            <td align="center">
                <a href="https://github.com/friendfei">
                    <img src="https://avatars.githubusercontent.com/u/5112004?v=4" width="80;" alt="friendfei"/>
                    <br />
                    <sub><b>friendfei</b></sub>
                </a>
            </td>
		</tr>
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
            </td>
            <td align="center">
                <a href="https://github.com/Ged0">
                    <img src="https://avatars.githubusercontent.com/u/4569451?v=4" width="80;" alt="Ged0"/>
                    <br />
                    <sub><b>_</b></sub>
                </a>
            </td>
		</tr>
		<tr>
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
                <a href="https://github.com/Qinxl0921">
                    <img src="https://avatars.githubusercontent.com/u/79916629?v=4" width="80;" alt="Qinxl0921"/>
                    <br />
                    <sub><b>qinxll</b></sub>
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
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>

# Wegent

> 人与 AI 共同推进项目的开源工作系统。

[English](README.md) | 简体中文

[![CI](https://github.com/wecode-ai/Wegent/actions/workflows/test.yml/badge.svg)](https://github.com/wecode-ai/Wegent/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/wecode-ai/Wegent)](LICENSE)
[![GitHub Issues](https://img.shields.io/github/issues/wecode-ai/Wegent)](https://github.com/wecode-ai/Wegent/issues)
<a href="https://linux.do">
<img alt="LINUX DO"
            src="https://img.shields.io/badge/LINUX-DO-FFB003.svg?logo=data:image/svg%2bxml;base64,DQo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgd2lkdGg9IjEwMCIgaGVpZ2h0PSIxMDAiPjxwYXRoIGQ9Ik00Ni44Mi0uMDU1aDYuMjVxMjMuOTY5IDIuMDYyIDM4IDIxLjQyNmM1LjI1OCA3LjY3NiA4LjIxNSAxNi4xNTYgOC44NzUgMjUuNDV2Ni4yNXEtMi4wNjQgMjMuOTY4LTIxLjQzIDM4LTExLjUxMiA3Ljg4NS0yNS40NDUgOC44NzRoLTYuMjVxLTIzLjk3LTIuMDY0LTM4LjAwNC0yMS40M1EuOTcxIDY3LjA1Ni0uMDU0IDUzLjE4di02LjQ3M0MxLjM2MiAzMC43ODEgOC41MDMgMTguMTQ4IDIxLjM3IDguODE3IDI5LjA0NyAzLjU2MiAzNy41MjcuNjA0IDQ2LjgyMS0uMDU2IiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZWNlY2VjO2ZpbGwtb3BhY2l0eToxIi8+PHBhdGggZD0iTTQ3LjI2NiAyLjk1N3EyMi41My0uNjUgMzcuNzc3IDE1LjczOGE0OS43IDQ5LjcgMCAwIDEgNi44NjcgMTAuMTU3cS00MS45NjQuMjIyLTgzLjkzIDAgOS43NS0xOC42MTYgMzAuMDI0LTI0LjM4N2E2MSA2MSAwIDAgMSA5LjI2Mi0xLjUwOCIgc3R5bGU9InN0cm9rZTpub25lO2ZpbGwtcnVsZTpldmVub2RkO2ZpbGw6IzE5MTkxOTtmaWxsLW9wYWNpdHk6MSIvPjxwYXRoIGQ9Ik03Ljk4IDcwLjkyNmMyNy45NzctLjAzNSA1NS45NTQgMCA4My45My4xMTNRODMuNDI2IDg3LjQ3MyA2Ni4xMyA5NC4wODZxLTE4LjgxIDYuNTQ0LTM2LjgzMi0xLjg5OC0xNC4yMDMtNy4wOS0yMS4zMTctMjEuMjYyIiBzdHlsZT0ic3Ryb2tlOm5vbmU7ZmlsbC1ydWxlOmV2ZW5vZGQ7ZmlsbDojZjlhZjAwO2ZpbGwtb3BhY2l0eToxIi8+PC9zdmc+" /></a>

Wegent 让团队成员、AI 智能体和个人分身围绕同一个 Issue 协作：提出需求、分派工作、执行任务并交付成果，让讨论、执行记录与交付物保持关联。你既可以独自在本地项目中编码，也可以与团队在共享项目空间中接力推进工作。

[下载最新版 Wegent Desktop](https://github.com/wecode-ai/Wegent/releases/latest) · [快速开始](#快速开始) · [查看文档](https://wecode-ai.github.io/wegent-docs/zh/) · [参与贡献](CONTRIBUTING.md)

## 一个 Issue，连接整支团队

[![观看 90 秒宣传片：一个 Issue，连接整支团队](https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-ai-collaboration-zh-20261109.jpg)](https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-ai-collaboration-zh-20261109.mp4)

[观看完整视频（90 秒，中文）](https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-ai-collaboration-zh-20261109.mp4)

从一句“做一个可交互的三列迭代看板”开始，一项工作可以这样推进：

1. **提出需求**：创建 Issue，说明目标，并选择接手的成员、智能体或协作小组。
2. **分派工作**：配置好的 AI 负责人可以将方案与实现工作分派给相应角色；成员收到通知后进入同一个 Issue。
3. **执行并交付**：成员在 Wework 中创建关联任务，借助 AI 处理文件、运行命令和测试，选择成果交付回 Issue。
4. **讨论与接力**：在评论中补充反馈并转派，下一位成员或智能体结合已有方案和文件继续处理。
5. **分身接手，本人确认**：已配置的个人分身按接收范围和处理方式代为处理工作，完成后交回本人确认。

**分派不等于完成，AI 产出也不等于本人确认。** Issue 将责任人、执行过程、讨论和交付物关联起来，团队可以查看进展、追问和继续处理。

<img src="https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-project-workspace.png" width="100%" alt="Wegent Desktop 中的项目空间，展示任务看板、项目导航和远程工作机正在推进的任务" />

<p align="center"><sub>在项目空间中组织工作，查看任务看板、共享文件和执行状态。</sub></p>

## 核心能力

- **人与 AI 协作**：围绕 Issue 分派、评论和转派，让成员、智能体和协作小组参与同一个项目。
- **任务执行与成果交付**：从 Issue 创建关联任务，查看执行过程，将选定的文件和说明交付回项目。
- **个人分身（Beta）**：按已授权的项目来源、职责和处理方式接收工作，保留执行记录与人工介入入口。
- **项目管理与自动化**：通过任务看板、共享文件、执行记录和交付物组织项目，配置自动处理规则与执行队列。
- **本地编码工作台**：基于 Codex 直接使用项目代码、文件、命令和开发环境，集中审查工具活动、测试和 Diff。
- **可复用智能体与多种执行位置**：组合模型、提示词、Skills、知识和工具，在本机、远程工作机或服务端执行器中运行任务。
- **自托管服务**：部署 Wegent Web 和 Backend，由团队管理访问、权限、模型、调度、知识服务和远程设备。

个人分身需要先配置来源授权、模型及可用执行设备；自动处理受项目权限和操作确认约束，不代表电脑关机后仍可执行。AI 负责人对话及自动处理的使用条件见[项目负责人指南](docs/zh/wework/personal-stand-in.md#project-lead-controls)，负责人对话目前需开启实验性功能。更多设置见[我的分身与场景角色](docs/zh/wework/personal-stand-in.md)。

## 快速开始

### 个人使用：在本地项目中完成一个任务

1. 从[最新版本页下载 Wegent Desktop](https://github.com/wecode-ai/Wegent/releases/latest) 并安装。
2. 打开应用，按引导配置模型，添加或选择本地项目；本地工作无需登录 Wegent Backend。
3. 创建任务，描述需要分析、修改或验证的内容。
4. 查看智能体活动、命令输出、测试结果和文件 Diff，审查成果。

### 团队协作：从一个 Issue 开始接力

1. 在协作中创建项目；需要多人共享时，先连接 Wegent Backend，再创建或加入云端协作项目。
2. 添加项目成员；需要 AI 执行时，显式添加智能体，并配置可用的执行环境和模型。
3. 创建 Issue，填写目标并分配给成员、智能体或协作小组。
4. 从 Issue 创建关联任务，执行后交付成果；在评论中反馈并转派给下一位处理者。
5. 需要个人分身接手时，在“我的分身”中配置项目来源、职责与处理方式，按需处理人工问题和确认。

新项目不会自动加入智能体，也不会自动启用分身。具体入口见[协作中的新建 Issue](docs/zh/wegent/user-guide/coding/collaboration-issue-home.md)与[个人分身指南](docs/zh/wework/personal-stand-in.md)。

### 自托管 Wegent Web 和 Backend

使用 Docker 以 Standalone 模式启动自托管 Web 应用和 Backend：

```bash
curl -fsSL https://raw.githubusercontent.com/wecode-ai/Wegent/main/install.sh | bash -s -- --standalone
```

启动后打开 http://localhost:3000，按页面引导设置管理员密码并配置模型。更多部署方式见[安装指南](docs/zh/wegent/getting-started/installation.md)和 [Standalone 模式](docs/zh/wegent/deployment/standalone-mode.md)。

## 产品组成

### Wework / Wegent Desktop

Wework 是 Wegent 的桌面工作台，连接项目协作与实际执行。它保留完整的本地编码能力：按项目和任务组织会话，直接处理文件、运行命令和测试，在同一个工作台审查变更与 Diff。连接 Backend 后，还可使用共享项目空间、云端模型和远程执行设备。

<img src="https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-desktop-workbench.png" width="100%" alt="Wegent Desktop 中真实执行的编码任务，在同一个工作台展示验证结果、变更文件和展开的源码 Diff" />

<p align="center"><sub>在 Wegent Desktop 中执行并审查本地编码任务。</sub></p>

### Wegent Web 和 Backend

Wegent Web 提供浏览器端项目协作、远程智能体、知识库、自动化和管理入口。智能体使用配置好的模型、知识、Skills 和工具；Backend 提供共享项目资源、访问权限、API、调度和执行设备管理。团队可以自托管 Web 和 Backend，管理服务与数据。

<img src="https://github.com/wecode-ai/Wegent/releases/download/readme-assets/wegent-remote-agent.png" width="100%" alt="Wegent 远程智能体调用工具生成并展示甘特图" />

<p align="center"><sub>Wegent 远程智能体调用工具生成甘特图。</sub></p>

## 开发

需要 Node.js 22.15+（22.x）或 23.8+，推荐 Node.js 24，并安装 pnpm：

```bash
pnpm install
pnpm --filter wework dev
```

运行 macOS 桌面应用：

```bash
pnpm --filter wework dev:mac
```

桌面端的开发、构建和发布说明见 [wework/README.md](wework/README.md)；`wework/` 是当前桌面应用源码目录。

桌面架构中，Electron 提供系统能力并管理进程，DeepSeek Harness（DSH）托管产品界面与插件，Executor 管理任务和会话并驱动 Codex 执行。插件扩展点见 [DSH 应用宿主](wework/dsh/app-wework/README.md)，多人协作的资源与执行边界见[云项目协作架构](docs/zh/wegent/developer-guide/cloud-project-collaboration.md)。

## 仓库结构

### 产品与服务

| 目录                       | 职责                                         |
| -------------------------- | -------------------------------------------- |
| `wework/`                  | Wegent Desktop（Electron、Vite、React）      |
| `wework-mobile/`           | 独立的 Expo iOS/Android 客户端               |
| `frontend/`                | Wegent Web（Next.js、React）                 |
| `backend/`                 | 默认公共 API、业务逻辑和数据模型             |
| `backend-rs/`              | Rust 混合网关和已完成迁移的 API              |
| `executor/`                | Rust 任务执行器、本地设备运行时和 Codex 集成 |
| `executor_manager/`        | 服务端执行器调度、沙箱和任务编排             |
| `chat_shell/`              | 轻量对话与智能体运行时                       |
| `knowledge_runtime/`       | 知识索引和检索 API                           |
| `knowledge_doc_converter/` | 文档解析与异步转换服务                       |

### 共享代码与开发工具

| 目录                | 职责                                               |
| ------------------- | -------------------------------------------------- |
| `knowledge_engine/` | 知识解析、索引、向量存储和检索的可复用 Python 内核 |
| `shared/`           | 后端服务共享的 Python 模型、协议、工具和遥测能力   |
| `packages/`         | Web 与桌面端共享的 TypeScript 聊天和协作组件       |
| `sdk/`              | 插件认证、构建、创建和钉钉工作空间认证 SDK         |
| `wegent-cli/`       | 管理 Wegent CRD 资源的 Python 命令行工具           |

### 基础设施、测试与文档

| 目录        | 职责                                                      |
| ----------- | --------------------------------------------------------- |
| `docker/`   | 各服务镜像、独立部署资源和 `docker/telemetry/` 可观测性栈 |
| `scripts/`  | 安装、发布、验收、仓库策略和开发辅助脚本                  |
| `tests/`    | 跨服务 Playwright 集成测试和安装脚本测试                  |
| `docs/`     | 中英文用户文档、开发文档、架构方案和历史设计记录          |
| `patches/`  | pnpm `patchedDependencies` 使用的第三方依赖补丁           |
| `LICENSES/` | 仓库分发所需的第三方许可证文本                            |
| `.github/`  | CI、发布工作流、复合 Action 和仓库自动化                  |

### 根目录入口文件

| 文件                                   | 职责                               |
| -------------------------------------- | ---------------------------------- |
| `start.sh`、`install.sh`               | 本地启动和自托管安装入口           |
| `build_image.sh`、`build_image_mac.sh` | 多架构与本机 Docker 镜像构建入口   |
| `docker-compose*.yml`                  | 默认、构建和 E2E Compose 编排      |
| `package.json`、`pnpm-workspace.yaml`  | JavaScript/TypeScript 工作区定义   |
| `pyproject.toml`、`uv.lock`            | 仓库级 Python 工具配置和锁定元数据 |
| `AGENTS.md`、`CLAUDE.md`               | 贡献规则及其兼容符号链接           |

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
                <a href="https://github.com/luckjun529-lang">
                    <img src="https://avatars.githubusercontent.com/u/224970532?v=4" width="80;" alt="luckjun529-lang"/>
                    <br />
                    <sub><b>junlong chen</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/cc-yafei">
                    <img src="https://avatars.githubusercontent.com/u/78540184?v=4" width="80;" alt="cc-yafei"/>
                    <br />
                    <sub><b>YaFei Liu</b></sub>
                </a>
            </td>
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/sdadunderscoresdad">
                    <img src="https://avatars.githubusercontent.com/u/130071748?v=4" width="80;" alt="sdadunderscoresdad"/>
                    <br />
                    <sub><b>+7</b></sub>
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
                <a href="https://github.com/sunnights">
                    <img src="https://avatars.githubusercontent.com/u/1886887?v=4" width="80;" alt="sunnights"/>
                    <br />
                    <sub><b>Jake Zhang</b></sub>
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
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/cocowh">
                    <img src="https://avatars.githubusercontent.com/u/17496282?v=4" width="80;" alt="cocowh"/>
                    <br />
                    <sub><b>Birch</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/sleetdrop">
                    <img src="https://avatars.githubusercontent.com/u/88603?v=4" width="80;" alt="sleetdrop"/>
                    <br />
                    <sub><b>sleetdrop</b></sub>
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
            </td>
            <td align="center">
                <a href="https://github.com/jnhu76">
                    <img src="https://avatars.githubusercontent.com/u/5766215?v=4" width="80;" alt="jnhu76"/>
                    <br />
                    <sub><b>Jm.hu</b></sub>
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
                <a href="https://github.com/Twelveeee">
                    <img src="https://avatars.githubusercontent.com/u/48245733?v=4" width="80;" alt="Twelveeee"/>
                    <br />
                    <sub><b>Twelveeee</b></sub>
                </a>
            </td>
		</tr>
		<tr>
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
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/friendfei">
                    <img src="https://avatars.githubusercontent.com/u/5112004?v=4" width="80;" alt="friendfei"/>
                    <br />
                    <sub><b>friendfei</b></sub>
                </a>
            </td>
            <td align="center">
                <a href="https://github.com/WangZhuo2015">
                    <img src="https://avatars.githubusercontent.com/u/12570477?v=4" width="80;" alt="WangZhuo2015"/>
                    <br />
                    <sub><b>wang zhuo</b></sub>
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
                <a href="https://github.com/LiDaiyan">
                    <img src="https://avatars.githubusercontent.com/u/36092701?v=4" width="80;" alt="LiDaiyan"/>
                    <br />
                    <sub><b>Li Daiyan</b></sub>
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
                <a href="https://github.com/code-wangdi">
                    <img src="https://avatars.githubusercontent.com/u/11024395?v=4" width="80;" alt="code-wangdi"/>
                    <br />
                    <sub><b>Code-wangdi</b></sub>
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
                <a href="https://github.com/DeadLion">
                    <img src="https://avatars.githubusercontent.com/u/2594907?v=4" width="80;" alt="DeadLion"/>
                    <br />
                    <sub><b>Jasper Zhong</b></sub>
                </a>
            </td>
		</tr>
		<tr>
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
            <td align="center">
                <a href="https://github.com/pcbeingused333">
                    <img src="https://avatars.githubusercontent.com/u/82875882?v=4" width="80;" alt="pcbeingused333"/>
                    <br />
                    <sub><b>alexcastgonz</b></sub>
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
		</tr>
		<tr>
            <td align="center">
                <a href="https://github.com/haohaitao">
                    <img src="https://avatars.githubusercontent.com/u/26541344?v=4" width="80;" alt="haohaitao"/>
                    <br />
                    <sub><b>haohaitao</b></sub>
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
            </td>
		</tr>
	<tbody>
</table>
<!-- readme: contributors -end -->

---

<p align="center">Made with ❤️ by WeCode-AI Team</p>

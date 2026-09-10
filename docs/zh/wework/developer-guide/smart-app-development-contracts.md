---
sidebar_position: 40
---

# 智能工作台开发契约与验证闸门设计

## 背景

智能工作台由可编辑源码、DSH profile bundle、可选的 Host/Client 模块、依赖插件和最终发布包组成。现有开发链路已经能够创建目录、校验基础清单、启动隔离运行时并导出 ZIP，但不同阶段检查的对象和深度不一致：结构校验只确认必要文件存在，空白预设只保证目录合法，运行烟测只确认 HTTP 页面可访问。

因此，一些跨边界错误只能在安装或实际交互时暴露。例如：代码访问了未声明的服务、页面注册位置与产品意图不符、构建产物无法被客户端模块加载器发现，或者 Host 与 Client 使用了不兼容的通信协议。这些问题与具体业务无关，根因都是“项目意图没有成为机器可执行的开发契约”。

本文定义一套能力感知的通用开发契约。平台规定如何声明和验证，具体智能工作台仍然决定自己提供什么能力以及什么状态代表业务就绪。

## 目标

- 在开发和打包阶段发现服务依赖、模块发现、页面组合、远程通信和运行环境错误。
- 支持纯 Host、纯 Client、Host + Client、Remote 和多包组合等不同形态。
- 验证最终交付物，而不只验证源码或开发目录。
- 使用当前 Wework 管理的 DSH 和 Node.js Runtime，不从网络隐式选择最新版本。
- 所有运行验证使用隔离的临时 `DSH_HOME`，不读取或修改用户现有 DSH 凭据。
- 保留智能工作台的业务自由度，不把页面名称、数据类型、服务名称或 UI 布局写入平台规则。
- 让开发助手获得稳定、结构化、可定位的失败结果，避免根据模糊启动错误猜测修复。

## 非目标

- 不新增一套包裹 DSH 的 Smart App 运行时 SDK。
- 不要求所有智能工作台具有模型、Remote 或自定义页面。
- 不由平台理解或断言具体业务结果。
- 不用开发期验证替代 Wework 的安装安全检查、运行隔离和失败回滚。
- 不要求历史市场安装包包含开发期验证文件。

## 方案选择

### 仅加强开发助手说明

只在 Skill 中记录服务注入、模块加载和隔离验证规则，改动最小，但规则无法强制执行。模型切换、长对话和人工修改都可能绕过说明，因此不能作为主要方案。

### 开发契约与统一验证工具

每个可编辑智能工作台声明自己的能力、构建命令和最小就绪条件；统一工具按声明执行静态检查、构建、隔离冷启动和交付物复验。这种方式既能自动阻止已知错误类型，也不要求平台理解业务语义。

本设计采用此方案。

### 新建 Smart App SDK

通过新的高级 API 封装 DSH 服务注入、Remote、模块加载和页面注册，可以减少直接使用错误，但会形成第二套运行时抽象和长期兼容负担。当前 DSH 已经提供这些标准能力，本设计不引入该层。

## 总体架构

```text
项目能力与验收意图
        │
        ▼
smart-app.verify.json
        │
        ▼
统一验证编排器
  ├─ 结构与安全校验
  ├─ 项目契约测试
  ├─ 类型检查和构建
  ├─ 构建产物检查
  ├─ 隔离 DSH 冷启动
  ├─ Client 就绪/Remote 探针
  └─ ZIP 解包后复验
        │
        ▼
带内容指纹的验证结果
        │
        ▼
允许预览、打包或交付
```

开发契约负责描述意图，项目测试负责证明业务相关预期，验证编排器负责提供一致的执行环境和强制闸门。Wework 安装器继续负责不可信包的安全、结构和版本检查，两者职责不混合。

## 开发契约

### 文件位置和生命周期

可编辑智能工作台根目录使用 `smart-app.verify.json` 声明开发期验证契约。新建预设必须生成该文件；关联既有目录时，开发助手先检查并按项目实际能力补齐。市场安装包和只读导入包可以没有该文件，但没有契约的目录不能获得“开发验证通过”状态。

该文件不进入发布 ZIP。它不包含凭据、端口、机器路径或业务数据。

### 契约结构

```json
{
  "schemaVersion": 1,
  "scripts": {
    "typecheck": "typecheck",
    "test": "test",
    "build": "build",
    "runtimeProbe": "verify:runtime"
  },
  "capabilities": {
    "host": true,
    "client": true,
    "remote": true
  },
  "runtime": {
    "profile": "web",
    "path": "/",
    "readySelector": "[data-testid=\"smart-app-ready\"]"
  }
}
```

字段约束：

- `schemaVersion` 必须是验证器支持的明确版本。
- `scripts` 引用项目 `package.json` 中的 script 名称。验证器通过固定的
  Corepack/pnpm argv 调用，既不猜测构建工具，也不把契约值交给 shell 解析。
- `capabilities` 只声明项目真正拥有的运行边界。
- `runtime.profile` 必须与 `plugin-manifest.json` 的 entry profile 一致。
- `path` 和 `readySelector` 是应用自己定义的最小可观测就绪条件，不表达业务内容。
- Remote 的具体方法、参数和业务断言留在项目契约测试中，不复制进 JSON。

## 能力感知验证

验证器根据 `capabilities` 选择检查，不用一套模板强迫所有项目：

| 能力           | 强制检查                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| Host           | 入口可导入、依赖可解析、声明的注入可满足、进程可启动和停止                           |
| Client         | 包元数据可发现 Client 入口、构建产物符合 DSH ModuleLoader 工厂格式、浏览器模块可执行 |
| Remote         | 项目 Remote 契约测试通过，隔离运行时完成至少一次真实往返                             |
| 自定义页面     | 声明路径可访问，并在超时前出现项目自定义的就绪选择器                                 |
| 多包或外部插件 | 包名、路径、角色、版本和 bundle patch 在最终 profile 中可解析                        |

静态检查只用于快速定位确定性错误。服务是否可用、模块是否真正加载和 Remote 是否可达，必须由隔离运行时验证完成。

## 五层验证闸门

### 1. 结构与安全

扩展现有清单检查，验证：

- manifest 身份、版本、runtime requirements 和 entry。
- profile bundle 唯一性及其与 `entry.installPackage` 的一致性。
- packages、plugins、本地路径、重复声明和目录逃逸。
- package metadata、DSH bundle patch 和契约文件。
- 符号链接、压缩包大小、解压大小和敏感文件。

这一层不声称工作台可以运行。

### 2. 项目契约与构建

按开发契约运行类型检查、测试和构建，script 任一失败立即停止。新脚手架必须包含与所选能力相符的边界测试：Host 启动、Client 加载、组合意图以及可选 Remote 往返。

业务断言由项目测试拥有。统一工具只要求声明的命令存在、真实执行并成功退出。

### 3. 构建产物

验证实际产物而非源码文本：

- Node 入口可由声明的 package exports 解析和导入。
- Client 入口能在受控 ModuleLoader fixture 中注册模块工厂。
- 导出的 `package.json` 可被 DSH 发现。
- `files`、exports、bundle patch 和实际产物相互一致。
- 不允许“源码存在入口但发布文件未包含”的情况通过。

### 4. 隔离冷启动

验证器使用当前 Wework 提供的 Runtime 创建一次性环境：

1. 创建临时 `DSH_HOME` 和 profile。
2. 写入 Runtime 支持的最小非敏感配置。
3. 安装工作台声明的最终 packages 和 plugins。
4. 执行 `--dump-config` 并保留脱敏结果摘要。
5. 使用 `--no-open` 和随机 loopback 端口启动 DSH。
6. 等待 Host 健康状态和 Client 页面。
7. 检查 `path` 与 `readySelector`。
8. 声明 Remote 时执行项目提供的运行探针。
9. 停止进程并删除临时环境。

失败时保存隔离日志，但日志不得包含凭据、完整用户路径或业务输入。

### 5. 交付物复验

`pack` 必须依赖同一内容版本的完整验证：

1. 对源码、依赖声明、manifest、验证契约和 bundle patch 生成确定性的“验证输入指纹”。
2. 完成前四层验证。
3. 生成 ZIP。
4. 将 ZIP 解压到另一个临时目录。
5. 对解压内容重新执行结构、产物和冷启动验证。
6. 单独生成“交付物指纹”和 ZIP 哈希；只有验证输入未变化、交付物内容与 ZIP 一致且复验成功时才返回成功。

源码、依赖、manifest、验证契约或 bundle patch 在验证后发生变化时，旧结果立即失效。

## 脚手架策略

创建工作台时先选择最小能力模板：

- `web`：Client 入口、构建配置、就绪页面和 Client 加载测试。
- `host`：Host 入口、显式注入和启动测试。
- `web-host`：Host、Client、共享类型及两端独立测试。
- `web-host-remote`：在上一模板上增加 Remote 定义、Host 注册和往返测试。

模板只能包含通用就绪状态或健康检查。它不得默认注入模型、文件、网络或其他可选服务。开发助手确定需求后删除不使用的示例和能力，保持实际契约与代码一致。

## 开发助手流程

“智能工作台开发助手”按以下状态机运行：

```text
inspect → contract → doctor → validate → test → build
        → verify-artifacts → cold-start → preview → pack-verify
```

- `inspect`：读取现有 manifest、packages、依赖、源码和 profile，不覆盖已有目录。
- `contract`：识别 Host、Client、Remote 等能力并创建或更新验证契约。
- `doctor`：检查当前 Wework 提供的 Node、pnpm 和 DSH Runtime。
- `validate`：执行结构与安全检查。
- `test/build`：通过固定的 Corepack/pnpm argv 运行项目声明的 package scripts。
- `verify-artifacts`：验证实际构建产物。
- `cold-start`：在隔离环境执行真实安装与启动。
- `preview`：在 Wework 内置 WebView 完成主要路径、一个无效输入路径和恢复路径。
- `pack-verify`：需要分发时打包并从 ZIP 复验。

任何闸门失败都停止后续阶段。助手必须读取结构化错误和对应日志后修复主路径，不增加未经确认的兼容路径或 silent fallback。

## 变更分类与验证失效

| 变更类型               | 开发期动作             | 交付前动作            |
| ---------------------- | ---------------------- | --------------------- |
| Client 实现            | 页面刷新或 HMR         | 完整冷启动与 ZIP 复验 |
| Host 实现              | 重启 DSH               | 完整冷启动与 ZIP 复验 |
| Remote 契约            | 重启两端并运行往返测试 | 完整冷启动与 ZIP 复验 |
| package、exports、依赖 | 重装并重启 DSH         | 完整冷启动与 ZIP 复验 |
| manifest、bundle patch | 重新准备 profile       | 完整冷启动与 ZIP 复验 |
| 仅文档                 | 不使运行验证失效       | 打包内容安全检查      |

文件指纹决定验证结果是否仍有效，不能依赖人工判断或文件 watcher 事件。

## 错误模型

验证结果使用稳定的阶段码：

- `SA-ENV-*`：Node、pnpm、DSH 或隔离环境。
- `SA-MANIFEST-*`：manifest、包结构和路径。
- `SA-DEPENDENCY-*`：插件或服务依赖。
- `SA-HOST-*`：Host 导入、启动和退出。
- `SA-CLIENT-*`：Client 入口、exports 和 ModuleLoader。
- `SA-COMPOSITION-*`：实际页面未达到项目声明的入口或就绪条件。
- `SA-REMOTE-*`：Remote 注册、调用或返回协议。
- `SA-RUNTIME-*`：profile、dump-config、端口和进程生命周期。
- `SA-PACKAGE-*`：ZIP 内容、指纹或冷安装。

每个问题包含 `code`、`stage`、`file`、`message`、`expected`、`actual`、`blocking` 和修复提示。命令默认输出人类可读摘要，并支持 JSON 供开发助手和 Wework UI 消费。

## 产品集成边界

- 开发验证器服务可信的本地源码；Wework 安装器继续处理不可信包和安全边界。
- “开发验证通过”不等于“市场审核通过”。市场仍执行权限、敏感文件、平台兼容和发布策略检查。
- 预览栏可以显示当前阶段、错误和验证是否因文件变化失效，但不解释具体业务结果。
- 安装回滚保留为最终安全网，不能替代开发期冷启动。
- 旧安装包无须迁移；只有继续编辑时才由开发助手建立验证契约。

## 测试矩阵

### 正向 fixture

- 纯 Host。
- 纯 Client。
- Host + Client。
- Host + Client + Remote。
- 多包 profile bundle。
- 组合本地及远程 DSH 插件。

### 负向 fixture

- 代码依赖的服务未声明或 profile 不提供。
- Client 注册成功，但未满足项目声明的入口或就绪条件。
- package exports 缺少运行时需要的元数据或入口。
- 源码正确但构建产物没有 ModuleLoader 工厂。
- Remote 两端方法或数据契约不一致。
- DSH 或 Node 版本不满足要求。
- 用户 DSH 配置无效，但隔离验证仍可运行。
- 开发目录可运行，但 ZIP 缺文件或冷安装失败。
- 验证完成后内容改变，旧结果被拒绝。

### Wework Electron E2E

- 从每种最小模板创建工作台。
- 打开开发助手并完成验证。
- 制造一种结构错误和一种运行错误，确认预览显示可定位失败且阻止打包。
- 修复后运行内置预览、导出 ZIP、重新导入并启动。
- 验证失败和成功路径均清理临时 Runtime、端口和日志。

## 实施阶段

### P0：开发期强制闸门

- 定义 `smart-app.verify.json` schema。
- 扩展空白预设为能力模板。
- 为开发工具增加 `inspect` 和 `verify`。
- 实现项目命令、产物验证和隔离冷启动。
- 让 `pack` 依赖内容指纹匹配的成功验证并执行 ZIP 复验。
- 更新开发助手 Skill，明确状态机和失败处理。

### P1：Wework 开发体验

- 在开发预览显示阶段、错误码和验证失效状态。
- 根据变更类型建议刷新页面或重启 DSH。
- 将脱敏验证记录保存到 `test-results/smart-app/`。
- 为错误提供文件定位和修复入口。

### P2：发布与安装复用

- 发布前复用 ZIP 结构、产物和冷安装验证。
- 将验证摘要作为发布检查证据，但不信任包内自报结果。
- 保持安装回滚和运行时隔离作为独立最后防线。

## 验收标准

- 五类跨边界错误都能在开发期以稳定错误码失败。
- 验证规则不包含任何具体行业、页面或数据类型。
- 六种正向 fixture 均能通过各自所需的最小验证集合。
- 未声明某项能力的工作台不会被要求实现该能力。
- `pack` 无法使用过期验证结果，并能发现仅在 ZIP 中出现的问题。
- 验证不会读取、覆盖或迁移用户 DSH 凭据。
- Wework 内置预览和真实 Electron E2E 覆盖失败、修复、重新验证及清理。

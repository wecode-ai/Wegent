---
sidebar_position: 26
---

# 协作执行完整 E2E 测试计划

审计日期：2026-09-12

## 目标

本计划用于验证协作功能从资源创建到真实执行完成的完整闭环，而不是只验证页面可见、配置已保存或模型返回了“已完成”文本。

必须证明：

1. 用户可以分别从 Wegent Web 和 Wework 创建或使用协作资源。
2. 真实 Executor 能注册、上报能力、被调度并实际执行任务。
3. Workspace、Project、Issue、成员、智能体和执行环境之间的关系真实持久化。
4. Issue 分配给 Wegent Chat 智能体后，Skill 与 MCP 能被加载、调用并产生可验证结果。
5. Issue 分配给 Wegent ClaudeCode 智能体后，Skill 与 MCP 能被加载、调用并产生可验证结果。
6. Issue 分配给 Codex 智能体后，Skill、MCP 和 Plugin 能被加载、调用并产生可验证结果。
7. Issue 分配给人后，Wework 能收到通知，用户能从 Issue 创建私人本地任务，在真实运行时执行，并按明确指令操作共享 Issue。
8. 执行失败、Executor 离线、页面刷新、进程重启和重复事件不会伪造成功或破坏最终一致性。
9. 每个关键步骤都有结构化断言、后端证据和截图证据。

## 已审计的运行模型

Wegent Shell 与 Wework 项目智能体使用不同配置模型，E2E 必须明确被测运行链。

### Wegent Chat、ClaudeCode 与 Codex

Chat、ClaudeCode 和 Codex 使用 Wegent 的 CRD 资源链：

```text
Team
  -> Bot
    -> Ghost
      -> Skill references
      -> MCP servers
    -> Shell: Chat | ClaudeCode | Codex
    -> optional Model
```

- `Ghost` 保存提示词、Skill 引用和 MCP 配置。
- `Bot` 组合 Ghost、Shell 和可选模型。
- `Team` 组合一个或多个 Bot，并定义协作模式。
- Task 创建后，后端解析 Team、Bot、Ghost、Skill 和 MCP，构造实际执行请求。
- Chat Shell 进入 Chat Runtime。
- ClaudeCode Shell 通过 Executor Manager 调度到真实 Executor，并启动 Claude Code CLI。
- Codex 公共 Shell 同样通过 Executor Manager 调度到真实 Executor，并启动 Codex app-server。

### Wework Codex 项目智能体

除公共 Shell 外，Codex 也支持 Wework 的项目智能体与本地运行时链；本文 E2E-06 验证的是这条链：

```text
ProjectChatAgent
  -> Wework Runtime
    -> Codex app-server / Codex CLI
      -> Skill
      -> MCP
      -> Codex Plugin
```

- 项目智能体由 `ProjectChatAgent` 表达。
- Codex 的 Skill、MCP 和 Plugin 物化到隔离的 Codex Home。
- Plugin 可以同时提供 Skill、MCP 和其他 Codex 扩展能力。
- E2E 必须分别验证 Wegent Codex Shell 链和 Wework Codex 项目智能体链，不能用一条链的证据替代另一条。

### 人

人的分配链不直接启动 AI Runtime：

```text
Issue assignment
  -> Wework notification
    -> User opens Issue
      -> User creates private local Task
        -> Local Wework Runtime starts
          -> Issue moves to in progress
            -> Runtime completes without advancing Issue again
```

分配给人首先产生通知和协作上下文。用户可以从通知进入 Issue，也可以在未被分配时主动进入 Issue 并创建任务。私人任务的对话和终态不自动写入共享 Issue；评论、交付和后续状态变化由用户手动执行，或由 AI 在收到明确指令后通过项目空间工具执行。

## 测试边界与真实性原则

### 必须使用真实组件

- 真实 Backend、数据库和 Redis。
- 真实 Wegent Web 页面。
- 真实 Wework Electron 应用。
- 真实 Executor 注册与心跳。
- 真实 Chat Shell、Claude Code CLI 和 Codex Runtime。
- 真实 Workspace、Project、Issue、Task、消息、动态、通知和状态投影。
- 真实 Skill 解析、MCP tool call、tool output 回传和 Plugin 物化。

### 允许确定性替代的外部依赖

模型上游和第三方 MCP 服务可以使用确定性测试服务器，但替代范围只能停留在系统边界：

- 模型服务器必须记录每一轮请求，并按预期返回真实 tool call。
- MCP 测试服务器必须记录工具名、参数、调用顺序和返回值。
- 测试不得绕过 Chat Shell、Claude Code CLI、Codex Runtime、Executor 或后端状态机。
- 不得直接写数据库制造执行成功。
- 不得通过拦截前端请求伪造成功响应。
- 不得只断言模型文本包含“完成”。

### 每个 checkpoint 自包含

每个 checkpoint 必须建立自己的最小前置条件，支持：

- 单 checkpoint 执行；
- 从该 checkpoint 开始执行；
- 完整套件执行；
- 失败后单独复现。

checkpoint 不得依赖仅由更早且可能被跳过的 checkpoint 创建的数据。

## 测试资源模型

每次运行使用唯一命名空间或名称后缀，避免并发分片互相污染：

```text
Workspace: collaboration-e2e-<run-id>
Project: execution-project-<run-id>
Chat Team: chat-agent-<run-id>
Claude Team: claude-agent-<run-id>
Codex ProjectChatAgent: codex-agent-<run-id>
Executor: collaboration-executor-<run-id>
Issues:
  - CHAT-<run-id>
  - CLAUDE-<run-id>
  - CODEX-<run-id>
  - HUMAN-<run-id>
```

每个执行智能体使用独立的探针值，防止某个运行时误用其他运行时的结果：

| 智能体     | Skill 探针              | MCP 探针              | Plugin 探针             |
| ---------- | ----------------------- | --------------------- | ----------------------- |
| Chat       | `CHAT_SKILL_<run-id>`   | `CHAT_MCP_<run-id>`   | 不适用                  |
| ClaudeCode | `CLAUDE_SKILL_<run-id>` | `CLAUDE_MCP_<run-id>` | 不适用                  |
| Codex      | `CODEX_SKILL_<run-id>`  | `CODEX_MCP_<run-id>`  | `CODEX_PLUGIN_<run-id>` |

任务最终产物必须同时包含正确探针值，并由文件、后端动态、MCP 调用记录或交付物接口证明。

## 智能体模型与会话回归

在 `project-automation`、`collaboration-local-agent-dispatch` 和
`collaboration-remote-agent-dispatch` checkpoint 中覆盖智能体执行主链路。
本地和远程进程验证必须分别记录；隔离远程 Executor 的通过结果不代表用户云设备已经验证。

| 场景             | 必须验证的结果                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| 自动标签分派     | 在 UI 添加 `auto` 标签后只产生一次执行；实际模型请求使用分派智能体的模型，结果回写后进入待确认         |
| Team 模型继承    | 未选择覆盖模型时提交 `wegentTeamId`，不带入工作台的默认模型；执行 Shell 以编译后的 Team 为准           |
| V2 请求边界      | materialize 响应不序列化顶层 `modelConfig: null`；实际模型配置仅保留在编译后的执行请求中               |
| 手动执行后续聊   | TaskBinding 持久化 Team ID；回复继续原任务且 `newSession=false`，首轮和续聊的实际模型一致              |
| 手动执行能力边界 | 使用 executor 角色读取当前 Issue；Code Mode 实际调用读取工具，不暴露分派和管理类工具                   |
| 完整结果回写     | 历史快照先写完成状态时，迟到的同轮终态事件仍保存完整正文；旧轮事件不得结束新一轮续聊                   |
| App 设备事件回写 | 同一设备的 `app-record-*` 与本地安装 ID 可匹配同一活动，但必须校验设备所有者；完成和失败均更新活动终态 |
| 失败处理权限     | 无触发消息的人工启动仅允许启动者结束失败响应；他人或其他触发消息的发送者不能越权                       |

断言完成时必须检查智能体消息内容及终态，不得用包含探针文本的用户输入充当模型执行成功的证据。
保留 Electron 截图、任务 ID、模型路由日志和后端终态；不得记录认证令牌或模型密钥。

## 完整场景矩阵

### E2E-01：Wegent 创建协作资源

目标：证明 Wegent Web 能创建协作域资源，并且资源真实持久化。

步骤：

1. 登录 Wegent Web。
2. 进入协作入口。
3. 创建 Workspace。
4. 在 Workspace 中创建 Project。
5. 创建或引入 Chat Team：
   - Bot Shell 选择 `Chat`；
   - Ghost 配置 Skill；
   - Ghost 配置 MCP。
6. 创建或引入 ClaudeCode Team：
   - Bot Shell 选择 `ClaudeCode`；
   - Ghost 配置 Skill；
   - Ghost 配置 MCP。
7. 将两个 Team 加入当前 Workspace 或 Project 的可用智能体范围。
8. 刷新页面并重新进入，验证资源仍然存在。
9. 通过 API 读取并核对 Workspace、Project、Team、Bot 和 Ghost 的持久化数据。

核心断言：

- Kind 资源按 `namespace + name + user_id` 唯一读取。
- Bot 引用正确 Ghost 和 Shell。
- Team 引用正确 Bot。
- Ghost 包含预期 Skill 引用和 MCP 配置。
- Workspace 与 Project 关系存在且状态为 active。
- UI 刷新后与 API 状态一致。

### E2E-02：Wework 创建和浏览协作资源

目标：证明 Wework 使用协作页面完成资源创建和浏览，而不是旧的“我的任务”页面或本地伪数据。

步骤：

1. 启动隔离的 Wework Electron。
2. 登录同一测试账号。
3. 打开“协作”标签。
4. 从“所有空间”创建 Workspace。
5. 进入 Workspace 并创建 Project。
6. 在 Workspace 资源页浏览成员、智能体和执行环境。
7. 在 Project 中打开 Issue 表格与看板。
8. 刷新 Wework 页面或重启 renderer。
9. 通过 Wegent Web 打开同一 Workspace 和 Project。

核心断言：

- Wework 创建的资源能在 Wegent Web 中读取。
- Wegent 创建的资源能在 Wework 中读取。
- 两端显示相同资源 ID、名称、状态和成员关系。
- Wework 的协作标签挂载协作页面；“我的任务”仍是任务模块中的一种任务视图。

### E2E-03：真实 Executor 注册与恢复

目标：证明执行环境不是静态配置，而是真正可调度的 Executor。

步骤：

1. 从产品界面创建执行环境或生成部署命令。
2. 使用命令中的一次性注册凭证启动真实 Executor。
3. 等待 Executor 向后端注册。
4. 验证心跳、版本、平台和能力上报。
5. 将执行环境加入测试 Workspace 的可用范围。
6. 停止 Executor，验证状态变为离线。
7. 使用同一合法身份重新启动 Executor。
8. 验证状态恢复在线且能力信息一致。

核心断言：

- Executor ID 与后端注册记录一致。
- 在线状态来自真实心跳，不是前端本地状态。
- 执行能力包含目标 Shell 或 Runtime 所需能力。
- 离线 Executor 不得接收新执行。
- 恢复后可以接收后续任务。

日常 CI 可以使用部署命令中的注册信息直接启动仓库内真实 Executor 二进制；容器镜像和完整 Docker 命令另设低频部署烟测，但不得用内存假 Executor 替代执行链。

### E2E-04：Issue 分配给 Wegent Chat 智能体

目标：证明 Chat 智能体从 Issue 分配一直执行到完成，并真实加载 Skill 和 MCP。

步骤：

1. 在 Project 中创建 Chat Issue。
2. Issue 内容要求：
   - 读取指定 Skill；
   - 调用指定 MCP 工具；
   - 将 MCP 返回值与 Skill 探针写入结果。
3. 在 Issue 动态中将任务分配给 Chat Team。
4. 验证分配事件持久化。
5. 等待后端创建 Task 和执行记录。
6. Chat Shell 启动真实执行。
7. 确定性模型要求调用 MCP 工具。
8. MCP 返回 `CHAT_MCP_<run-id>`。
9. 模型根据 Skill 指令生成最终结果。
10. 等待 Task、执行记录、项目消息和 Issue AI 状态进入终态。

必须验证：

- 调度使用预期 Team、Bot、Ghost 和 Chat Shell。
- 初始模型请求包含预期 Skill 内容或 Skill 定位信息。
- 模型实际发出预期 MCP tool call。
- MCP 服务收到正确工具名和参数。
- 非空 tool output 被送入下一轮模型请求。
- 最终结果包含 `CHAT_SKILL_<run-id>` 和 `CHAT_MCP_<run-id>`。
- 后端 Task 为 `COMPLETED`。
- Issue 动态中存在完成消息，AI 状态为 completed。

### E2E-05：Issue 分配给 Wegent ClaudeCode 智能体

目标：证明 ClaudeCode 智能体被真实 Executor 调度，Claude Code CLI 实际加载 Skill、调用 MCP 并产生文件产物。

步骤：

1. 在 Project 中创建 Claude Issue。
2. Issue 要求读取 Skill、调用 MCP，并在工作目录生成结果文件。
3. 将 Issue 分配给 ClaudeCode Team。
4. 验证后端选择在线且具备 ClaudeCode 能力的 Executor。
5. 启动真实 Claude Code CLI。
6. Claude Code 读取 Skill。
7. Claude Code 调用 MCP 工具。
8. MCP 返回 `CLAUDE_MCP_<run-id>`。
9. Claude Code 写入 `claude-result.txt`。
10. 等待 Task、Runtime 和 Issue 投影进入终态。

必须验证：

- 调度身份包含预期 Team、Bot、Ghost、Executor 和 runtime task。
- Executor 日志证明真实 Claude Code 进程启动。
- Skill 内容进入执行上下文。
- MCP tool call、输入、输出和后续模型上下文完整。
- `claude-result.txt` 实际存在且同时包含
  `CLAUDE_SKILL_<run-id>` 和 `CLAUDE_MCP_<run-id>`。
- Task 和 Runtime 为 completed。
- Issue 状态进入等待确认或已完成，不能停留在“执行中”。

### E2E-06：Issue 分配给 Codex 项目智能体

目标：证明 Codex 通过 ProjectChatAgent 和 Wework Runtime 实际加载 Skill、MCP 和 Plugin。

步骤：

1. 在当前 Workspace 中创建 Codex ProjectChatAgent。
2. 创建隔离 Codex Plugin，包含：
   - `.codex-plugin/plugin.json`；
   - Plugin Skill；
   - Plugin MCP 配置；
   - 唯一 Plugin 探针。
3. 将 Plugin 安装或绑定到该 ProjectChatAgent 使用的隔离 Codex Home。
4. 为 Codex Agent 配置额外 Skill 和 MCP。
5. 在 Project 中创建 Codex Issue。
6. 将 Issue 分配给 Codex ProjectChatAgent。
7. Wework Runtime 启动真实 Codex app-server 或 Codex CLI。
8. Codex 发现 Plugin。
9. Codex 读取 Plugin 提供的 Skill。
10. Codex 按实际工具广告方式发现 Plugin MCP：工具数量低于延迟加载阈值时直接获得 namespaced 工具；进入延迟加载时通过 tool search 查找。
11. Codex 调用 Plugin MCP，并把输出用于后续推理。
12. Codex 生成 `codex-result.txt` 或等价交付物。
13. 等待运行任务和 Issue 状态进入终态。

必须验证：

- 本场景实际调度对象是 ProjectChatAgent；Wegent `Codex` Shell 需单独验证。
- Codex Home 中存在目标 Plugin 的物化文件。
- 初始请求或工具输出中出现正确 Skill locator。
- Codex 实际读取目标 `SKILL.md`。
- Codex 的工具发现路径与本次运行的实际广告方式一致；直接广告和 tool search 两种路径均需由对应 E2E 覆盖。
- Codex 调用 namespaced Plugin MCP 工具。
- MCP 输出进入后续模型请求。
- 产物同时包含 `CODEX_SKILL_<run-id>`、
  `CODEX_MCP_<run-id>` 和 `CODEX_PLUGIN_<run-id>`。
- Wework Task 完成，Issue 动态和状态投影完成。

### E2E-07：Issue 分配给人并由 Wework 执行

目标：证明负责人可以从共享 Issue 创建仅自己可见的本地任务，把 AI
作为个人工具执行工作，同时保持私人执行流与共享协作状态的边界。

步骤：

1. 分配者把 Human Issue 分配给目标用户。
2. 验证后端通知记录和收件箱记录创建。
3. 验证 Wework 出现系统通知和应用内未读标识。
4. 用户点击通知，深链进入正确 Workspace、Project 和 Issue。
5. 用户在 Issue 中点击“创建任务”。
6. 新任务仅对当前用户可见，并自动保留 Workspace、Project 和 Issue 上下文。
7. Composer 以原生 Issue 气泡展示当前 Issue，而不是普通文本或错误状态标签。
8. 用户提交执行要求，本地 Runtime 开始运行后，Issue 从收集箱或待处理进入进行中。
9. Runtime 能使用 `wework_space` 工具读取当前 Issue；只有用户明确要求时才更新
   Issue、添加评论或提交交付物。
10. 运行时生成 `human-result.txt` 或等价本地产物并完成 Task。
11. Task 完成、失败、停止或产生交付物时，不自动把 Issue 推进到待确认或已完成。
12. 用户手动修改 Issue 状态，或明确要求 AI 使用 `wework_space` 修改状态。

必须验证：

- 通知接收人、分配事件和 Issue ID 正确。
- 重复分配事件不会产生重复通知。
- 点击通知进入正确 Issue，不只是打开协作首页。
- 新建 Task 绑定正确 Workspace、Project、Issue、用户和当前本地设备。
- 发送后的 Issue 引用保持原生气泡样式，不出现 `[blocked]` 等状态文本污染。
- 执行由真实本地 Runtime 完成，并具备项目空间工具。
- Runtime 启动会把可开始的 Issue 自动标记为进行中。
- Runtime 终态、停止和交付不会继续改动 Issue 状态或负责人。
- 私人任务中的普通对话不会自动发布为共享 Issue 评论。
- 用户明确要求 AI 更新 Issue 时，工具调用使用当前项目和 Issue 的显式 ID。

补充场景：

- 未分配给当前用户时，用户仍可主动进入 Issue 创建任务。
- 主动参与不得伪造“已分配给我”的通知或分配事件。
- Issue 已处于待确认或已完成时，启动私人任务不得把状态回退到进行中。
- 人工处理面板的“接手处理”是独立的显式动作：待确认或已完成的事项转交后，
  保留原 Issue 状态并清除旧人工提交；新处理人点击接手才进入进行中。
  旧处理人不能接手，当前指派下已经提交或验收的结果也不能重复接手。
  `project-assignment-notification` 覆盖验收后重新指派与显式接手，不发起 AI 请求。

### E2E-08：跨端一致性

步骤：

1. Wegent 创建 Workspace、Project 和 Issue。
2. Wework 打开同一 Issue 并执行分配。
3. Wegent 观察执行中状态和动态。
4. 智能体或人完成任务。
5. 两端刷新并读取最终状态。

必须验证：

- 资源 ID 不变。
- 动态顺序一致。
- Task、执行记录和 Issue 状态一致。
- 任一端刷新或重启后均可恢复当前状态。
- 同一完成事件不会被重复投影。

## 失败与恢复场景

### Executor 离线

- 分配前离线：任务保持可解释的等待状态，不得标记 completed。
- 执行中离线：运行记录进入失败、失联或可恢复状态，并保留诊断信息。
- Executor 恢复：只恢复允许恢复的执行；不得重复创建两个有效执行。

### Skill 加载失败

- Skill 不存在、hash 不匹配或内容不可读时，执行必须失败并暴露准确原因。
- 不得静默忽略 Skill 后继续报告成功。

### MCP 失败

- MCP 不可连接、工具不存在、参数不合法和超时分别验证。
- tool call 失败必须进入模型或 Runtime 的错误链。
- 未获得有效 tool output 时不得生成通过断言的产物。

### Plugin 失败

- Plugin 未安装、manifest 非法、Skill 缺失或 MCP 未注册时，Codex 场景必须失败。
- 修复并重新安装后，使用新的运行任务验证恢复。
- 不得复用失败运行留下的旧产物。

### UI 与进程恢复

- Wegent 页面刷新后恢复 Issue 和执行状态。
- Wework renderer 重载后恢复标签、Issue 和任务绑定。
- Wework 应用重启后恢复未完成任务，不得把陈旧运行态复活成新执行。
- 重复通知、重复 webhook 或重复轮询结果保持幂等。

### 权限与隔离

- 非 Workspace 成员不能读取 Workspace。
- 非 Project 成员不能执行 Project 内受限操作。
- 一个用户的分配通知不能出现在另一用户的 Wework 中。
- 一个运行的 Plugin、Skill、MCP 和 Codex Home 不能污染另一个运行。

## 统一执行证据

每个智能体执行场景必须收集以下四层证据。

### 1. 调度身份

至少记录并断言适用字段：

```text
workspaceId
projectId
issueId
assignmentId or assignment event id
teamId
botId
ghostId
projectChatAgentId
backendTaskId
runtimeTaskId
executorId
executorType
runtimeDeviceId
```

身份字段必须来自后端 API、执行记录或 Runtime 日志，不能从 UI 文本猜测。

### 2. 后端与运行时终态

智能体直接承接 Issue 的场景至少断言：

```text
Task status == COMPLETED
Runtime execution status == completed
Project message status == completed
Project message metadata.run_status == completed
Issue ai_state.status == completed
Issue status == in_review | completed
```

人工负责人创建私人本地 Task 的场景单独断言：Task 和 Runtime 已完成，
Issue 保持 Runtime 启动后的 `in_progress`，直到用户手动修改或明确要求 AI
使用项目空间工具修改。

不同运行时没有对应字段时，文档化映射关系，并断言该运行时的权威终态字段。

### 3. Tool call 与 output

必须形成完整链：

```text
Skill locator or content enters runtime
  -> model emits expected tool_call
    -> MCP receives expected tool name and input
      -> MCP returns non-empty tool_output
        -> next model request contains the tool_output
```

只看到工具列表、只看到按钮、只保存 MCP 配置或只看到模型提到工具，都不算通过。

### 4. 不可伪造副作用

每个执行至少验证一个模型文本无法伪造的副作用：

- 工作目录中的真实文件及准确内容；
- MCP 测试服务器收到的准确调用记录；
- 后端持久化的 Issue 动态、评论或交付物；
- Wework 持久化的 Task 绑定和完成状态；
- 通知服务中目标用户的通知记录。

推荐同时验证文件和后端记录，避免单点假阳性。

## 截图证据链

截图保存到测试结果目录或 CI artifact，不提交到仓库。文件名必须带顺序号、宿主、场景和状态。

### 公共资源与 Executor

1. `01-wegent-workspace-created.png`：Wegent 中新建 Workspace。
2. `02-wegent-project-created.png`：Wegent 中新建 Project。
3. `03-wegent-agents-configured.png`：Chat 与 ClaudeCode 智能体及其配置摘要。
4. `04-wework-workspace-visible.png`：Wework 中看到同一 Workspace。
5. `05-wework-project-visible.png`：Wework 中看到同一 Project。
6. `06-executor-deploy-command.png`：执行环境部署入口和命令已生成，凭证必须遮盖。
7. `07-executor-online.png`：真实 Executor 在线及能力上报。

### Chat 执行

8. `08-chat-issue-created.png`：Chat Issue 详情。
9. `09-chat-assigned.png`：Issue 动态中的 Chat 分配事件。
10. `10-chat-running.png`：Chat 执行中状态。
11. `11-chat-completed.png`：完成动态、探针结果和 Issue 终态。

### ClaudeCode 执行

12. `12-claude-issue-created.png`：Claude Issue 详情。
13. `13-claude-assigned.png`：ClaudeCode 分配事件。
14. `14-claude-running.png`：Executor 上的 ClaudeCode 执行中状态。
15. `15-claude-artifact.png`：真实文件产物预览。
16. `16-claude-completed.png`：Issue 终态。

### Codex 执行

17. `17-codex-agent-plugin.png`：ProjectChatAgent、Skill、MCP 和 Plugin 配置。
18. `18-codex-issue-created.png`：Codex Issue 详情。
19. `19-codex-assigned.png`：Codex 分配事件。
20. `20-codex-plugin-loaded.png`：运行详情中的 Plugin/Skill/MCP 加载证据。
21. `21-codex-artifact.png`：包含三类探针的真实产物。
22. `22-codex-completed.png`：Task 与 Issue 终态。

### 人工执行

23. `23-human-assignment-notification.png`：Wework 收到分配通知。
24. `24-human-notification-center.png`：通知中心中的目标 Issue。
25. `25-human-issue-opened.png`：点击通知后打开正确 Issue。
26. `26-human-task-created.png`：从 Issue 创建并绑定的任务。
27. `27-human-task-running.png`：真实 Runtime 执行中。
28. `28-human-artifact.png`：本地产物已生成。
29. `29-human-task-completed.png`：Task 已完成且 Issue 仍保持进行中。

### 恢复与跨端

30. `30-executor-offline.png`：Executor 离线状态。
31. `31-executor-recovered.png`：Executor 恢复在线。
32. `32-wegent-final-state.png`：Wegent 最终状态。
33. `33-wework-final-state.png`：Wework 最终状态。

截图 review 必须检查：

- 顺序连续，没有用后一步截图替代前一步。
- Workspace、Project 和 Issue 名称或 ID 能串成同一条链。
- 没有凭证、token、用户隐私或本机敏感路径。
- 截图显示的状态与结构化日志一致。
- 没有用静态 demo、旧页面或测试桩页面充当产品证据。

## 执行环境部署证据链

协作功能不另造一套 Executor 部署流程。Workspace 中的“执行环境”复用 Wework
连接设置中的远程执行环境引导，并由两个已有 checkpoint 提供真实证据。

### `remote-device-onboarding`

该 checkpoint 必须连续证明：

1. 从 Wework UI 打开“添加远程执行环境”对话框。
2. UI 生成包含 Backend、WebSocket、设备 ID、设备名称和一次性授权信息的部署命令。
3. 复制按钮写入的内容与 UI 展示的可运行命令完全一致。
4. 测试进程使用这条命令中的设备身份和授权信息启动真实 Executor 二进制，不预先向
   Backend 写入设备记录。
5. Backend 返回 `online` 状态和非空 Runtime identity，Wework 设备卡同步显示在线。
6. 通过该设备创建远程项目，调试快照中的 Runtime Task `deviceId` 必须等于刚部署的设备。
7. 真实 Codex 工具循环在该设备的项目目录创建
   `wework-cloud-e2e-result.txt`，文件内容为
   `CODEX_EXECUTED_REAL_CLOUD_TOOL`，随后任务正常结束。

证据截图：

- `cloud-00-remote-docker-command.png`
- `cloud-00-generated-remote-device-online.png`
- `cloud-00-disabled-session-settings.png`
- `cloud-00-disabled-session-project.png`
- `cloud-00-generated-remote-task-running.png`
- `cloud-00-generated-remote-task-completed.png`

其中“禁用终端/IDE”是能力上报的边界验证，不代替任务执行验证。

### `collaboration-agent-automation-chain`

该 checkpoint 还必须覆盖 Wework 设备创建项目执行环境的记录路由回归：

1. 启动桌面 App 自带的真实 Executor，再启动第二个真实 Executor，并让两者使用相同的
   App 逻辑设备 ID、不同的 Runtime identity。
2. Backend 必须保存两条独立设备记录，并为它们返回不同的 `app-record-{id}` 执行路由；
   测试不得直接写数据库伪造设备。
3. 从项目设置添加桌面 App 对应的 Wework 设备，填写有效仓库与初始化步骤，然后点击
   “创建环境”。
4. 环境准备命令必须发送到所选设备记录的 `app-record-{id}` 路由，状态变为
   `ready`，并以该路由为键持久化到执行环境的 `devices` 映射中。
5. 删除该 Wework 设备后，继续使用真实云端 Executor 创建环境并完成原有双智能体自动
   处理链，证明记录路由修复未破坏后续调度。

环境准备克隆仓库时使用设备上已配置的 Git 凭据，与任务派发到设备的方式一致：Backend
不下发任务级 token，因为一个执行环境的多个仓库可能分属不同域名。因此私有仓库必须先把
Git 账号同步到该设备，否则克隆会因缺少凭据失败。

### `cloud-device-lifecycle`

该 checkpoint 复用 CI 启动的真实云端 Executor，验证：

1. 初始 Backend 状态为 `online`，设备具有 Executor 版本和 Runtime identity。
2. Wework 展示版本升级入口、当前版本、目标版本和短暂离线提示。
3. 管理型云环境中，重启操作命中 Sandbox identity；重启等待期间设备操作被禁用。
4. 测试真实停止 Executor 进程，等待 Backend 变为 `offline`，再启动同一 Executor。
5. Backend 恢复 `online`，Runtime identity 保持稳定，Wework 显示“重新在线”并恢复操作。
6. 不支持管理型恢复的公共 Backend 分支必须明确显示重启失败，且不能把在线设备误标为离线。

证据截图：

- `cloud-device-01-online.png`
- `cloud-device-upgrade-confirmation.png`
- `cloud-device-restart-pending.png`
- `cloud-device-restart-recovered.png`
- `cloud-device-restart-unavailable.png`（仅公共 Backend 拒绝分支）

## CI checkpoint 映射

优先扩展和复用现有 checkpoint，不复制已有部署、插件或运行时框架。

| 能力                          | 现有 checkpoint / 套件                           | 目标改造                                                              |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Wegent 协作资源创建           | Frontend collaboration Playwright                | 增加 Workspace、Project、Chat/Claude 资源创建和跨端持久化断言         |
| Wework 协作资源浏览与创建     | `collaboration-shared-core`                      | 覆盖 Wework 创建资源、跨端读取和共享协作主流程                        |
| Executor 注册与可执行性       | `remote-device-onboarding`                       | UI 部署命令、真实进程启动、在线注册、能力上报、指定设备执行和文件产物 |
| Executor 生命周期             | `cloud-device-lifecycle`                         | 权威在线状态、离线、恢复、升级、稳定 Runtime identity 和重连断言      |
| Chat Issue 分配与执行         | `project-automation` + provider-native Chat E2E  | 提取共享 fixture，补齐 Ghost Skill/MCP 配置到项目分配完成的闭环       |
| ClaudeCode Skill/MCP 执行     | provider-native ClaudeCode E2E                   | 接入 Workspace/Project/Issue 分配，并保留真实 CLI 与文件产物断言      |
| Codex Skill/MCP/Plugin        | Wework plugin E2E + project automation           | 接入 ProjectChatAgent 分配，复用真实 Plugin 物化和多轮 tool-call 证据 |
| 人工分配与通知                | `project-assignment-notification`                | 扩展到通知深链、创建 Task、真实执行、产物和 Issue 终态                |
| Wework Task 与 Issue 状态同步 | `task-status-sync` + `collaboration-shared-core` | 复用任务绑定和状态投影断言                                            |
| Wework Claude Runtime 回归    | `claude-runtime`                                 | 作为真实本地/云端 Claude CLI 的独立回归，不替代项目分配场景           |

CI 要求：

- 所有新增场景必须进入 GitHub CI 已调用的套件或 checkpoint。
- 不允许只提供本地调试命令而没有 CI 注册。
- desktop 长流程必须通过共享 runner 暴露 checkpoint。
- classifier 必须把协作、分配、ProjectChatAgent、Plugin、Skill、MCP、Executor 和状态同步相关改动映射到对应分片。
- Workspace 执行环境授权、Project Agent 执行环境绑定和共享 Workspace API 映射相关改动，必须同时触发
  `collaboration-shared-core`、`remote-device-onboarding` 和 `cloud-device-lifecycle`。
- 默认零重试；间歇失败按缺陷处理，不靠 rerun 获得绿色结果。
- 截图、结构化日志、模型请求、MCP 调用和 Runtime 日志统一上传为 diagnostics artifact。

## Fixture 与复用原则

新增测试前先提取并复用以下能力，避免继续扩大单体场景：

```text
createWorkspace
createProject
createTeamBotGhost
createProjectChatAgent
registerRealExecutor
createIssue
assignIssue
waitForBackendTask
waitForRuntimeExecution
assertSkillLoaded
assertMcpRoundTrip
assertPluginLoaded
assertExecutionIdentity
assertExecutionTerminalState
assertArtifact
archiveProjectAndWorkspace
```

fixture 只负责建立前置条件；被验收的关键用户动作仍必须从对应产品 UI 发起。

各运行链可以复用执行证据断言接口，但 fixture 必须创建对应的真实资源：

- Wegent Chat/ClaudeCode/Codex Shell fixture 创建 Team、Bot 和 Ghost。
- Wework Codex 项目智能体 fixture 创建 ProjectChatAgent 和隔离 Codex Runtime。
- 统一层只表达“执行证据”，不抹平不同运行模型。

## 清理顺序

无论成功或失败，都执行幂等清理：

1. 取消仍在运行的 Task 和 runtime task。
2. 等待执行进入终态，避免后台进程继续写数据。
3. 停止本次运行启动的 Executor。
4. 删除隔离 Codex Home、Plugin 缓存和临时工作目录。
5. 删除或归档测试 Issue 及其交付物。
6. 枚举并归档 Workspace 内所有 active Project。
7. 归档 Workspace。
8. 删除测试 Team、Bot、Ghost、ProjectChatAgent、模型和 MCP 配置。
9. 停止 Electron、Backend、Redis、模型服务器和 MCP 测试服务器。
10. 保留失败日志与截图 artifact，但不提交到 Git。

Workspace 归档前必须先归档其中所有 active Project；历史已归档 Project 的授权关系不应阻止 Workspace 清理。

## 通过标准

完整协作执行 E2E 只有同时满足以下条件才通过。

### 资源

- Wegent 与 Wework 创建的 Workspace、Project 和 Issue 可以互相读取。
- Team、Bot、Ghost、ProjectChatAgent 和 Executor 关系符合各自真实模型。
- 页面刷新和应用重启后资源仍存在。

### Executor

- 至少一个真实 Executor 完成注册、能力上报、任务执行、离线和恢复。
- 运行日志能关联到具体 backend task 和 runtime task。

### Chat

- Chat Team 的 Ghost Skill 被加载。
- Chat Team 的 MCP 被实际调用。
- tool output 进入下一轮模型请求。
- Task、项目消息和 Issue 状态完成。
- 存在不可伪造副作用。

### ClaudeCode

- ClaudeCode Team 的 Ghost Skill 被加载。
- MCP 被真实 Claude Code CLI 调用。
- 真实 Executor 生成准确文件产物。
- Task、Runtime 和 Issue 状态完成。

### Wegent Codex Shell

- 执行对象是使用 Codex Shell 的 Team/Bot/Ghost，由标准 Executor 执行。
- Ghost Skill 被加载，MCP 被真实 Codex app-server 调用，输出进入下一轮请求。
- 真实 Executor 生成准确文件产物，Task、项目消息和 Issue 状态完成。
- 保存本链路的调度身份、运行日志和产物证据，不能用 Wework Runtime 的结果替代。

### Wework Codex 项目智能体

- 执行对象是 ProjectChatAgent/Wework Runtime。
- Skill、MCP 和 Plugin 均被真实 Codex Runtime 加载。
- Plugin MCP 被实际调用，输出进入下一轮请求。
- 真实产物包含三类独立探针。
- Task 和 Issue 状态完成。
- 保存本链路的独立运行证据，不能用 Wegent Codex Shell 的结果替代。

### 人

- Wework 收到目标用户的真实分配通知。
- 点击通知进入正确 Issue。
- 从 Issue 创建的私人 Task 保留完整协作上下文和原生 Issue 气泡。
- 真实本地 Runtime 具备 `wework_space` 工具并完成任务。
- Runtime 启动后 Issue 进入进行中；Task 终态不自动推进 Issue。
- Issue 评论、交付和后续状态只由用户手动操作或明确指令触发。

### 证据

- 每个场景有调度身份、权威终态、tool call/output 和不可伪造副作用。
- 核心流程截图链完整且通过人工 review。
- 所有截图和诊断文件只作为本地或 CI artifact 保存，不进入仓库。
- 所有场景由 GitHub CI 调用且零重试通过。

任一场景仅满足“配置存在”“页面可见”“模型说已完成”或“测试通过但没有真实副作用”，均视为未通过。

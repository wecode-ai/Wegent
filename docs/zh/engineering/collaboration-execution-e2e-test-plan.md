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
7. Issue 分配给人后，Wework 能收到通知，用户能从 Issue 创建任务，在真实运行时执行，提交产物，并推动 Issue 状态变化。
8. 执行失败、Executor 离线、页面刷新、进程重启和重复事件不会伪造成功或破坏最终一致性。
9. 每个关键步骤都有结构化断言、后端证据和截图证据。

## 已审计的运行模型

三类执行智能体目前不是同一个配置模型，E2E 不得通过测试夹具伪造一个不存在的统一抽象。

### Wegent Chat 与 ClaudeCode

Chat 和 ClaudeCode 使用 Wegent 的 CRD 资源链：

```text
Team
  -> Bot
    -> Ghost
      -> Skill references
      -> MCP servers
    -> Shell: Chat | ClaudeCode
    -> optional Model
```

- `Ghost` 保存提示词、Skill 引用和 MCP 配置。
- `Bot` 组合 Ghost、Shell 和可选模型。
- `Team` 组合一个或多个 Bot，并定义协作模式。
- Task 创建后，后端解析 Team、Bot、Ghost、Skill 和 MCP，构造实际执行请求。
- Chat Shell 进入 Chat Runtime。
- ClaudeCode Shell 通过 Executor Manager 调度到真实 Executor，并启动 Claude Code CLI。

### Codex

Codex 当前不属于 Wegent 的公共 Shell 类型，也不通过上述 Team → Bot → Ghost 链创建。

Codex 使用 Wework 的项目智能体与本地运行时链：

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
- E2E 必须分别验证 Wegent 智能体链和 Wework Codex 链，不得把 Codex 写成一个不存在的 Wegent `Codex` Shell。

### 人

人的分配链不直接启动 AI Runtime：

```text
Issue assignment
  -> Wework notification
    -> User opens Issue
      -> User creates Task
        -> Wework Runtime executes Task
          -> Artifact / delivery
            -> Issue status projection
```

分配给人首先产生通知和协作上下文。用户可以从通知进入 Issue，也可以在未被分配时主动进入 Issue 并创建任务。

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

- 实际调度对象是 ProjectChatAgent，而不是伪造的 Wegent `Codex` Shell。
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

目标：证明人的分配不是只创建负责人字段，而是形成通知、执行、产物和状态闭环。

步骤：

1. 分配者把 Human Issue 分配给目标用户。
2. 验证后端通知记录和收件箱记录创建。
3. 验证 Wework 出现系统通知和应用内未读标识。
4. 用户点击通知，深链进入正确 Workspace、Project 和 Issue。
5. 用户在 Issue 中点击“创建任务”。
6. 新任务自动保留 Workspace、Project 和 Issue 上下文。
7. 用户提交执行要求。
8. Wework 使用真实本地或云端 Runtime 执行任务。
9. 运行时生成 `human-result.txt` 或等价交付物。
10. 用户把产物同步到 Issue。
11. Task 完成。
12. Issue 状态进入等待确认或已完成。

必须验证：

- 通知接收人、分配事件和 Issue ID 正确。
- 重复分配事件不会产生重复通知。
- 点击通知进入正确 Issue，不只是打开协作首页。
- 新建 Task 绑定正确 Workspace、Project、Issue 和用户。
- 执行由真实 Runtime 完成。
- 产物真实存在，并能从 Issue 动态或交付物区域读取。
- Task 终态和 Issue 状态投影一致。

补充场景：

- 未分配给当前用户时，用户仍可主动进入 Issue 创建任务。
- 主动参与不得伪造“已分配给我”的通知或分配事件。

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

至少断言：

```text
Task status == COMPLETED
Runtime execution status == completed
Project message status == completed
Project message metadata.run_status == completed
Issue ai_state.status == completed
Issue status == in_review | completed
```

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
28. `28-human-artifact.png`：产物已生成并同步。
29. `29-human-issue-completed.png`：Task 和 Issue 最终状态。

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

## CI checkpoint 映射

优先扩展和复用现有 checkpoint，不复制已有部署、插件或运行时框架。

| 能力                          | 现有 checkpoint / 套件                           | 目标改造                                                              |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Wegent 协作资源创建           | Frontend collaboration Playwright                | 增加 Workspace、Project、Chat/Claude 资源创建和跨端持久化断言         |
| Wework 协作资源浏览与创建     | `collaboration-shared-core`                      | 覆盖 Wework 创建资源、跨端读取和共享协作主流程                        |
| Executor 注册                 | `remote-device-onboarding`                       | 复用部署命令、真实 Executor 启动、注册与能力上报                      |
| Executor 生命周期             | `cloud-device-lifecycle`                         | 复用离线、恢复、升级和重连断言                                        |
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

Chat、ClaudeCode 和 Codex 可以复用执行证据断言接口，但不得共享一个虚假的资源创建接口：

- Chat/ClaudeCode fixture 创建 Team、Bot 和 Ghost。
- Codex fixture 创建 ProjectChatAgent 和隔离 Codex Runtime。
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

### Codex

- 执行对象是 ProjectChatAgent/Wework Runtime。
- Skill、MCP 和 Plugin 均被真实 Codex Runtime 加载。
- Plugin MCP 被实际调用，输出进入下一轮请求。
- 真实产物包含三类独立探针。
- Task 和 Issue 状态完成。

### 人

- Wework 收到目标用户的真实分配通知。
- 点击通知进入正确 Issue。
- 从 Issue 创建的 Task 保留完整协作上下文。
- 真实 Runtime 完成任务并生成产物。
- 产物同步到 Issue，Task 与 Issue 状态一致。

### 证据

- 每个场景有调度身份、权威终态、tool call/output 和不可伪造副作用。
- 核心流程截图链完整且通过人工 review。
- 所有截图和诊断文件只作为本地或 CI artifact 保存，不进入仓库。
- 所有场景由 GitHub CI 调用且零重试通过。

任一场景仅满足“配置存在”“页面可见”“模型说已完成”或“测试通过但没有真实副作用”，均视为未通过。

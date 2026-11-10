---
sidebar_position: 61
---

# Wework DSH 连接扩展点

连接是 Wework Core DSH 插件的一种能力。Codex 插件协议保持不变；Wework 连接插件可以依赖已有 Codex 插件，也可以自行访问外部系统。采集、分页和格式转换由代码执行，模型只参与角色内的工作整理和处理。

连接是 DSH 扩展点。`@wegent/dsh-connection-host` 提供 `ctx.weworkConnections` 服务，拥有统一注册表、认证的宿主 RPC 和生命周期；各系统通过独立 DSH 插件声明 `wework.connections`，并调用 `ctx.weworkConnections.register(ctx, manifestUrl, providers)`。邮箱插件保留原包名 `@wegent/dsh-connection-runtime`，其已保存的来源 ID、账号设置和安全存储归属不变。停用某个连接插件只撤销该插件的能力，不停用连接宿主或其他连接。

新系统接入同一协议，不增加分身专用轮询器：

- 插件声明 `apiVersion`、资源类型、事件类型和依赖来源，实现 `check`、`listResources`、`validate`、`initialize`、`collect`。`initialize` 建立用户选定范围的接收边界；后续 `collect` 返回稳定事件 ID、事件时间、正文、检查点和分页状态。连接成功本身不是新业务事件，不重放边界之前的历史。
- 框架在实际收到新事件后持久化、去重并按来源策略唤醒统一协调流程；默认只读研判、重要事实提醒和待决策交互不要求用户先在会话中发送指令。来源正文只作为不可信证据，不授予执行权限。具体的归集时机、职责和授权仍以保存的策略为准。
- 可选 `readSource` 提供有界的只读补充信息，不推进收集检查点。未实现的插件明确返回不支持，不把目录就绪或订阅存在当成已经读取内容。
- 可选 `actions` 声明资源支持的操作，`executeAction` 在原插件中实现。宿主只路由已声明且属于该插件具体资源的操作；清单不是授权。实际执行仍须通过原生单次确认或当前持续授权，插件继续验证收件人、幂等及外部操作结果，未知发送结果不得自动重试。

目前提供外部事件采集的内置连接是邮箱、钉钉、GitHub 和 GitLab，均使用同一注册和采集协议。内部日历安排不等同于外部日历事件连接；尚未实现并注册的系统不宣称具备新事件监听能力。

## 声明和注册

在外层 `package.json` 的 `wework.connections` 中声明协议版本、依赖和 Provider。不要往 `.codex-plugin/plugin.json` 添加 Wework 字段。已有的 `wework.codexPlugin` 仍用于声明内嵌 Codex 插件；连接依赖引用其实际安装后的市场身份。

```json
{
  "name": "@example/wework-mail",
  "wework": {
    "connections": {
      "apiVersion": 1,
      "dependencies": {
        "mail": {
          "kind": "codexPlugin",
          "source": {
            "marketplaceId": "company",
            "pluginId": "mail@company"
          },
          "version": "^1.0.0"
        }
      },
      "providers": [
        {
          "id": "inbox",
          "displayName": "邮箱",
          "uses": ["mail"],
          "collectionModes": ["poll"],
          "resourceKinds": ["folder"],
          "resourceLabels": { "folder": "邮件文件夹" },
          "eventTypes": ["mail.received"],
          "versionedEventTypes": []
        }
      ]
    }
  }
}
```

外层 DSH 插件注入 `weworkConnections`，在 Node 入口中注册实现：

```js
export const inject = ["weworkConnections"];

export async function apply(ctx) {
  await ctx.weworkConnections.register(
    ctx,
    new URL("./package.json", import.meta.url),
    { inbox: mailProvider },
  );
}
```

清单是能力目录；实现随 Cordis owner 生命周期注册和注销。目录也读取已安装但停用的插件清单，只显示状态，不执行这些插件。Provider 的完整身份是 `包名/Provider ID`。注册校验失败、身份重复或协议版本不支持时明确报错。第一版只支持轮询，不加载清单指定的任意执行命令。

## 连接的领域指导

Provider 可声明结构化的 `assistance`，帮助模型理解这个系统接入以后应为用户做什么。四个字段均为 1–8 条非空文本，每条最多 1000 字符：

- `observe`：关注哪些新事件或对象变化。
- `prepare`：在已授权的只读范围内，先读取哪些上下文、准备什么结果。
- `notifyWhen`：什么事实、风险或待决策事项值得提醒；普通或未变化的信息应保持安静。
- `confirmBefore`：哪些领域动作应检查单次确认或当前持续授权。它只是领域提示，不能替代完整的宿主权限规则。

内置邮箱、钉钉、GitHub 和 GitLab 均提供该指导。纯采集插件可以不声明；框架不会为其编造领域能力。字段不支持任意 system prompt、工具授权或执行命令。

DSH 宿主只发布当前已注册插件的指导。Executor 每回合重新读取，在手动分身会话中装配该角色当前保存的连接（暂停自动处理不会撤销领域知识）；委托工作只获得去除账号和来源身份的领域提示，不获得新的读取权限；在后台统筹和来源工作中，只装配当前批次或工作所涉及、且仍属于当前角色和账号的来源。插件停用或连接撤销后，后续回合会移除对应指导；暂停自动处理仅从后台移除指导，不撤销手动会话的领域提示。指导正文放在标记为不可信的上下文块中，宿主另行提供其使用边界；用户草稿不附加这些规则。

连接建立只使领域指导可用，不产生业务提醒。收到后续新邮件、@消息、PR 变化或流水线失败时，既有事件协议触发研判。准备只读结论、交付有用的新发现，与对外发送或持续代办是不同权限路径；插件指导始终不能扩大已有授权。

## 能力声明与只读分页

连接协议描述资源和能力，不描述某个示例任务。能采集事件不代表能任意读取资源，能读取不代表能执行外部操作。插件只声明其实际实现的能力；新增系统通过相同注册表接入，不向框架添加系统名称或 CLI 参数分支。

提供只读能力的 Provider 声明 `read: { inputSchema, itemSchema, pagination }`，同时实现 `readSource(context, { source, query, cursor })`。`pagination` 为 `cursor` 或 `none`；删除独立的 `readPagination` 声明，避免目录与实现使用两份分页配置。`query` 是插件定义的 JSON 对象：消息插件可以定义时间窗口，仓库插件可以定义路径和版本，指标插件可以定义指标名称。框架不规定所有查询必须有时间，也不规定七天、二十条或邮件字段。

`inputSchema`、`itemSchema` 以及 action 的输入与结果 schema 使用 JSON Schema 2020-12。标准校验器不转换输入类型、不应用 schema 默认值，也不加载远程 `$ref`；插件实现自己的业务默认值。`items` 中每项仅额外要求稳定、非空的字符串 `id`，其他字段由 `itemSchema` 定义，静态资源无需伪造 `at` 或 `text`。校验失败明确报错，不能静默删除字段或截断返回页。

例如，一个非消息连接可声明 `query: { metric: "build.duration" }`，返回 `{ id: "build-42", value: 18.5, unit: "s" }`。它与邮箱、日历或代码仓库共用权限、校验和生命周期，不需要新增宿主分支。

首次读取使用 `source` 与可选 `query`；续页使用相同来源和不透明的 `cursor`，不必重复查询参数。框架只保留通用资源预算：输入 1 MiB、结果 8 MiB、最多 1000 个数据项、游标 8192 个 UTF-8 字节。原生模型入口另限制查询对象为 64 KiB。各插件可在 schema 中声明更小的业务限制。每页重新验证用户、设备、角色、工作及当前精确来源；来源工作只能读取宿主已绑定的来源，不能借同角色的其他连接扩展权限。

`hasMore: true` 必须伴随可推进的 `nextCursor`。插件绑定账号、来源和首次查询快照；如果底层 SDK 已提供游标，直接保留其权威字段，不重造分页算法。显式改变快照、篡改或跨来源重放必须拒绝。游标可短期有效，插件重启后可要求重新开始读取。不支持读取或分页的 Provider 会在目录中如实表达，并明确拒绝不支持的调用。

只读游标、采集 `checkpoint` 和操作回执是三类独立状态。读取不能推进采集边界、改变处理状态或产生 intake 事件。模型应补齐作出当前判断所必需的上下文；任务成果应是查清的事实或实际操作结果，不能用任务已创建、尚未完成的读取或实现限制代替交付。

执行工具返回仍在运行的 session 时，无 stdout 或单次 `yield_time_ms` 结束不表示操作失败或总期限已到。分身应在操作和当前任务的有限执行预算内，对同一个已授权 session 继续空输入轮询，期间报告进度并处理独立工作，不能仅因数次空轮询或沟通间隔而终止。实际期限、失败、用户取消或原生拒绝仍按其真实语义停止；主动取消必须与来源失败区分，不能无限等待，也不能借等待或恢复扩大授权。

用户看到的完成反馈应简短说明业务结果，仅补充会影响下一步的实际失败、信息缺口、决策和不确定性。技术回执保留在执行记录中，除非用户索取或排查实际问题，否则不例行展示回执 ID、工具状态、“暂无阻塞”或渠道正常缺少送达、已读确认。完成措辞必须符合现有证据，提交、接受和发送不能表述为已送达或已读；操作本身结果确实未知时仍须说明，且不能重复执行。

GitHub 和 GitLab 仓库来源实现同一读取接口，查询指定 `entityKind`（`issue` 或 `change_request`）、`number` 和 `view`。两者均提供详情与评论；变更请求另提供检查、提交状态与评审视图。GitHub 的检查与旧式提交状态分开读取；GitLab 的评审视图返回审批状态对象，不能将任一视图单独视为完整合并条件。检查和状态查询可指定提交 SHA；首次解析的提交固定到后续分页，新查询才重新解析最新提交。每页先校验仓库身份，权限错误原样返回；只读操作不创建仓库订阅。

主分身创建只读委托时，可通过 `create_task.readSources` 显式选择当前已连接的具体来源；省略时不继承任何来源。宿主保存不可扩大的读取快照，`continue_task` 保留并重新验证该快照，不加入后来新增的连接。只读工作仅获得所选来源的目录和读取能力；每页重新检查父子任务的用户、设备、主身份和当前连接。通配来源、其他身份的连接及已撤销的来源均拒绝，不能借委托获得配置或外部操作能力。

## Provider 接口

| 方法                            | 输入与结果                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `check(context)`                | 返回 `{ status: 'ready' }`、`auth_required` 或 `error`，只检查状态，不主动登录。                                    |
| `listResources(context, query)` | 接收 `kind`、`query`、可选 `cursor`；返回 `items`、`hasMore`、`nextCursor`。                                        |
| `validate(context, source)`     | 验证资源类型、身份和账号访问条件。失败不能继续采集。                                                                |
| `initialize(context, source)`   | 为新订阅建立检查点，避免首次接入重放全部历史。                                                                      |
| `collect(context, input)`       | 接收 `source`、`checkpoint`，返回 `events`、`nextCheckpoint`、`hasMore`。                                           |
| `readSource(context, input)`    | 按已声明的 `read` 接收 `source`、`query`、`cursor`，返回 `items`、`hasMore` 和可选 `nextCursor`，不修改采集检查点。 |
| `executeAction(context, input)` | 可选；只执行清单声明、且已由宿主按原生权限路径授权的具体资源操作。                                                  |

资源包含 `providerId`、`id`、`profile`、`kind`、`name`。用户保存后，Executor 增加处理策略和服务端生成的 `enabledAfter`。检查点为 JSON 对象，由插件解释；宿主在外层保存版本、错误和来源，不能把这些元数据混入插件检查点。

需要实例地址等公开发现参数时，Provider 声明可选 `resourceQuerySchema`（对象型 JSON Schema）；`listResources.query` 此时编码为 JSON 对象字符串。目录保留该声明。`connect_source` 在缺少必填字段或无法解析对象时返回 `setup_required`、`querySchema` 和 `missingFields`，由 AI 使用结构化问题补齐；不猜测企业实例，不提前调用业务 CLI，也不索取凭据。这个预检只检查对象和必填字段，参数值仍由 Provider 验证；未声明该字段的插件保留原来的文本搜索语义。

`ConnectionResource` 可携带插件定义的公开 opaque 配置。可选 `collectionKey` 必须是去除首尾空白后非空且 UTF-8 不超过 256 字节的字符串；可选 `configurationSummary` 是非空普通文本，UTF-8 不超过 4096 字节（Git 自身限制为 2048）。插件解释和验证配置，并生成稳定 key 与可审查说明；框架只把 key 用于跨角色采集合并、持久 checkpoint 与入站路由分区，把说明用于提案前后差异展示。同 key 可以共享采集，不同 key 各自保存进度，各角色事件仍独立去重。这些字段绝不改变 `readSource`、写操作或原生审批的资源权限；未携带字段时保留原来的订阅 key 与语义。原生设置保存不会解释插件私有字段，模型应复制发现返回的资源，插件在实际验证和采集前拒绝不一致的配置。

资源发现也可返回 `availability`。仅在实际业务操作明确报告认证缺失时返回 `auth_required`，并携带原生授权服务给出的精确 `authTarget`；动态实例目标保留公开的 `instance`。`connect_source` 使用同一授权状态处理该结果，不能从网络错误、403 或空列表推断登录失效。GitHub 的目标来自其插件声明；GitLab 的目标由插件根据已选择实例请求原生授权服务取得，不猜测或自行拼装连接器标识。

事件至少包含稳定的 `id`、`text` 和 `at`。`eventType` 应与清单声明一致，可携带 `senderId`、`senderName`、`quotedMessageId`、`topicId` 等业务字段。时间应使用 RFC 3339；钉钉迁移保留对原时间格式的解释。

插件实现必须处理分页边界、重复数据和失效检查点，不得在错误时推进游标。实现可以使用闭包捕获自己声明的 DSH 服务；上下文包含已解析依赖和生命周期 `signal`。停用插件后，在途采集结果会被拒绝。

每项操作声明 `id`、`resourceKinds`、`inputSchema` 和 `resultSchema`，并实现 `executeAction(context, { action, source, ...input })`。框架校验除宿主持有的 `action`、`source` 外的输入，以及插件实际返回的结果。只允许该 Provider 已声明的动作和资源类型，不允许使用 `scope: "all"` 或通配资源作为操作目标。动作清单不会自动向模型暴露写入工具，也不能代替原生授权；宿主已授权的具体工具才可通过统一 RPC 调用。插件必须在实际投递前继续验证其业务边界，不能根据事件正文或调用者伪造的策略自行授权。现有发送、合并、工作区及未知投递保护继续生效，不能用 schema 校验替代这些安全守卫。

## 事件身份、版本和处理进度

所有连接都必须显式声明 `versionedEventTypes`（不可变事件使用空数组），并遵守同一契约，不能用模型记忆、已读标记或上次查询时间代替持久化处理记录：

- `id` 是来源内稳定的事件标识；重复分页、重新拉取或重启不能为同一个事件生成随机新 ID。
- 不可变消息（当前邮箱的 `mail.received`、钉钉收到的消息）按来源及事件 ID 去重。邮件使用 `UIDVALIDITY:UID`，账号和邮箱由来源身份隔离；钉钉使用平台消息 ID，群或联系人由来源身份隔离。
- 可更新对象必须提供非空的 `objectId` 和 `version`，且在 Provider 的 `versionedEventTypes` 中声明对应事件类型。两字段必须成对出现；声明为版本化的事件缺少字段时拒绝整页，不推进游标。`objectId` 在该 Provider 的账号内唯一，包含必要的实例、仓库、对象类型和对象标识，不能只使用仓库内编号。`version` 是不透明的语义版本标识，可以是平台版本或规范化业务状态摘要；同一状态重复返回必须保持不变，新的业务变化必须产生新版本。时间戳、请求次数和 webhook 投递编号不能单独代表对象版本。
- 版本化事件按用户、Provider、账号、分身、`objectId`、`version` 去重；个人范围和仓库范围重复观察同一对象版本时，只创建一个处理事件，同时保留各订阅的独立授权边界。同一个 PR 后续出现新的检查失败必须产生新版本，不能因为 PR 已经处理过而忽略。不同账号、用户或分身不能共享处理或授权记录。
- `checkpoint` 是插件解释的采集位置，`nextCheckpoint` 只表示这一页已获取到哪里，不表示 AI 已经完成处理。插件不得自行保存框架的采集进度、待确认或完成状态；`readSource` 也不能移动采集游标。

框架先持久化该页事件，再保存下一检查点。进程中断可重复获取该页，通过持久化身份去重；采集或持久化失败保留原游标。已获取的事件由内部队列继续研判和重试，不依赖外部接口再次返回它。等待人工确认的事项继续使用原事项；已完成、忽略或取消的相同事件版本不会因重复拉取重新启动。外部操作的单次确认、持续授权、幂等发送记录和未知投递结果处理仍由原生权限与执行流程负责，事件去重不代替操作授权。

只读采集遇到已确认的临时网络故障、超时或限流时，插件可在错误中提供 `retryAfterMs`（1 至 3,600,000 毫秒），表示允许框架在该等待期后重试。宿主只在 `collect` 错误中传递这个提示；框架统一保存失败次数、原游标和退避时间，不识别插件专属错误码。认证、证书、非法数据和配置错误不携带提示，暂停等待用户恢复；网络错误不转成登录请求。未知发送结果和任何写操作都不能通过这个采集提示自动重试。

对于宿主声明的 CLI 读取，进程非零退出且没有结构化终态属于 `connection_cli_failed`，采集边界使用上述有界退避重试，保留原游标；不能把空 stdout 当作成功读取后的 JSON 协议损坏。框架分别、有界地读取 stdout 和 stderr，识别结构化错误，诊断只保存结构信息和受限错误码。结构化拒绝、原生登录要求以及成功退出后的坏 JSON 不获得这个重试提示；写操作不会自动重放。连接错误旁的重试操作只解除仍连接来源的错误锁定，保留进度并由下一次正常采集继续，不修改配置版本。

CLI 边界将通用 `request_failed` 和明确列举的传输错误归为 `connection_cli_request_unavailable`，通过 `providerCode` 保留受限原始错误码，经本地 RPC、连接宿主和采集状态传递；只有声明的读取获得重试提示。明确权限、证书、校验拒绝及未识别的错误仍归为不可自动重试的请求失败。采集首次失败等待 30 秒，重复失败指数退避，最长一小时。升级后，仅旧版完整通用错误封装 `connection_cli_request_failed` / `Plugin tool request failed (request_failed)` 可以从原检查点自动恢复；其他旧拒绝不通过消息模糊匹配恢复。首次上游失败的细节无法由这个旧封装还原。该恢复不改变连接配置、不重置历史，也不重放外部写入。

GitHub 和 GitLab 插件在个人事件、仓库跟踪及收件箱采集路径上均提供对象和版本；邮箱和钉钉的新消息路径保留不可变事件语义。后续接入可编辑消息或外部日历等可更新对象时，同样必须声明版本化事件并实现对象版本，不在框架增加系统专属判断。

## Codex 依赖管理

身份同时匹配市场名和完整插件 ID，不通过显示名称猜测，不在其他市场中寻找同名替代。优先读取当前设备的 `plugin/installed`；明确安装时才读取完整目录，并调用现有 `plugin/install`。

依赖状态包括 `ready`、`missing`、`disabled`、`incompatible`。`*` 表示接受任何已安装版本，包括没有版本元数据的插件；其他范围必须有可验证版本。采集前仍需校验 Provider 的实际能力。

连接界面的“安装所需插件”是显式操作。不会隐式启用、升级或卸载共享依赖。来源不在目录、版本冲突或管理员禁止安装时明确失败。活动连接的依赖引用会报告给 Executor；常规 Codex 卸载和本地个人插件卸载入口拒绝删除仍被活动连接使用的依赖。先停用对应 Wework 连接插件再卸载，宿主引用在心跳周期内更新。

安装 Wework 插件与登录业务账号是不同操作。`authTarget` 可引用已有 `pluginKey`、`connectorSlug`，前端复用既有授权对话框；配置中不存凭据。

## 直接复用 Codex 插件能力

连接上下文提供 `context.mcp.listTools(dependencyAlias)` 和 `context.mcp.callTool(dependencyAlias, { server, tool, arguments })`。依赖别名必须属于当前 Provider 的 `uses`。SDK 会将依赖别名连同精确插件身份传给 Executor，宿主按 Provider、别名和来源同时选择读取声明；同一插件的多个别名不会串用权限。工具名称使用 MCP 原始名称；不会让模型搜索、选择或重新配置工具。

```js
const result = await context.mcp.callTool("mail", {
  server: "mail",
  tool: "search_messages",
  arguments: { folder: source.id, after: checkpoint.after },
});
// Interpret the existing plugin's result contract before advancing the checkpoint.
if (result.isError) throw new Error("Mail collection failed");
```

上述服务器、工具和参数是示例，适配插件必须使用所依赖插件实际公开的接口。原 Codex 插件不需要修改清单、增加接口或再实现一次认证。连接适配仍由确定性代码负责参数映射、分页和事件转换；仅有 Skill、没有 MCP 工具的插件不会自动变成可调用工具。

调用路径为 Wework Provider → SDK → `runtime.connections.mcp` → Codex app-server → 原 MCP 服务。宿主读取 `plugin/installed` 和 `plugin/read`，校验完整市场身份、启用状态及解析版本；工具调用前再次检查依赖。每个操作使用独立的 `ephemeral` 技术线程，复用当前设备受管 Codex Home 的插件和认证，使用只读沙箱及 `approvalPolicy: never`，只调用 `mcpServerStatus/list` 和 `mcpServer/tool/call`，绝不调用 `turn/start`，没有模型推理或模型 Token 消耗。技术线程不创建用户 Task，也不加载项目文档。

工具归属由 Codex 返回的 `pluginId` 判断；共享 `codex_apps` 服务则同时验证 `plugin/read.apps[].id` 与工具 `_meta.connector_id`。名称相同不能替代归属证明。后台默认只开放 `readOnlyHint: true` 且未标记破坏性的工具。旧工具缺少只读标注时，Wework 适配插件可补充读取契约，无须修改原插件：

```json
{
  "mcpReadTools": {
    "mail": [{ "server": "mail", "tool": "search_messages" }]
  }
}
```

此字段放在 Provider 描述符中。它是适配插件对精确工具身份的读取声明，不是用户或 AI 的配置；不能覆盖工具显式声明的 `readOnlyHint: false` 或 `destructiveHint: true`。Executor 从活动宿主的依赖引用读取清单，忽略调用参数中伪造的 `readTools`。未声明依赖、其他插件工具、重复身份及未知操作均拒绝。

工具结果中的 `content`、`structuredContent`、`isError`、`_meta` 原样返回；`isError` 不会变成成功采集。原插件返回的结构化登录错误由适配插件按原身份解释，不能猜测账号或转换为其他连接的登录请求。原生 MCP 授权交互在后台取消并返回 `connection_interaction_required`，需要用户在插件原有交互入口完成授权；它不会被转换为本地 Connector 登录。网络失败不被视为登录失效。

线程创建后，目录发现与工具调用合计最多等待 45 秒，成功、失败和超时均取消线程订阅，由 Codex 卸载空闲线程。IPC 调用方取消不会丢弃清理工作。Provider 停用后拒绝后续调用和在途结果。桥接不自动重放未知结果，不启动交互登录，不修改共享插件配置，不导出凭据；调度器保留检查点和来源错误，用户重试或修改设置后再恢复采集。钉钉通过下述通用 CLI 传输复用插件声明的 DWS 工具，不经过 MCP 技术线程。

### 没有 MCP 服务的 CLI 插件

现有钉钉插件只有 Skill 和 `connectors[].localAuth.tool`，没有 MCP 工具。通用桥因此同时提供 `context.cli.callTool(dependencyAlias, { tool, arguments })`。MCP 和 CLI 共用依赖身份、版本校验及生命周期边界，不通过模型执行命令，也不把 CLI 伪装成原插件不存在的 MCP 工具。

Provider 的 `cliReadTools` 按依赖别名声明 Connector、固定命令前缀、允许的参数及固定 JSON 输出参数，例如：

```json
{
  "cliReadTools": {
    "dingtalk": {
      "connectorSlug": "dingtalk",
      "outputArgs": ["--format", "json"],
      "operations": {
        "listProfiles": { "command": ["profile", "list"], "parameters": {} },
        "searchGroups": {
          "command": ["chat", "search"],
          "parameters": {
            "query": "--query",
            "profile": "--profile",
            "cursor": "--cursor"
          }
        }
      }
    }
  }
}
```

适配实现调用 `context.cli.callTool('dingtalk', { tool: 'searchGroups', arguments: { query, profile } })`。这些是 Wework 插件作者的确定性读取契约，无需修改原 Codex 插件。宿主依据活动 Provider 清单构造参数，忽略调用者伪造的命令、工具路径或读取声明。未知操作、额外参数、前导短横线或 NUL 参数值均拒绝。读取声明不用于执行写入命令；回复继续经过既有来源绑定和确认路径。

Executor 用共享依赖解析器定位精确已安装版本，拒绝跨市场替代和目录穿越，只执行原 `localAuth.tool` 解析出的受管二进制，不启动 Shell，不执行 Skill 文本，不在后台下载工具。原 Connector 登录与账号环境由现有授权服务管理。CLI 进程最多运行 40 秒，标准输出最多 8 MiB；超限时无需等待进程结束便会终止该次调用并清理子进程。失败不推进检查点；解析错误和非登录错误不触发登录。只有明确的登录错误码才返回原插件身份的 `connector_auth_required`。

具体读取操作以插件自己的 `cliReadTools` 声明为准，框架不维护第二份业务功能白名单。静态 argv 只受长度、非空和无 NUL 等结构约束，框架不解释特定工具的快捷命令或 flag 语法。连接依赖、固定操作与参数映射仍逐次验证。应用已删除 `runtime.connections.command`、`context.readCommand`、钉钉专用读取参数白名单和缓存路径解析器，没有保留回退入口。

## 运行与分发

Executor 保留唯一的后台采集调度。它通过仅监听回环地址、具有独立随机 Bearer Token 的 DSH 路由调用连接 Provider。端点登记只接受固定路径的回环 HTTP 地址，禁止重定向，登记具有心跳有效期。Token 仅保存在进程内，不写入分身设置。

第一版采集由绑定设备上的 Wework 连接运行时提供；设备上未运行该服务时显示不可用并保留进度，不改用旧钉钉采集器或偷偷转移设备。

同一用户、Provider、账号和资源只采集一次，每条事件分发给所有已连接且满足启用时间的角色。角色各自去重、串联引用消息并整理工作，不通过模型选择接收角色。采集完成后再次检查设置版本；变更期间返回的结果不继续接单。每条事件先持久化，再保存整页检查点，因此中途失败会重新获取并去重，不跳过未处理事件。外部调用与数据库不构成分布式 exactly-once 事务。

工作整理、执行队列和确认机制沿用现有分身实现。新的工作使用 `connection_work` origin；历史 `dingtalk_work` 仍受相同的外部来源内容约束和确认机制保护。来源插件不能绕过确认、修改项目权限或替用户授权。

宿主尚未注册或重启期间不可用时，保留原检查点并在下一轮轮询恢复，不锁定为来源错误。其他采集失败保留检查点并在来源错误中展示；用户点击重试或修改设置后恢复采集，不会自动弹出登录流程。跨系统语义相似的内容不自动视为同一事件。通用来源的去重和记忆范围包含 Provider 身份，避免同名账号和资源串用。

## 钉钉迁移

`@wegent/dsh-connection-dingtalk` 提供群聊 @我、联系人消息两个资源类型。搜索、时间窗口、分页、消息过滤和自发消息判定已移入该插件。Executor 保留原受管 DWS 凭据和回复通道，不复制登录数据。

旧个人配置的 `dingtalk[]` 在读取事务中迁移到 `connections[]`，增加钉钉 Provider ID，保留版本、处理策略和启用时间。保存请求和配置提案也经过同一规范化过程。两种字段同时出现时拒绝保存，避免静默覆盖。

历史来源、消息和工作不重新生成 ID。钉钉继续使用原去重命名空间，原 `after/until/cursor` 在首次采集时转为通用检查点。原回复仍校验工作、角色、来源消息及最新确认策略；其他 Provider 不能调用钉钉回复。

内置清单声明 `dingtalk@wework` 和允许的替代来源 `dingtalk@wegent`，按声明顺序复用实际安装。未声明市场中的副本不自动视为等价依赖；旧配置和历史仍保留。Webhook、无桌面服务的云端插件宿主和跨设备自动接管不属于本次实现。

## 验证

### 通用邮箱

内置邮箱来源为 `@wegent/dsh-connection-runtime/email`，支持使用密码或应用授权码的 IMAP/SMTP 账号。用户在分身的「连接 → 邮箱」中填写服务器、端口和 TLS 或 STARTTLS 配置；验证收信和发信登录成功后添加连接，再保存分身设置开始接收。仅使用加密连接并校验证书。账号凭据通过 `weworkSecureStorage` 加密保存在执行设备，不进入分身配置、模型上下文或连接目录；远程设备上的账号需在对应设备配置。

更新登录信息保留账号 ID 和现有角色订阅。删除账号需确认其对所有引用角色的影响；删除完成后拒绝后续收发，已经开始的发送操作先结算。移除角色连接仅解除该角色订阅，不删除共享账号。邮箱连接默认逐次确认发送；只有用户在原生界面明确授予持续回复权限后，才可按当前来源授权回复原发件人。新收件人仍需逐次确认，撤销授权或停用角色后拒绝自动发送。

邮箱的启用边界使用服务器位置，而非邮件头日期或客户端时间。普通保存、接受配置提案和项目复用角色的保存流程，都会在用户配置锁内、SQLite 事务外读取 `UIDVALIDITY` 与 `UIDNEXT - 1`。该快照是启用的线性化点；成功保存时将 `{ partition, sequence }` 边界与角色配置一同持久化。客户端提交的边界不能覆盖已有可信边界。新增角色保留其他角色的起点和共享采集检查点；角色重新启用时取得新快照。初始化失败则保存失败。

采集事件携带服务器位置；接收与执行阶段共用资格判定，只有同一 partition 中大于该角色起点的事件可处理。因此同一秒内到达的邮件也能正确区分，首次轮询前收到的新信不会丢失。每页最多处理 20 封邮件，正文读取有上限，超限内容明确标记截断。收信不标记已读、不下载附件。UIDVALIDITY 改变会明确报错；移除连接并保存，再重新添加并保存，可建立新起点。

已识别的 IMAP 网络中断保留采集检查点、显示自动重试提示，并在后续轮询恢复收信，无需再次保存配置。登录、证书或邮件解析错误仍暂停该来源，避免无限重复无效请求；其他来源不受影响。

分身通过来源绑定的 `wework_stand_in.send_email` 发送或回复。原工作对话中的原生审批展示发件人、收件人、主题和完整正文；取消不会调用 SMTP 投递。回复校验原邮件 UID 和 Reply-To/From，并保留线程头。发送使用持久化的写前记录防止重复：明确未进入投递阶段的失败可在修复后重新审批，未知或部分投递结果禁止盲目重试。

邮件预览读取同一条原生审批中的工具身份、精确参数及待处理状态。内置工具顶层 `title` 固定为 `Wework: Send email`；仅在服务名、工具标题和审批类型均匹配时展示邮件确认，不从会异步整理的工具展示状态推断审批身份。

邮箱协议库随选定 Harness runtime 提供。Core 插件从该运行时的 `package.json` 解析依赖，避免已复制到用户配置目录的插件错误地从配置目录查找模块。新增邮箱用户故事由共享 `stand-in-email` 桌面 checkpoint 覆盖，使用独立的真实 GreenMail IMAP/SMTP 服务和临时受信证书，只模拟模型服务；该验证不代表已验证所有外部邮箱服务商的实际兼容性。

邮件测试服务器固定为 GreenMail 2.1.15，本地运行需使用 Java 11 或更高版本（CI 使用 Java 21）。旧版 1.6.15 以 12 小时制解析 IMAP APPEND 日期，会将中午 `12:30` 存为凌晨 `00:30`；测试继续严格校验写入与读回的收件时间，不放宽时间断言。

协议和依赖测试位于 `wework/dsh/plugin-runtime/connections.test.mjs`；钉钉采集契约测试位于 `wework/dsh/connection-dingtalk/provider.test.mjs`；回环鉴权测试位于 `wework/dsh/connection-host/rpc.test.mjs`。这些测试由现有 Wework 测试发现器执行。

Executor 的 `stand_in_identity_contract` 覆盖历史配置、游标和去重迁移，以及不同 Provider 的命名空间隔离。分身确认和来源权限测试继续保留。桌面新增回归接入共享 checkpoint runner；按仓库政策，仅在明确要求时运行 E2E 和真实桌面验证。

后台桥接验证包含 SDK 依赖隔离、旧工具读取声明、Executor 目录分页和工具归属、调用前依赖重验证、超时/失败清理，以及取消调用方后的清理；相关测试为 `connection-host/mcp.test.mjs`、`runtime_work/connection_mcp_tests.rs` 和 `agents/codex/connection_mcp.rs`。新增 `stand-in-mcp` 桌面 checkpoint 验证真实宿主/Executor 拒绝跨依赖调用，并检查连接目录可继续使用。

通用 CLI 测试还覆盖命令与参数边界、精确版本路径、原始登录身份、网络错误、群聊/私聊过滤及失败时不推进游标。`stand-in-cli` 桌面 checkpoint 验证真实目录中的钉钉读取声明、拒绝写入/注入及专用旧入口确已删除；已注册共享 CI，按仓库政策仅在明确要求时执行。

`stand-in-plugin-bridge` checkpoint 使用真实本地 Codex 插件与 MCP 服务验证依赖安装、工具发现和读取、写入拒绝、活动依赖卸载保护及停用后卸载，并断言没有模型请求。原 Codex 插件无需增加 Wework 接口。

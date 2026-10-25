---
sidebar_position: 61
---

# Wework 分身连接插件

连接是 Wework Core DSH 插件的一种能力。Codex 插件协议保持不变；Wework 连接插件可以依赖已有 Codex 插件，也可以自行访问外部系统。采集、分页和格式转换由代码执行，模型只参与工作理解、归属和处理。

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
          "eventTypes": ["mail.received"]
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

## Provider 接口

| 方法                            | 输入与结果                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `check(context)`                | 返回 `{ status: 'ready' }`、`auth_required` 或 `error`，只检查状态，不主动登录。 |
| `listResources(context, query)` | 接收 `kind`、`query`、可选 `cursor`；返回 `items`、`hasMore`、`nextCursor`。     |
| `validate(context, source)`     | 验证资源类型、身份和账号访问条件。失败不能继续采集。                             |
| `initialize(context, source)`   | 为新订阅建立检查点，避免首次接入重放全部历史。                                   |
| `collect(context, input)`       | 接收 `source`、`checkpoint`，返回 `events`、`nextCheckpoint`、`hasMore`。        |

资源包含 `providerId`、`id`、`profile`、`kind`、`name`。用户保存后，Executor 增加处理策略和服务端生成的 `enabledAfter`。检查点为 JSON 对象，由插件解释；宿主在外层保存版本、错误和来源，不能把这些元数据混入插件检查点。

事件至少包含稳定的 `id`、`text` 和 `at`。`eventType` 应与清单声明一致，可携带 `senderId`、`senderName`、`quotedMessageId`、`topicId` 等业务字段。时间应使用 RFC 3339；钉钉迁移保留对原时间格式的解释。

插件实现必须处理分页边界、重复数据和失效检查点，不得在错误时推进游标。实现可以使用闭包捕获自己声明的 DSH 服务；上下文包含已解析依赖和生命周期 `signal`。停用插件后，在途采集结果会被拒绝。

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

线程创建后，目录发现与工具调用合计最多等待 45 秒，成功、失败和超时均取消线程订阅，由 Codex 卸载空闲线程。IPC 调用方取消不会丢弃清理工作。Provider 停用后拒绝后续调用和在途结果。桥接不自动重放未知结果，不启动交互登录，不修改共享插件配置，不导出凭据；调度器继续保留检查点和既有退避策略。钉钉通过下述通用 CLI 传输复用插件声明的 DWS 工具，不经过 MCP 技术线程。

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

钉钉声明五个读取操作：`listProfiles`、`searchGroups`、`searchUsers`、`listMentions` 和 `searchMessages`。应用已删除 `runtime.connections.command`、`context.readCommand`、钉钉专用读取参数白名单和缓存路径解析器；没有保留回退入口。

## 运行与分发

Executor 保留唯一的后台采集调度。它通过仅监听回环地址、具有独立随机 Bearer Token 的 DSH 路由调用连接 Provider。端点登记只接受固定路径的回环 HTTP 地址，禁止重定向，登记具有心跳有效期。Token 仅保存在进程内，不写入分身设置。

第一版采集由绑定设备上的 Wework 连接运行时提供；设备上未运行该服务时显示不可用并保留进度，不改用旧钉钉采集器或偷偷转移设备。

同一用户、Provider、账号和资源的采集结果可服务多个匹配角色。采集完成后再次检查设置版本；变更期间返回的结果不继续接单。每条事件先持久化，再保存整页检查点，因此中途失败会重新获取并去重，不跳过未处理事件。外部调用与数据库不构成分布式 exactly-once 事务。

工作归属、手动整理、执行队列和确认机制沿用现有分身实现。新的工作使用 `connection_work` origin；历史 `dingtalk_work` 仍受相同的外部来源内容约束和确认机制保护。来源插件不能绕过确认、修改项目权限或替用户授权。

暂时失败保留检查点，按退避间隔重试；不会因需要登录而自动弹出登录流程。跨系统语义相似的内容不自动视为同一事件。通用来源的去重和记忆范围包含 Provider 身份，避免同名账号和资源串用。

## 钉钉迁移

`@wegent/dsh-connection-dingtalk` 提供群聊 @我、联系人消息两个资源类型。搜索、时间窗口、分页、消息过滤和自发消息判定已移入该插件。Executor 保留原受管 DWS 凭据和回复通道，不复制登录数据。

旧个人配置的 `dingtalk[]` 在读取事务中迁移到 `connections[]`，增加钉钉 Provider ID，保留版本、处理策略和启用时间。保存请求和配置提案也经过同一规范化过程。两种字段同时出现时拒绝保存，避免静默覆盖。

历史来源、消息和工作不重新生成 ID。钉钉继续使用原去重命名空间，原 `after/until/cursor` 在首次采集时转为通用检查点。原回复仍校验工作、角色、来源消息及最新确认策略；其他 Provider 不能调用钉钉回复。

内置声明依赖明确的 `dingtalk@wegent`。其他市场中的副本不会被自动视为等价依赖；需要提供声明其准确依赖身份的连接插件，旧配置和历史仍保留。Webhook、无桌面服务的云端插件宿主和跨设备自动接管不属于本次实现。

## 验证

协议和依赖测试位于 `wework/dsh/plugin-runtime/connections.test.mjs`；钉钉采集契约测试位于 `wework/dsh/connection-dingtalk/provider.test.mjs`；回环鉴权测试位于 `wework/dsh/connection-runtime/rpc.test.mjs`。这些测试由现有 Wework 测试发现器执行。

Executor 的 `stand_in_identity_contract` 覆盖历史配置、游标和去重迁移，以及不同 Provider 的命名空间隔离。分身确认和来源权限测试继续保留。桌面新增回归接入共享 checkpoint runner；按仓库政策，仅在明确要求时运行 E2E 和真实桌面验证。

后台桥接验证包含 SDK 依赖隔离、旧工具读取声明、Executor 目录分页和工具归属、调用前依赖重验证、超时/失败清理，以及取消调用方后的清理；相关测试为 `connection-runtime/mcp.test.mjs`、`runtime_work/connection_mcp_tests.rs` 和 `agents/codex/connection_mcp.rs`。新增 `stand-in-mcp` 桌面 checkpoint 验证真实宿主/Executor 拒绝跨依赖调用，并检查连接目录可继续使用。

通用 CLI 测试还覆盖命令与参数边界、精确版本路径、原始登录身份、网络错误、群聊/私聊过滤及失败时不推进游标。`stand-in-cli` 桌面 checkpoint 验证真实目录中的钉钉读取声明、拒绝写入/注入及专用旧入口确已删除；已注册共享 CI，按仓库政策仅在明确要求时执行。

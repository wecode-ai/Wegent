---
sidebar_position: 36
---

# 插件交互式表单

Wework 支持插件在对话运行中向用户发起交互式表单，让用户在聊天界面中选择或输入答案并提交。插件开发者应通过 MCP elicitation 发起表单请求；`request_user_input` 是 Wework 和 executor 内部使用的渲染协议，不应由插件直接构造。

## 适用场景

使用交互式表单处理必须由用户决定的分支，例如：

- 从多个执行策略中选择一个。
- 确认是否允许某个高影响操作。
- 选择目标环境、发布范围或数据源。
- 补充插件执行所需的短文本参数。

如果只是普通说明或不需要阻塞插件执行，继续使用普通对话文本即可。表单会阻塞当前运行，直到用户提交、取消，或任务被停止。

## 触发方式

插件的 MCP server 在工具执行过程中发送 MCP elicitation 请求。面向 Wework 开发插件时使用 `mode: "form"`。Wework executor 在运行时事件层可以兼容识别 `form` 和 `openai/form`，但这不代表插件侧连接到的 Codex MCP client 一定允许发出 `openai/form` 请求。

这个能力只在插件运行于 Wework 本地 Codex 对话运行时，并且 MCP elicitation 请求能够到达 Wework executor 时生效。它不是所有 MCP client 的通用能力。即使插件安装并运行在 Wework 里，插件直接面对的仍然是 Codex MCP client；如果该 client 未声明支持 `openai/form`，SDK 或宿主会在请求发出前返回类似 `The MCP client does not support openai/form requests.` 的错误。此时 Wework 无法渲染表单，因为请求没有进入 Wework 的运行时事件流。

插件侧请求形态如下：

```json
{
  "jsonrpc": "2.0",
  "id": "example-form-1",
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "请选择一种处理方式",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "title": "处理方式",
          "description": "你希望插件怎么继续？",
          "oneOf": [
            { "const": "fast", "title": "快速处理" },
            { "const": "safe", "title": "稳妥处理" },
            { "const": "manual", "title": "让我确认每一步" }
          ]
        }
      },
      "required": ["strategy"]
    }
  }
}
```

请求到达 Wework executor 时，Codex app-server 会把它转发成运行时事件，形态如下：

```json
{
  "method": "mcpServer/elicitation/request",
  "params": {
    "serverName": "example-plugin",
    "mode": "form",
    "message": "请选择一种处理方式",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "title": "处理方式",
          "description": "你希望插件怎么继续？",
          "oneOf": [
            { "const": "fast", "title": "快速处理" },
            { "const": "safe", "title": "稳妥处理" },
            { "const": "manual", "title": "让我确认每一步" }
          ]
        }
      },
      "required": ["strategy"]
    }
  }
}
```

具体插件代码不需要手写 JSON-RPC 消息。优先使用所选 MCP SDK 提供的 elicitation API，只要最终发出的请求符合上述字段即可。为了兼容更多宿主，插件应在调用 elicitation 前检查 MCP client capabilities；无法确认 capabilities 或 client 不支持 form elicitation 时，不要发送表单请求。

面向 Wework 的插件必须优先使用 `mode: "form"`；只有确认目标宿主的 MCP client capabilities 明确支持 `openai/form` 时，才使用 `openai/form`。

## 支持边界

Wework 的实现链路如下：

```text
插件 MCP server 发起 elicitation
  -> Codex 对话运行时收到 mcpServer/elicitation/request
  -> executor 转成 request_user_input block
  -> Wework 聊天界面渲染表单
  -> 用户提交
  -> executor 把答案转回 MCP elicitation result
```

交互式表单不只限于 Plan 模式。Wework 里确实有一类内置的“执行此计划？”确认卡，它来自 assistant 的 plan block；但插件表单走的是 MCP elicitation 链路，是否弹出取决于请求是否到达 Wework executor、`mode` 是否支持、schema 是否可映射，而不是当前对话是否处于 Plan 模式。

如果插件收到 `action: "decline"`，但 Wework executor 日志里没有 `codex mcp elicitation request` 或 `mcpServer/elicitation/request`，说明请求在 Codex MCP runtime 里已经被提前拒绝，还没有进入 Wework 的 UI 转发层。常见原因包括：

- MCP runtime 开启了 `elicitations_auto_deny`。
- 当前 turn/thread 的 `approvalPolicy` 是 `never`。
- 当前使用 granular approval policy，但 `mcp_elicitations` 为 `false`。
- 这次工具调用不在 active turn 内，缺少可转发到 app-server/client 的事件通道。

Wework 侧需要使用允许 MCP elicitation 的 approval policy。推荐保持执行审批关闭，但单独打开 MCP 表单：

```json
{
  "approvalPolicy": {
    "granular": {
      "sandbox_approval": false,
      "rules": false,
      "skill_approval": false,
      "request_permissions": false,
      "mcp_elicitations": true
    }
  }
}
```

同时不要让普通 MCP tool call 每次都触发用户授权卡。Wework 原本使用 `approvalPolicy: "never"`，在 full-access 权限配置下普通 MCP tool approval 会自动通过；切换到 granular policy 后，需要在 Wework 注入或托管的 MCP server config 中显式保持等价行为：

```toml
[mcp_servers.example_plugin]
default_tools_approval_mode = "approve"
```

request-level、bot-level 以及 Wework 内置持久 MCP server 都应遵循这个规则。`mcp_servers.wegent_apps` 是 Wegent Connector Apps 的内置持久 server，Wework 会写成同样的 `default_tools_approval_mode = "approve"`，并在 Connector 配置或应用同步时刷新旧配置。

如某个插件工具确实需要每次授权，插件配置可以显式声明 `default_tools_approval_mode = "prompt"`，Wework 必须保留该显式配置。

另外，Wework runtime 应保持：

```toml
[features]
tool_call_mcp_elicitation = false
```

这些开关控制的不是同一件事：

- `approvalPolicy.granular.mcp_elicitations: true` 允许插件业务表单从 MCP runtime 转发到 Wework UI。
- `mcp_servers.<name>.default_tools_approval_mode = "approve"` 让普通 MCP tool call 不需要授权卡。
- `features.tool_call_mcp_elicitation: false` 只表示不要把 Codex tool-call 授权卡包装成 MCP elicitation 表单；如果 tool approval mode 仍然要求审批，Codex 还可能退回普通 `request_user_input` 授权卡。

## 实现边界

支持插件表单时必须保持下面的边界，避免影响原有授权逻辑：

- 不要把 `approvalPolicy` 简单改成允许所有审批。Wework 只需要把 `mcp_elicitations` 打开，其它审批项继续关闭。
- Wework 注入或托管的 MCP server 应默认写 `default_tools_approval_mode = "approve"`，以保持旧的普通 tool call 不弹授权行为。
- 如果 MCP server 或 tool 显式声明 `default_tools_approval_mode = "prompt"`，Wework 必须保留显式授权要求。
- Wework 自己生成并托管的内置 MCP server，例如 `wework_browser` 和 `wegent_apps`，也遵循同一条默认免普通 tool approval 规则。
- `mcpServerOpenaiFormElicitation` 不是标准 `mode: "form"` 的必要 capability。除非 Wework 和下游 client 都真正支持 `openai/form` extension，否则不要在 initialize capability 中声明它。
- 普通 shell、文件、sandbox、规则、技能或 request permission 的审批不应因为表单能力而改变。

对应代码边界：

- Codex thread/turn 参数使用 granular approval policy，只打开 `mcp_elicitations`。
- `features.tool_call_mcp_elicitation=false` 防止普通 MCP tool approval 被包装成业务表单。
- request/bot MCP config 默认补 `default_tools_approval_mode = "approve"`，显式 `prompt` 优先。
- `mcp_servers.wegent_apps` 是 Wework Connector Apps 的内置持久 server，由 Wework 写入并在 configure/app sync 时刷新，同样默认 `approve`。

因此，排查问题时可以按错误位置判断：

| 现象                                                                         | 含义                                                                    | 处理                                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `The MCP client does not support openai/form requests.`                      | 插件连接到的 Codex MCP client 不支持 `openai/form`，请求没有进入 Wework | 改用 `mode: "form"`，或走普通对话/tool 参数降级                                                                      |
| 插件收到 `action: "decline"`，但运行日志没有 `mcpServer/elicitation/request` | Codex MCP runtime 在 Wework UI 之前提前拒绝                             | 检查 `elicitations_auto_deny`、`approvalPolicy`、granular `mcp_elicitations`、是否 active turn                       |
| 表单没有出现，但运行日志里有 `mcpServer/elicitation/request`                 | 请求到达运行时，可能 schema 不受支持                                    | 检查 `mode` 和 `requestedSchema.properties`                                                                          |
| 每次 MCP tool call 都弹出“Allow this MCP tool call”表单                      | 该 MCP server/tool 的 tool approval mode 仍然要求审批                   | 对不需要授权的插件 server 设置 `default_tools_approval_mode="approve"`；确实需要授权的 server/tool 显式保留 `prompt` |
| 表单出现但提交后插件没有继续                                                 | 响应路由或插件侧结果处理有问题                                          | 检查插件是否处理 `accept`、`cancel`、`decline`                                                                       |

## Schema 到界面的映射

Wework 会读取 `requestedSchema.properties`，每个 property 转成一个问题。

| Schema 字段     | Wework 表现                                  |
| --------------- | -------------------------------------------- |
| property key    | 问题 id，提交答案时使用同一个 key            |
| `title`         | 问题标题                                     |
| `description`   | 问题说明；缺失时使用 `title` 或 property key |
| `oneOf[].title` | 选项展示文案                                 |
| `oneOf[].const` | 插件收到的真实值                             |
| `enumNames[]`   | 选项展示文案                                 |
| `enum[]`        | 插件收到的真实值                             |
| `type: boolean` | 自动显示 `true` / `false` 两个选项           |
| 无选项字段      | 显示短文本输入框                             |

当前界面的默认行为：

- 每个有选项的问题默认选中第一个选项。
- 如果表单只有一个问题，用户点击选项会立即提交。
- 如果表单有多个问题，用户可以修改选项后点击“提交”。
- 文本输入允许为空提交；插件需要自行校验必填参数。

## 返回结果

用户提交后，executor 会把 Wework 的内部答案转换回 MCP elicitation result。插件收到的结果类似：

```json
{
  "action": "accept",
  "content": {
    "strategy": "fast"
  },
  "_meta": null
}
```

如果用户取消、任务停止，或没有可用答案，结果通常是：

```json
{
  "action": "cancel",
  "content": null,
  "_meta": null
}
```

如果请求模式或 schema 不受支持，executor 会返回：

```json
{
  "action": "decline",
  "content": null,
  "_meta": null
}
```

插件必须显式处理 `accept`、`cancel` 和 `decline`。不要假设用户一定提交，也不要在取消后继续执行高影响操作。

## 示例

### 单选

```json
{
  "mode": "form",
  "message": "请选择发布目标",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "title": "发布目标",
        "description": "选择本次发布的目标环境。",
        "oneOf": [
          { "const": "staging", "title": "Staging" },
          { "const": "production", "title": "Production" }
        ]
      }
    },
    "required": ["target"]
  }
}
```

用户选择 `Production` 后，插件收到：

```json
{
  "action": "accept",
  "content": {
    "target": "production"
  },
  "_meta": null
}
```

### 布尔确认

```json
{
  "mode": "form",
  "message": "是否继续删除缓存？",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "confirm": {
        "type": "boolean",
        "title": "确认删除",
        "description": "此操作会清空当前工作区缓存。"
      }
    },
    "required": ["confirm"]
  }
}
```

用户选择 `true` 后，插件收到：

```json
{
  "action": "accept",
  "content": {
    "confirm": true
  },
  "_meta": null
}
```

### 文本输入

```json
{
  "mode": "form",
  "message": "请输入发布说明",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "releaseNote": {
        "type": "string",
        "title": "发布说明",
        "description": "这段内容会写入发布记录。"
      }
    },
    "required": ["releaseNote"]
  }
}
```

用户提交后，插件收到：

```json
{
  "action": "accept",
  "content": {
    "releaseNote": "修复登录失败并优化启动速度"
  },
  "_meta": null
}
```

### 自定义选项

当前不支持“某个选项是自定义，选择后再展开输入框”的条件式表单。推荐把它建模为两个字段：一个单选字段选择内置选项或 `custom`，另一个文本字段填写自定义内容。

```json
{
  "mode": "form",
  "message": "请选择处理方式",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "strategy": {
        "type": "string",
        "title": "处理方式",
        "description": "选择一个处理方式。",
        "oneOf": [
          { "const": "fast", "title": "快速处理" },
          { "const": "safe", "title": "稳妥处理" },
          { "const": "custom", "title": "自定义" }
        ]
      },
      "customStrategy": {
        "type": "string",
        "title": "自定义处理方式",
        "description": "如果上面选择了自定义，请填写具体要求。"
      }
    },
    "required": ["strategy"]
  }
}
```

用户选择自定义并填写内容后，插件收到：

```json
{
  "action": "accept",
  "content": {
    "strategy": "custom",
    "customStrategy": "先检查 diff，再只改测试"
  },
  "_meta": null
}
```

插件需要自行校验：当 `strategy` 是 `custom` 时要求 `customStrategy` 非空；当 `strategy` 不是 `custom` 时忽略 `customStrategy`。

## 约束和注意事项

- 面向 Wework 的插件使用 `mode: "form"`。`openai/form` 只作为 executor 收到事件后的兼容模式，不应作为 Wework 插件默认模式。
- `requestedSchema.properties` 必须存在；缺失或不支持会被拒绝。
- 推荐使用 `oneOf` 表达单选，因为它能同时提供展示文案和稳定机器值。
- `enum` 目前只支持字符串值；需要展示名时同时提供 `enumNames`。
- `oneOf[].const` 当前按字符串值处理；不要依赖对象、数字或布尔 const。
- `array` 会被转换成数组结果，但当前 UI 不是多选控件；不要用它表达真正的多选。
- 数字和整数会在提交后尝试解析；解析失败时字段会被省略，插件需要校验。
- `required` 主要用于插件侧语义，Wework 当前不会阻止空文本提交。
- 需要稳定默认值时，把默认选项放在选项列表第一位。
- 单问题选项卡片点击后会立即提交；需要“先选择再确认”的交互时，把请求拆成多问题表单或等待 Wework 增加显式开关。
- 当前没有条件显示控件；“自定义选项 + 输入框”请用单选字段加文本字段建模，并在插件侧校验。

## 开发检查清单

- 表单请求使用 MCP elicitation，而不是直接输出普通 Markdown 或内部 `request_user_input` JSON。
- 每个字段都有稳定的 property key，插件逻辑只依赖返回的 `content` 值。
- 每个选项都有面向用户的 `title` 和面向程序的 `const`。
- 插件处理 `cancel` 和 `decline`，并停止或回滚待执行动作。
- 插件对必填、数字范围、环境名称等业务规则做二次校验。
- 对高影响操作，表单文案清楚说明影响范围和后果。

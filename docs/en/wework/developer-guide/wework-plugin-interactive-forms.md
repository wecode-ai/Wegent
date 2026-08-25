---
sidebar_position: 36
---

# Plugin Interactive Forms

Wework supports interactive forms from plugins during a running conversation. The user sees a form card in chat, selects or enters answers, and submits the response back to the running plugin. Plugin authors should trigger this through MCP elicitation. `request_user_input` is an internal render protocol between executor and Wework and should not be emitted directly by plugins.

## When To Use It

Use an interactive form when plugin execution must wait for a user decision, such as:

- Choosing one execution strategy from several options.
- Confirming whether to allow a high-impact operation.
- Selecting a target environment, release scope, or data source.
- Providing a short parameter required by the plugin.

If the plugin only needs to explain progress and does not need to block execution, use normal chat output instead. A form blocks the current run until the user submits, cancels, or stops the task.

## Trigger

The plugin MCP server sends an MCP elicitation request while a tool is running. Use `mode: "form"` when building plugins for Wework. The Wework executor can recognize both `form` and `openai/form` at the runtime event layer, but that does not mean the Codex MCP client connected to the plugin will allow an `openai/form` request to be sent.

This only works when the plugin is running inside the Wework local Codex chat runtime and the MCP elicitation request reaches the Wework executor. It is not a universal feature of every MCP client. Even when the plugin is installed and running in Wework, the plugin still talks first to the Codex MCP client. If that client does not declare support for `openai/form`, the SDK or host can fail before sending the request with an error such as `The MCP client does not support openai/form requests.` In that case Wework cannot render the form because the request never entered Wework's runtime event stream.

The plugin-side request shape is:

```json
{
  "jsonrpc": "2.0",
  "id": "example-form-1",
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "Choose how to continue",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "title": "Strategy",
          "description": "How should the plugin continue?",
          "oneOf": [
            { "const": "fast", "title": "Fast" },
            { "const": "safe", "title": "Safe" },
            { "const": "manual", "title": "Ask me before each step" }
          ]
        }
      },
      "required": ["strategy"]
    }
  }
}
```

When the request reaches the Wework executor, Codex app-server forwards it as a runtime event:

```json
{
  "method": "mcpServer/elicitation/request",
  "params": {
    "serverName": "example-plugin",
    "mode": "form",
    "message": "Choose how to continue",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "strategy": {
          "type": "string",
          "title": "Strategy",
          "description": "How should the plugin continue?",
          "oneOf": [
            { "const": "fast", "title": "Fast" },
            { "const": "safe", "title": "Safe" },
            { "const": "manual", "title": "Ask me before each step" }
          ]
        }
      },
      "required": ["strategy"]
    }
  }
}
```

Plugin code should usually not hand-write JSON-RPC. Prefer the elicitation API from the MCP SDK you are using, as long as the resulting request contains the fields above. For broader host compatibility, check MCP client capabilities before calling elicitation. If capabilities are unavailable or the client does not support form elicitation, do not send the form request.

For Wework-targeted plugins, use `mode: "form"` first. Use `openai/form` only when the target host's MCP client capabilities explicitly support it.

## Support Boundary

Wework's implementation path is:

```text
Plugin MCP server sends elicitation
  -> Codex chat runtime receives mcpServer/elicitation/request
  -> executor converts it to a request_user_input block
  -> Wework chat renders the form
  -> user submits
  -> executor converts the answer back to an MCP elicitation result
```

Interactive forms are not limited to Plan mode. Wework does have a built-in "execute this plan?" confirmation card that comes from assistant plan blocks, but plugin forms use the MCP elicitation path. Whether a plugin form appears depends on whether the request reaches the Wework executor, whether the `mode` is supported, and whether the schema can be mapped. It does not depend on the conversation being in Plan mode.

If the plugin receives `action: "decline"` but the Wework executor log does not contain `codex mcp elicitation request` or `mcpServer/elicitation/request`, the request was rejected inside the Codex MCP runtime before it reached Wework's UI forwarding layer. Common causes include:

- The MCP runtime has `elicitations_auto_deny` enabled.
- The current turn/thread uses `approvalPolicy: "never"`.
- The current turn/thread uses granular approval policy with `mcp_elicitations: false`.
- The tool call is not running inside an active turn, so there is no event channel to forward the request to app-server/client.

Wework should use an approval policy that allows MCP elicitations. The recommended shape keeps execution approvals disabled while allowing MCP forms:

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

At the same time, do not make normal MCP tool calls ask for user approval every time. Wework previously used `approvalPolicy: "never"`, which auto-approved normal MCP tool approval prompts under the full-access permission profile. After switching to granular policy, Wework-injected or Wework-managed MCP server config must explicitly preserve that equivalent behavior:

```toml
[mcp_servers.example_plugin]
default_tools_approval_mode = "approve"
```

Request-level, bot-level, and Wework built-in persistent MCP servers should all follow this rule. For tools from Wegent Connector Apps, Wework writes the built-in persistent MCP server `mcp_servers.wegent_apps` with the same `default_tools_approval_mode = "approve"` and refreshes existing config during connector configure or app sync.

If a plugin tool really needs per-call approval, the plugin config can explicitly declare `default_tools_approval_mode = "prompt"`. Wework must preserve that explicit setting. Read-only and workspace permission modes still show the approval card for these calls. In Full access mode, Wework automatically accepts approval requests marked with `_meta.codex_approval_kind = "mcp_tool_call"` instead of showing them to the user.

Also keep:

```toml
[features]
tool_call_mcp_elicitation = false
```

These switches control different behavior:

- `approvalPolicy.granular.mcp_elicitations: true` allows plugin business forms to be forwarded from the MCP runtime to the Wework UI.
- `mcp_servers.<name>.default_tools_approval_mode = "approve"` makes normal MCP tool calls not require approval cards.
- `features.tool_call_mcp_elicitation: false` only means Codex should not wrap tool-call approval cards as MCP elicitation forms. If the tool approval mode still requires approval, Codex may fall back to a normal `request_user_input` approval card.
- Full access mode automatically accepts approvals explicitly marked as `mcp_tool_call` while continuing to forward plugin business forms without that marker.

## Implementation Boundary

Keep these boundaries when supporting plugin forms so existing approval behavior is not changed accidentally:

- Do not switch `approvalPolicy` to broadly allow every approval type. Wework only needs `mcp_elicitations` enabled; the other approval gates stay disabled.
- Wework-injected or Wework-managed MCP servers should default to `default_tools_approval_mode = "approve"` to preserve the previous no-prompt behavior for normal tool calls.
- If an MCP server or tool explicitly declares `default_tools_approval_mode = "prompt"`, Wework must preserve the configuration. Read-only and workspace modes show the approval card, while Full access automatically accepts the tool-call approval.
- Wework-owned built-in MCP servers, such as `wework_browser` and `wegent_apps`, follow the same default no-normal-tool-approval rule.
- `mcpServerOpenaiFormElicitation` is not required for standard `mode: "form"`. Do not advertise it in initialize capabilities unless Wework and the downstream client actually support the `openai/form` extension.
- Shell, file, sandbox, rule, skill, and request-permission approvals should not change because plugin forms are enabled.

Code-level boundaries:

- Codex thread/turn params use granular approval policy and only enable `mcp_elicitations`.
- `features.tool_call_mcp_elicitation=false` prevents normal MCP tool approval from being wrapped as a business form.
- Request/bot MCP config defaults to `default_tools_approval_mode = "approve"`, with explicit `prompt` taking precedence.
- Full access recognizes `_meta.codex_approval_kind = "mcp_tool_call"` and returns `accept` without forwarding that approval event to the chat UI.
- `mcp_servers.wegent_apps` is the Wework Connector Apps built-in persistent server, so Wework writes it and refreshes it during configure/app sync with the same default `approve` behavior.

Use the error location to debug:

| Symptom                                                                                      | Meaning                                                                                                       | Action                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `The MCP client does not support openai/form requests.`                                      | The Codex MCP client connected to the plugin does not support `openai/form`; the request did not reach Wework | Switch to `mode: "form"`, or fall back to normal chat/tool parameters                                                                        |
| Plugin receives `action: "decline"`, but logs do not contain `mcpServer/elicitation/request` | Codex MCP runtime rejected the request before Wework UI                                                       | Check `elicitations_auto_deny`, `approvalPolicy`, granular `mcp_elicitations`, and active-turn routing                                       |
| No form appears, but logs contain `mcpServer/elicitation/request`                            | The request reached the runtime, but the schema may be unsupported                                            | Check `mode` and `requestedSchema.properties`                                                                                                |
| Full access still shows an "Allow this MCP tool call" form                                   | The approval was not identified as `mcp_tool_call`, or the runtime did not receive the Full access profile    | Check `_meta.codex_approval_kind` and `runtime_permission_profile`; do not auto-accept ordinary business forms                               |
| Every MCP tool call shows an approval form in read-only or workspace mode                    | The MCP server/tool approval mode still requires approval                                                     | Set `default_tools_approval_mode="approve"` for plugin servers that do not need approval; explicitly keep `prompt` for servers/tools that do |
| The form appears but the plugin does not continue after submit                               | Response routing or plugin result handling is broken                                                          | Verify the plugin handles `accept`, `cancel`, and `decline`                                                                                  |

## Schema Mapping

Wework reads `requestedSchema.properties` and turns each property into one question.

| Schema field     | Wework behavior                                          |
| ---------------- | -------------------------------------------------------- |
| property key     | Question id and response key                             |
| `title`          | Question header                                          |
| `description`    | Question text; falls back to `title` or the property key |
| `oneOf[].title`  | Option label shown to the user                           |
| `oneOf[].const`  | Stable value returned to the plugin                      |
| `enumNames[]`    | Option label shown to the user                           |
| `enum[]`         | Stable value returned to the plugin                      |
| `type: boolean`  | Shows `true` and `false` options                         |
| no option fields | Shows a short text input                                 |

Current UI behavior:

- Each question with options defaults to the first option.
- If the form has a single question, selecting an option submits immediately.
- If the form has multiple questions, the user can change options and then click Submit.
- Text inputs can be submitted empty; the plugin must validate required values.

## Result

After the user submits, executor converts Wework's internal answer payload back to an MCP elicitation result. The plugin receives a result like:

```json
{
  "action": "accept",
  "content": {
    "strategy": "fast"
  },
  "_meta": null
}
```

If the user cancels, the task is stopped, or no usable answer is available, the result is usually:

```json
{
  "action": "cancel",
  "content": null,
  "_meta": null
}
```

If the request mode or schema is unsupported, executor returns:

```json
{
  "action": "decline",
  "content": null,
  "_meta": null
}
```

Plugins must handle `accept`, `cancel`, and `decline` explicitly. Do not assume the user will always submit, and do not continue a high-impact operation after cancellation.

## Examples

### Single Choice

```json
{
  "mode": "form",
  "message": "Choose a deployment target",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "target": {
        "type": "string",
        "title": "Deployment target",
        "description": "Select the target environment for this deployment.",
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

After the user chooses `Production`, the plugin receives:

```json
{
  "action": "accept",
  "content": {
    "target": "production"
  },
  "_meta": null
}
```

### Boolean Confirmation

```json
{
  "mode": "form",
  "message": "Continue deleting the cache?",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "confirm": {
        "type": "boolean",
        "title": "Confirm deletion",
        "description": "This operation clears the current workspace cache."
      }
    },
    "required": ["confirm"]
  }
}
```

After the user chooses `true`, the plugin receives:

```json
{
  "action": "accept",
  "content": {
    "confirm": true
  },
  "_meta": null
}
```

### Text Input

```json
{
  "mode": "form",
  "message": "Enter release notes",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "releaseNote": {
        "type": "string",
        "title": "Release note",
        "description": "This text will be written to the release record."
      }
    },
    "required": ["releaseNote"]
  }
}
```

After the user submits, the plugin receives:

```json
{
  "action": "accept",
  "content": {
    "releaseNote": "Fix login failures and improve startup speed"
  },
  "_meta": null
}
```

### Custom Option

Wework does not currently support a conditional form where one option is "Custom" and selecting it expands an input field. Model this as two fields instead: one single-choice field for built-in options or `custom`, and one text field for the custom value.

```json
{
  "mode": "form",
  "message": "Choose how to handle this",
  "requestedSchema": {
    "type": "object",
    "properties": {
      "strategy": {
        "type": "string",
        "title": "Strategy",
        "description": "Choose a handling strategy.",
        "oneOf": [
          { "const": "fast", "title": "Fast" },
          { "const": "safe", "title": "Safe" },
          { "const": "custom", "title": "Custom" }
        ]
      },
      "customStrategy": {
        "type": "string",
        "title": "Custom strategy",
        "description": "If you chose Custom above, describe the requested handling."
      }
    },
    "required": ["strategy"]
  }
}
```

After the user chooses Custom and enters text, the plugin receives:

```json
{
  "action": "accept",
  "content": {
    "strategy": "custom",
    "customStrategy": "Inspect the diff first, then only update tests"
  },
  "_meta": null
}
```

The plugin must validate this itself: when `strategy` is `custom`, require `customStrategy` to be non-empty; otherwise ignore `customStrategy`.

## Constraints

- Use `mode: "form"` for Wework-targeted plugins. `openai/form` is only a compatibility mode after executor receives an event; do not use it as the default Wework plugin mode.
- `requestedSchema.properties` must exist; missing or unsupported shapes are declined.
- Prefer `oneOf` for single choice fields because it provides both display labels and stable machine values.
- `enum` currently supports string values only; provide `enumNames` when display labels differ from values.
- `oneOf[].const` is currently treated as a string value; do not depend on object, number, or boolean const values.
- `array` is converted to an array result, but the current UI is not a true multi-select control. Do not use it for real multi-select choices.
- Number and integer fields are parsed after submission. If parsing fails, the field is omitted, so plugins must validate results.
- `required` is primarily plugin-side semantics. Wework does not currently block empty text submissions.
- To provide a stable default choice, place that option first.
- A single-question option form submits as soon as the user clicks an option. For a strict "choose, then confirm" flow, split the request into a multi-question form or wait for Wework to add an explicit control.
- Conditional controls are not available yet. For "custom option plus input", model it as a single-choice field plus a text field and validate it in the plugin.

## Development Checklist

- The form request uses MCP elicitation, not plain Markdown or internal `request_user_input` JSON.
- Every field has a stable property key, and plugin logic depends only on returned `content` values.
- Every option has a user-facing `title` and a machine-facing `const`.
- The plugin handles `cancel` and `decline` by stopping or rolling back pending work.
- The plugin validates required fields, numeric ranges, environment names, and other business rules.
- High-impact operations use clear copy that explains scope and consequences.

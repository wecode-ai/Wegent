---
sidebar_position: 37
---

# Applications and MCP Elicitation Desktop E2E

This document defines the real desktop regression plan for Wework application entry points and MCP business forms. The tests reuse the existing desktop runner and checkpoints. They do not add local-only scripts or replace Tauri, Executor, or Codex with browser mocks.

## Scope

The plan covers two independent risks:

1. Whether Applications > Sites and Applications > Mini Programs open a fresh blank task with the correct structured Composer draft.
2. Whether an MCP server can still initiate `elicitation/create` in Full access mode and receive the user's answer through the Wework form.

The stable technical identifiers and user-facing plugin names are:

| Application type | Plugin technical key             | User-facing name     |
| ---------------- | -------------------------------- | -------------------- |
| Site             | `wegent-sites`                   | 快速建站             |
| Mini Program     | `weibo-miniapp-h5-develop-agent` | 微博小程序H5开发助手 |

Tests must not replace technical identifiers with display names. Technical identifiers are used by installation APIs, Composer node attributes, and plugin URIs. Display names are used by UI and draft text assertions.

## Checkpoints and Real Boundaries

The application entry-point scenarios belong to the existing `sites-plugin-auto-install` plugin checkpoint:

```bash
pnpm --filter wework e2e:desktop:plugins -- --segment sites-plugin-auto-install
```

The MCP form scenario belongs to the existing `permission-modes` core checkpoint:

```bash
pnpm --filter wework e2e:desktop -- --segment permission-modes
```

GitHub CI must invoke both checkpoints. The desktop E2E classifier should map the new MCP fixture explicitly to `core:permission-modes`, preventing fixture-only changes from selecting unrelated desktop suites.

## Application Entry-Point Cases

### Shared Preconditions

- Use the fixed Sites upstream site `E2E Product Site` with project ID `prj_e2e_product`.
- Use the fixed Mini Program `E2E Mini Program` with project ID `prj_e2e_mini`.
- Before each click, record the Composer `standaloneChatKey`, `scopeKey`, current project ID, and current runtime task.
- After each click, require `standaloneChatKey` to increase by one, `scopeKey` to change, `currentRuntimeTask` to be `null`, and the current project to remain unchanged.
- Assert normalized draft text by complete equality and separately verify structured chip attributes. A substring assertion is insufficient.

### Continue Developing a Site

1. Open Applications > Sites.
2. Click Continue Developing on the `E2E Product Site` row.
3. Wait for a fresh blank-task Composer.
4. Assert the visible draft:

```text
E2E Product Site 请说出你要做的改动
```

5. Assert the internal draft:

```text
[E2E Product Site](wegent-sites-project://prj_e2e_product) 请说出你要做的改动
```

6. Assert that the link chip provider, label, and URL are `wegent-sites-project`, `E2E Product Site`, and `wegent-sites-project://prj_e2e_product`.
7. Assert that first use installs `wegent-sites` on demand and that the page exposes no `sites-create-error`.

### Create a Site

1. Return to Applications > Sites, open the create menu, and click Site.
2. Wait for a fresh blank-task Composer.
3. Assert the visible draft:

```text
快速建站 Build an internal website and validate it locally
```

4. Assert the internal draft:

```text
[$快速建站](plugin://wegent-sites@wegent) Build an internal website and validate it locally
```

5. Assert that the plugin chip technical name and marketplace are `wegent-sites` and `wegent`.
6. Assert that the plugin installed by the previous step is reused without another ensure-installed call.

### Create a Mini Program

1. Return to Applications, select Mini Programs, open the create menu, and click Mini Program.
2. Wait for a fresh blank-task Composer.
3. Assert the visible draft:

```text
微博小程序H5开发助手 创建并发布一个小程序
```

4. Assert the internal draft:

```text
[$微博小程序H5开发助手](plugin://weibo-miniapp-h5-develop-agent@wegent) 创建并发布一个小程序
```

5. Assert that the plugin chip technical name and marketplace are `weibo-miniapp-h5-develop-agent` and `wegent`.
6. Assert that first use installs the Mini Program plugin on demand and exposes no installation error.

## MCP Elicitation Case

### Fixture

Use an isolated stdio MCP server named `mcp-elicitation-server.mjs` that exposes:

```text
wegent_sites_interactions.confirm_inner_site_access
```

When the fixture receives `tools/call`, it keeps the call pending and sends Codex:

```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "message": "请选择内网访问范围",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "audience": {
          "type": "string",
          "title": "访问范围",
          "enum": ["all", "owner"],
          "enumNames": ["所有人", "仅自己"]
        }
      },
      "required": ["audience"]
    }
  }
}
```

After receiving the Codex response, the fixture writes the raw result to a JSONL file in the current E2E result directory before completing `tools/call`. Accepting `owner` returns this unique tool marker:

```text
E2E_MCP_ELICITATION_ACCEPTED:owner
```

### Codex Configuration

Keep the isolated base configuration unchanged:

```toml
approval_policy = "never"
```

Only add the test MCP server:

```toml
[mcp_servers.wegent_sites_interactions]
command = "<current Node executable>"
args = ["<absolute fixture path>", "<absolute evidence path>"]
default_tools_approval_mode = "approve"
```

Do not change the base configuration to granular just to pass this test. After the user enables Full access in the UI, Executor must override `thread/start`, `thread/resume`, `thread/fork`, and `turn/start` with a granular policy that disables execution-safety approvals while preserving `mcp_elicitations: true`.

### Model and Protocol Steps

The deterministic model scenario handles three requests in order:

1. Return `tool_search` for the fixed prompt, querying `confirm_inner_site_access`.
2. Select namespace `wegent_sites_interactions` from the search results and call `confirm_inner_site_access`.
3. Return final completion text only after the model input contains both that tool call's output and `E2E_MCP_ELICITATION_ACCEPTED:owner`.

The real path is:

```text
Real model request
  → tool_search
  → MCP tools/call
  → elicitation/create
  → mcpServer/elicitation/request
  → Executor request_user_input
  → Wework form
  → user selects “仅自己”
  → MCP action=accept
  → successful tool marker
  → final model completion
```

### UI and Evidence Assertions

Run this scenario after `permission-modes` confirms Full access and before switching to Read only:

1. Send the fixed prompt and wait for `[data-testid="request-user-input-card"]`.
2. Assert that the card displays “访问范围”, “所有人”, and “仅自己”, and is not an ordinary MCP tool approval card.
3. While the form is visible, require the evidence file to remain absent, proving Codex did not auto-`decline` early.
4. Click `request-user-input-option-audience-1`. A single-question form auto-submits, so do not click the submit button again.
5. Wait for the final model completion text and an idle runtime task.
6. Expand `final-processing-toggle`, then wait for `request-user-input-summary` to display “仅自己”.
7. Assert the exact fixture evidence:

```json
{
  "action": "accept",
  "content": {
    "audience": "owner"
  }
}
```

## Evidence and Failure Diagnosis

A successful run retains at least:

- One fresh-task draft screenshot for each of the three application entry points.
- A screenshot of the visible MCP form.
- A screenshot containing the submitted MCP summary and final completion.
- The fixture's raw JSONL receipt.
- The runner's UI snapshot, model requests, and executor log.

Typical failure meanings:

| Failure                                              | Inspect first                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Fresh-task identity did not change                   | `openInNewChat`, queued plugin trial consumption, and Workbench scope switching             |
| Text is correct but chip attributes are wrong        | Plugin technical key, marketplace, or structured Composer parser                            |
| MCP form never appears and fixture records `decline` | Whether Full access runtime `approvalPolicy` preserves `mcp_elicitations`                   |
| Form appears but fixture does not receive `accept`   | Executor enum-label to stable enum-value mapping and response routing                       |
| Model never completes                                | Whether MCP tool output reaches the next model input and whether the success marker matches |

At the end of the test, the existing runner terminates Tauri, Executor, Codex, and the stdio MCP child process and removes the isolated homes. The fixture must never read or write the user's personal Codex home.

---
sidebar_position: 39
---

# Wework Cloud Model Proxy Gateway

The Wework desktop client and the Wegent backend may run on different machines. When the desktop client uses a Model CRD with real cloud provider credentials, the provider `api_key` must remain on the backend while Codex can still call the cloud model.

## Solution

Wework builds proxy model config directly from the configured cloud URL and login token. Wegent then calls the real provider on behalf of Wework.

### Key Components

- `app/services/llm_proxy_service.py`: resolves model identity, checks access, and forwards provider requests.
- `POST /api/runtime-work/llm-responses-proxy/responses`: proxy endpoint authenticated with the user's login token.
- `/models/unified`: returns the model name, type, namespace, and resource owner ID needed to identify the Model CRD exactly.

### Default Position in Cloud Model Presets

The Model CRD's `spec.modelConfig.ui.defaultModel: true` marks the default model,
and `sliderModelsConfig.defaultPreset` names the default slider preset. Selecting
that preset first targets the model that owns the preset configuration, even when
it is second or later in `presets[].models`. An entry without `reasoningEffort`
selects only the model and can also be the default position. Entries with an
explicit effort match the owner's default reasoning effort. The first preset
entry is selected only when no matching entry exists.

### Request Flow

1. Wework fetches credential-free model metadata from `/models/unified`.
2. Wework directly builds proxy config: `base_url` is `/api/runtime-work/llm-responses-proxy` under the configured cloud URL, and `api_key` is the current cloud login token.
3. The executor Codex compatibility proxy authenticates to the backend with that token and sends the model type, namespace, and resource owner ID.
4. The backend validates the login token and model access, then resolves the Model CRD by `user_id + namespace + name`.
5. The backend loads the real provider configuration, replaces the request model with the provider `model_id`, and streams the request and response.

### Protocol and Endpoint Resolution

The proxy gateway supports OpenAI Responses, OpenAI Chat Completions, and Anthropic Messages. The Model CRD's `protocol`, `apiFormat`, and `wire_api` select the upstream wire protocol. Conflicting or ambiguous configuration returns an explicit backend error instead of silently falling back to another protocol.

The provider `base_url` may be a service root, a versioned API base, or a complete protocol endpoint. The gateway merges endpoint path segments and removes overlap. For example:

- `https://api.anthropic.com` with Anthropic Messages resolves to `/v1/messages`.
- `https://proxy.example.com/v1` with Anthropic Messages still resolves to `/v1/messages`, never `/v1/v1/messages`.
- URLs already ending in `/responses`, `/chat/completions`, or `/v1/messages` do not receive a duplicate endpoint.

#### Responses Reasoning and Request Modes

`modelConfig.env.thinking_config.reasoning` in a Model CRD (also accepted as `thinkingConfig`) supplies Wework's default reasoning settings. The model catalog exposes only supported `effort` and `summary` values, without the full env or provider credentials. The picker uses the configured default effort. Explicit user selections override individual fields while preserving other defaults, such as `summary: "detailed"` when the effort changes.

`modelConfig.codex_request_mode` controls the complete Codex Responses request policy:

| Value             | Behavior                                                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` or omitted | Keep the existing protocol adaptation. Existing switches can still configure individual native Responses tool capabilities.                                                                                                               |
| `standard`        | Use ordinary function tools, bridging `tool_search`, namespace and custom tools, and restoring tool identities on the return path to Codex. Use this for Kimi Responses and other services that do not support Codex's native tool types. |
| `passthrough`     | Replace only the model ID and authentication needed for routing. Preserve all other request business fields and stream responses without protocol rewriting. Requires an OpenAI Responses upstream.                                       |

Passthrough retains reasoning, history, original call IDs, encrypted content, `previous_response_id`, `include`, `store` and extension fields. It also bypasses image budget trimming, vision sidecar replacement, history enhancement, fork/model-switch cleanup and output-limit injection. The proxy does not add the configured `max_output_tokens` to the request. The upstream must support the original Codex request contents directly.

For example, configure Kimi Responses with:

```json
{
  "modelConfig": {
    "codex_request_mode": "standard",
    "env": {
      "model": "openai",
      "model_id": "moonshot-kimi-k3",
      "thinking_config": {
        "reasoning": { "summary": "detailed" }
      }
    }
  }
}
```

Responses services that fully support Codex requests can set this field to `"passthrough"`. The request mode takes precedence over individual tool settings such as `native_tool_search` and `native_namespace_tools`. Invalid modes and passthrough configurations for other protocols are rejected before execution.

The model catalog omits invalid `codex_request_mode` values while preserving other valid model metadata, so one misconfigured model cannot break the entire list. Catalog reads do not modify the stored Model CRD. Actual calls still validate the original configuration: both local and cloud execution return HTTP 400 before sending a request to the model provider.

Passthrough preserves the original bytes of normal upstream chunks. A read error or EOF before a Responses terminal event only appends `response.failed`; no additional failure is emitted after `response.completed`, `response.failed`, or `response.incomplete`. A standalone `[DONE]` marker does not replace a Responses terminal event.

`standard` mode advertises only client-executable function tools. It omits provider-hosted tools such as `web_search` and `image_generation`. If `tool_choice` forces a hosted tool, the proxy returns HTTP 400. `auto` and `passthrough` continue to preserve these tools.

#### Kimi K3 Chat Completions Compatibility

When a cloud Model CRD uses OpenAI Chat Completions and its provider model name contains the case-insensitive substring `kimi-k3`, such as `moonshot-kimi-k3`, Wework automatically selects the `wework-kimi-k3` Codex model catalog with a 1,048,576-token context window if the Model CRD does not configure `codex_catalog_model_id` or `codexCatalogModelId`. An explicitly configured catalog always takes precedence over automatic Kimi K3 selection. Codex continues to use the Responses protocol internally, while the executor translates requests to Chat Completions at the boundary and applies the following Kimi K3 compatibility behavior:

- It sends Kimi's supported `thinking` field instead of the generic `reasoning_effort` field.
- It preserves `reasoning_content` across multi-turn messages and tool calls.
- It preserves namespace tool identity through a reversible mapping so same-named tools still route to the correct executor.
- It retains the top-level `type: "object"` on function parameters, equivalently nests a root `anyOf` constraint under `allOf`, and fills object types on `anyOf` branches to satisfy Kimi tool-schema validation.

An explicit Anthropic Messages configuration is never overridden. Operators must select OpenAI Chat Completions in the Model CRD through `protocol` or `apiFormat`. Leaving only `env.model=claude` without protocol metadata continues to route requests as Anthropic Messages to `/v1/messages`.

When a task runs on a cloud or remote device, the model selector also shows local models configured on the current desktop. On first use or after a configuration change, Wework asks for confirmation, synchronizes the custom Codex model catalog to the target Executor, restarts its Codex app-server while the device is idle, verifies that the model was loaded, and only then sends the task. Built-in Codex models and cloud Model CRDs continue to work directly with either local or cloud execution.

Generic cloud models use the `wework-gpt-6.1-sol` shared compatibility catalog through the same catalog and cloud-model flow previously used by `wework-gpt-5.6-sol`, without requiring an official account. The shared profile preserves the previous protocol capabilities without forcing reasoning levels or enabling official-only code mode or Responses Lite. Cloud model metadata can override the context window; `max_context_window` stays unset so the compatibility profile does not cap it. Official Codex models retain their own capabilities and window limits.

### Model Rate-Limit Retries

When the upstream has not started a response stream and the model service returns HTTP `429 Too Many Requests`, the executor Codex compatibility proxy automatically resends the same model request. It retries at most five times, waiting 1, 5, 10, 30, and 60 seconds between attempts.

If the upstream returns a standard `Retry-After` header, the proxy uses that delay instead, capped at 60 seconds for one wait. Non-429 responses do not activate this policy. After the retry budget is exhausted, the proxy returns the final 429 status and error body to Codex. A stream that has already started is never replayed by this mechanism, preventing duplicate generation or tool execution.

### Retry Status

When Codex or the model proxy reports a retry event, the conversation immediately
shows “Retrying automatically…” in its processing header instead of showing only
thinking status. Rate-limit waits retain their dedicated “Model rate limited.
Waiting to retry…” message. Output recovery or task completion clears the retry
status. Sustained interruptions still show detailed reconnecting guidance, with
a proxy settings action for ChatGPT models.

This status depends on runtime events. Request-level retries that Codex does not
report, including its hidden first WebSocket retry, cannot yet be identified by
the UI.

### Codex Direct-Provider Overload Recovery

Native Codex providers can bypass the compatibility proxy. When the app-server
reports a structured `serverOverloaded` error, the executor waits for the failed
turn's `turn/completed` event before continuing in the same thread with the same
model. Recovery is bounded to five attempts, delayed by 5, 10, 20, 40, and 60
seconds.

Recovery submits an empty native `turn/start` input against the saved history. It
does not replay the original task, attachments, user-message identity, or already
merged additional context. Completed tool results remain in history. The task
stays running and exposes reconnecting status during recovery. Before the retry
request starts, the executor emits a recovery event so open views clear that
turn's terminal error state instead of showing a stale failure card. Cancellation
stops the wait immediately, and exhausted recovery returns the final failure.
Quota, authentication, context-window, and subagent errors, as well as errors
already being retried by Codex, do not trigger this policy.

The executor persists the IDs of failed turns that entered recovery. Native and
cached transcript reads clear only those turns' terminal error state while
preserving user messages and tool output, so reopening a task does not restore
handled failure cards. The final exhausted turn and unrelated failures remain
unchanged.

The `codex overloaded turn recovery` diagnostic records the thread, retry number,
limit, and delay in milliseconds. The `model-overload-recovery` desktop checkpoint
uses real Electron, Codex, and executor processes to verify tool-history retention,
automatic continuation, no duplicate user messages, and cancellation.

### Anthropic Empty-Output Recovery

Some Anthropic Messages-compatible services may return a stop reason and positive `output_tokens` in `message_delta` without sending any text, thinking content, or tool call. The executor Codex compatibility proxy converts this incomplete response into a failure event instead of incorrectly emitting a successful completion. Codex can then retry the current model request through its stream-error recovery path, preventing Wework from ending the task without an assistant response.

This check activates only when no model output has been observed. Responses that already produced text, thinking content, or a tool call are not replayed, and valid connection-prewarm responses with zero `output_tokens` remain unaffected.

### Claude Code Tool-Result Integrity

Claude Code calls the Wework model router through the Anthropic Messages protocol. Before converting a request to OpenAI Responses or Chat Completions, the executor checks that every assistant `tool_use` has a later user `tool_result` with the same ID. Parallel tool results may be split across multiple user messages and arrive out of declaration order as each tool completes. When a matching result exists anywhere in the request history, the proxy preserves it and must not insert an early failure. Only when a tool process terminates before returning a result and the complete history has no matching result does the proxy insert an explicit failure so the history remains protocol-valid and the model can continue from the failure. Existing successful or failed tool results are never replaced or duplicated.

Local and remote Claude Code tasks, including agents with a fixed model, use the same executor protocol bridge for all three cloud upstream protocols. The Backend preserves the model’s actual protocol and complete resource identity. It does not require an Anthropic Messages upstream or send Claude requests directly to an incompatible API; the executor model router performs protocol conversion.

### Namespace Tool Compatibility

Codex can group child tools under a `type: "namespace"` tool when it sends an OpenAI Responses request. OpenAI Chat Completions and Anthropic Messages have no equivalent namespace field, so the executor Codex compatibility proxy applies a reversible mapping at the protocol boundary:

1. During request conversion, child tools are expanded into ordinary Chat or Anthropic function tools. A unique child keeps its original name; collisions receive a stable alias containing the namespace.
2. Aliases use only characters accepted by Chat function names and are limited to 64 bytes. Longer names are truncated with a stable hash.
3. Historical tool calls and an explicit `tool_choice` use the same mapping so tool identity remains stable across turns.
4. When the upstream returns a flat tool call, the proxy restores the original `name` and `namespace` before emitting Responses events back to Codex.

The mapping is request-scoped protocol context. It is not persisted in model configuration and does not guess a namespace from the returned tool name. Tools with the same child name in different namespaces therefore continue to route to the correct executor.

### On-Demand App Tool Expansion

Wework must not inject the complete schemas of every App and browser child tool into the first model request of a new conversation. The Codex launch configuration enables Remote Apps and `tool_search`; the model searches for a required namespace first, and only tools returned by that search are added to later model requests:

- Responses models with native Codex `tool_search` and namespace-tool support use the native protocol without redundant executor conversion.
- For models using OpenAI Chat Completions, Anthropic Messages, or another protocol without namespace tools, the executor expands only namespaces matched by the current `tool_search` result. Tools from unmatched Apps must not enter the request.
- The executor converts the active tool list, historical tool calls, tool results, and explicit `tool_choice` together, then restores the original namespace identity before returning events to Codex.
- An ordinary message carries only the compact `tool_search` entry point. Adding Apps or browser tools must not make the initial request grow linearly with all tool schemas.

Protocol-conversion E2E coverage must include Responses, Chat Completions, and Anthropic Messages. It verifies that the initial request contains no expanded namespace, only searched tools appear afterward, tool calls and results round-trip, and the initial serialized tool payload stays under a fixed size limit.

## Security Benefits

- The Wework desktop client and local executor never receive the real provider `api_key`.
- The model proxy uses the same authentication and expiration policy as other backend APIs.
- Real provider credentials remain in backend memory and the database only.

## Related Implementation

- The executor Codex compatibility proxy puts the login token in the backend request's `Authorization: Bearer` header.
- The backend resolves models by complete resource identity so same-named personal, public, and group models cannot use one another's configuration.
- Wework uses the same direct proxy config for task creation, follow-up messages, and rollback without a separate model-config resolution request.

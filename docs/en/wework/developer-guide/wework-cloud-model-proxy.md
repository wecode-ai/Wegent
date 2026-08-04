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

#### Kimi K3 Chat Completions Compatibility

When a cloud Model CRD uses OpenAI Chat Completions and its provider model name contains the case-insensitive substring `kimi-k3`, such as `moonshot-kimi-k3`, Wework automatically selects the `wework-kimi-k3` Codex model catalog with a 1,048,576-token context window if the Model CRD does not configure `codex_catalog_model_id` or `codexCatalogModelId`. An explicitly configured catalog always takes precedence over automatic Kimi K3 selection. Codex continues to use the Responses protocol internally, while the executor translates requests to Chat Completions at the boundary and applies the following Kimi K3 compatibility behavior:

- It sends Kimi's supported `thinking` field instead of the generic `reasoning_effort` field.
- It preserves `reasoning_content` across multi-turn messages and tool calls.
- It preserves namespace tool identity through a reversible mapping so same-named tools still route to the correct executor.

An explicit Anthropic Messages configuration is never overridden. Operators must select OpenAI Chat Completions in the Model CRD through `protocol` or `apiFormat`. Leaving only `env.model=claude` without protocol metadata continues to route requests as Anthropic Messages to `/v1/messages`.

When a task runs on a cloud or remote device, the model selector also shows local models configured on the current desktop. On first use or after a configuration change, Wework asks for confirmation, synchronizes the custom Codex model catalog to the target Executor, restarts its Codex app-server while the device is idle, verifies that the model was loaded, and only then sends the task. Built-in Codex models and cloud Model CRDs continue to work directly with either local or cloud execution.

### Model Rate-Limit Retries

When the upstream has not started a response stream and the model service returns HTTP `429 Too Many Requests`, the executor Codex compatibility proxy automatically resends the same model request. It retries at most five times, waiting 1, 5, 10, 30, and 60 seconds between attempts.

If the upstream returns a standard `Retry-After` header, the proxy uses that delay instead, capped at 60 seconds for one wait. Non-429 responses do not activate this policy. After the retry budget is exhausted, the proxy returns the final 429 status and error body to Codex. A stream that has already started is never replayed by this mechanism, preventing duplicate generation or tool execution.

### Anthropic Empty-Output Recovery

Some Anthropic Messages-compatible services may return a stop reason and positive `output_tokens` in `message_delta` without sending any text, thinking content, or tool call. The executor Codex compatibility proxy converts this incomplete response into a failure event instead of incorrectly emitting a successful completion. Codex can then retry the current model request through its stream-error recovery path, preventing Wework from ending the task without an assistant response.

This check activates only when no model output has been observed. Responses that already produced text, thinking content, or a tool call are not replayed, and valid connection-prewarm responses with zero `output_tokens` remain unaffected.

### Namespace Tool Compatibility

Codex can group child tools under a `type: "namespace"` tool when it sends an OpenAI Responses request. OpenAI Chat Completions and Anthropic Messages have no equivalent namespace field, so the executor Codex compatibility proxy applies a reversible mapping at the protocol boundary:

1. During request conversion, child tools are expanded into ordinary Chat or Anthropic function tools. A unique child keeps its original name; collisions receive a stable alias containing the namespace.
2. Aliases use only characters accepted by Chat function names and are limited to 64 bytes. Longer names are truncated with a stable hash.
3. Historical tool calls and an explicit `tool_choice` use the same mapping so tool identity remains stable across turns.
4. When the upstream returns a flat tool call, the proxy restores the original `name` and `namespace` before emitting Responses events back to Codex.

The mapping is request-scoped protocol context. It is not persisted in model configuration and does not guess a namespace from the returned tool name. Tools with the same child name in different namespaces therefore continue to route to the correct executor.

## Security Benefits

- The Wework desktop client and local executor never receive the real provider `api_key`.
- The model proxy uses the same authentication and expiration policy as other backend APIs.
- Real provider credentials remain in backend memory and the database only.

## Related Implementation

- The executor Codex compatibility proxy puts the login token in the backend request's `Authorization: Bearer` header.
- The backend resolves models by complete resource identity so same-named personal, public, and group models cannot use one another's configuration.
- Wework uses the same direct proxy config for task creation, follow-up messages, and rollback without a separate model-config resolution request.

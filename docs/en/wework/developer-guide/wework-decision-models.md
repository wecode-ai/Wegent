---
sidebar_position: 36
---

# Decision Models and the Decision Workbench

## Configuration and Access

Decision models use the existing `kind: Model` resource and model management
CRUD. Users manage personal/team models; administrators publish public models.
Choose the Decision Model category and either SystemOne or OpenAI Decisions in
the user form. Public model JSON uses the same fields.

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: decision-systemone
  namespace: default
  displayName: SystemOne Decisions
spec:
  modelType: decision
  protocol: systemone
  isWeworkAvailable: true
  modelConfig:
    env:
      model: systemone
      model_id: jev-latest
      base_url: https://api.typesafe.ai/v1
      api_key: <provider-api-key>
status:
  state: Available
```

For OpenAI, set `protocol: openai`, `env.model: openai`, and the provider's model
ID and HTTPS API address. Do not set the chat-only `apiFormat` on decision models.
`base_url` accepts an origin, an API base ending in `/v1`, or the complete
matching endpoint. SystemOne uses `/v1/systemone`; OpenAI uses `/v1/decisions`.
Mismatched endpoints and URLs containing credentials, queries or fragments
are rejected.

API keys use the existing Model credential and placeholder mechanism and are
resolved/decrypted only during backend execution. Never put real credentials
in source code or Smart App environment variables.

### Deployment Credential Extension

`app.services.model_credential_service` exposes a shared extension point:

- Register an asynchronous resolver at startup with
  `register_model_api_key_resolver(resolver)`.
- Its signature is `async def resolver(template: str, current_user: User) -> str | None`.
- The original placeholder template is preserved even if a same-name global
  environment variable has already been processed.
- `current_user` is the authenticated caller, not the owner of a public/shared Model.
- Return `None` for an unhandled template to preserve ordinary Model resolution.
- A handled template must produce a usable key. Empty results, exceptions and
  timeouts block forwarding without falling back to a global key.

LLM forwarding and decision execution share this entry. Connection checks accept
only caller-supplied literal keys; they resolve no server placeholders and do
not invoke deployment credential resolvers.
Decision execution requires a nonempty key and applies a Python 3.10-compatible
30-second total deadline including credential lookup and the provider request.
Credential resolution is bounded to 30 seconds, does not cache user keys and
never updates the stored Model. Catalog reads do not resolve credentials.

The default hybrid gateway selects the Rust implementations of `GET` and
`POST /api/models/decisions` through `backend-rs/config/routes.toml`. Rust reuses
unified model visibility and authorization, reading the catalog and Model
configuration again for every execution. Deployments register the existing
`LlmProxyCredentials` implementation through `AppState.llm_proxy_credentials`,
shared with the Rust LLM proxy. Resolution receives the original template and
authenticated caller; failures or invalid keys block execution. Rust also
caches no credentials, follows no redirects, retries no provider requests, and
limits each request and response to 1 MiB. The Python implementation and tests
remain the compatibility reference.
Deployment-specific endpoints, authentication and user-key lookup implementations
belong to the deployment extension, not the open-source code.

Public model visibility and user whitelists remain enforced. Only decision
models with `isWeworkAvailable: true` enter the workbench catalog. Decision
models are excluded from Shell chat model lists.

## Request Flow

```text
Smart App (decisionModel capability)
  -> Executor loopback route + opaque route token
  -> Wegent backend (current user login)
  -> decision provider configured by the Model CRD
```

The Executor no longer reads `WEWORK_DECISION_PROXY_UPSTREAM_URL` or
`WEWORK_DECISION_PROXY_DEFAULT_MODEL`, or maintains a dedicated provider-key
exchange cache. Provider configuration and credentials belong exclusively to
the backend, which must be able to reach the configured services.

The existing local route remains protocol version 1:

- `GET {WEWORK_DECISION_ROUTER_BASE_URL}/status` reads the live catalog.
- `POST {WEWORK_DECISION_ROUTER_BASE_URL}/v1/decisions` evaluates a decision.
- Both use the local marker `Authorization: Bearer wework-local-router`.
- Direct backend clients use `GET` and `POST /api/models/decisions` with Wegent
  authentication, not the local marker.

```json
{
  "protocolVersion": 1,
  "defaultModel": "<catalog-model-id>",
  "models": [
    {
      "id": "<catalog-model-id>",
      "displayName": "SystemOne Decisions",
      "modelId": "jev-latest",
      "protocol": "systemone",
      "type": "public",
      "namespace": "default"
    }
  ]
}
```

Display `displayName` in the selector and send the selected `id`, not `modelId`.
Do not construct IDs. Catalog IDs include source, namespace, owner and name,
distinguishing identically named personal/public resources. They are not
credentials. IDs remain stable across configuration updates; every execution
rereads configuration and permissions.

An empty catalog returns `models: []` and `defaultModel: ""`. Keep selection and
refresh controls available, but block execution until a model is selected.
Catalog and evaluation responses use `Cache-Control: no-store`.

## Unified Evaluation Contract

Smart Apps keep SystemOne-shaped `state` and named `questions` across providers:

```json
{
  "model": "<selected-catalog-model-id>",
  "state": { "comment": "Payments keep failing" },
  "questions": {
    "urgent": {
      "type": "noul",
      "instructions": "Is urgent intervention needed?"
    },
    "department": {
      "type": "choice",
      "instructions": "Which department should handle this?",
      "criteria": {
        "billing": "Payment issues",
        "technical": "System failures"
      }
    },
    "severity": {
      "type": "score",
      "instructions": "How severe is the issue?",
      "criteria": ["Minor", "Workaround available", "Fully blocked"]
    }
  }
}
```

SystemOne receives structured state, instructions and criteria unchanged.
For OpenAI, structured state/instructions become JSON text, `noul` becomes
`predicate`, named questions become an array with `name`, and choice/score
criteria become choices/levels.

Answers are normalized into a named map: predicate probability becomes noul,
probability arrays become maps, and score legends are rebuilt from the original
rubric. OpenAI refusals remain `{"type": "refusal"}` and must be handled by
clients. This unified interface accepts text or structured JSON, not native
OpenAI image inputs.

Requests and responses are limited to 1 MiB, with at most 20 questions.
Choices support 1-255 options and scores support 2-10 levels. Invalid questions,
missing/duplicate answers and invalid numbers fail explicitly. The gateway
does not switch protocols, fall back to chat models or execute a different model.

Deleted, disabled, hidden or unauthorized models return `model_not_found` for
old selections. Refresh the catalog and require a new selection. Provider
failures expose only static messages and request IDs, never provider error
bodies, debug data or credentials.

## Migration

1. Create a decision Model with its protocol, endpoint, model ID and credentials.
2. Enable Wework availability and verify public visibility/whitelists.
3. Deploy both backend and Executor, then refresh the workbench catalog.
4. Remove the two old decision environment variables and do not embed them in
   branded installer configuration.

Protocol references: [TypeSafe API](https://docs.typesafe.ai/api) and
[OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions).

---
sidebar_position: 11
---

# AI-Operated CLI Design

## Goal

Replace the existing `wegent-cli` implementation with a new CLI that lets AI agents and scripts operate Wegent reliably while still offering a thin conversational entry point for humans.

The new CLI keeps the `wegent` executable name, but rebuilds the module around deterministic command behavior:

- stable JSON input and output for automation
- explicit exit codes
- no hidden prompts in machine-oriented commands
- direct alignment with the current Backend API
- a lightweight `ask` wrapper around `/api/v1/responses`

## Current State

`wegent-cli` is currently a standalone Python package using Click, Requests, and PyYAML. It exposes kubectl-style commands such as `get`, `apply`, `create`, `delete`, `describe`, `config`, and `login`.

The package is mostly isolated from the rest of the repository. Repository-wide references are limited to its own README and tests, so replacing the CLI is a contained change. The existing client already targets the Backend CRD API shape under `/api/v1/namespaces/{namespace}/{kinds}`, but parts of the command behavior are outdated. For example, batch apply/delete output parsing expects legacy `created` and `updated` arrays while Backend currently returns a `BatchResponse` with `results`.

## Design Principles

1. Machine commands are the foundation. They must be safe for AI agents to call without parsing human prose.
2. Conversational commands are thin wrappers. The CLI does not interpret natural language.
3. Backend owns behavior. The CLI should not duplicate Wegent business rules.
4. Output contracts are stable. Every automation-facing command returns a predictable envelope in JSON mode.
5. The first implementation should be narrow enough to test thoroughly.

## Command Model

The rebuilt CLI will have four command groups.

### `wegent kind`

Resource management through the CRD API.

```bash
wegent kind get <kind> [name] --namespace default --json
wegent kind describe <kind> <name> --namespace default --json
wegent kind apply --file resource.yaml --json
wegent kind apply --input - --json
wegent kind delete <kind> <name> --namespace default --json
wegent kind delete --input - --json
```

This replaces the old top-level `get`, `apply`, `delete`, and `describe` commands. The old commands are not preserved as compatibility shims.

### `wegent task`

Task object management through existing task endpoints.

```bash
wegent task create --input - --json
wegent task status <task_id> --json
wegent task status <task_id> --runtime --json
wegent task result <task_id> --json
wegent task cancel <task_id> --json
```

`task status` uses `/api/tasks/{task_id}` for full task detail by default and `/api/tasks/{task_id}/runtime-check` when `--runtime` is provided. `task result` extracts task detail and message/subtask results into a stable automation-friendly response.

Task execution and follow-up conversation are handled by `response` and `ask`, not by adding a second execution protocol to `task`.

### `wegent response`

Direct wrapper around the OpenAI-compatible Responses API.

```bash
wegent response create --model default#wegent-chat --input - --json
wegent response get resp_123 --json
wegent response cancel resp_123 --json
wegent response delete resp_123 --json
```

`response create` sends the request body to `POST /api/v1/responses`. It passes through non-streaming options such as `background`, `previous_response_id`, `tools`, `reasoning`, `attachment_ids`, and Wegent-specific fields through JSON input. Payloads with `"stream": true` are rejected with `unsupported_streaming` until the CLI has an explicit server-sent events output mode.

### `wegent ask`

Convenience wrapper around `response create`.

```bash
wegent ask "help me list available agents"
wegent ask "help me list available agents" --model default#my-agent
wegent ask "help me list available agents" --mode chat
wegent ask "help me list available agents" --mode task --json
wegent ask "help me list available agents" --no-tools
```

`ask` does not parse intent locally. It builds a Responses API request with the prompt as `input` and sends it to Backend.

Model selection rules:

1. If `--model` is provided, pass it through unchanged.
2. If `--model` is omitted, call `GET /api/users/default-teams`.
3. Select the default team matching `--mode`; default mode is `chat`.
4. Convert `{ "name": "wegent-chat", "namespace": "default" }` to `default#wegent-chat`.
5. If no default team is configured for the requested mode, return a structured error.

API key authentication is valid for explicit-model Responses API calls. `ask` without `--model` requires a Bearer token because `/api/users/default-teams` uses user authentication.

By default, `ask` includes:

```json
[{ "type": "wegent_chat_bot" }]
```

`--no-tools` omits this default tools array.

## Configuration

The CLI uses the same local config location:

```text
~/.wegent/config.yaml
```

Supported config keys:

- `server`: Backend base URL, default `http://localhost:8000`
- `token`: Bearer token
- `api_key`: optional API key for `/api/v1/responses`
- `namespace`: default namespace for `kind` commands
- `mode`: default `ask` mode, default `chat`

Environment variables override file configuration:

- `WEGENT_SERVER`
- `WEGENT_TOKEN`
- `WEGENT_API_KEY`
- `WEGENT_NAMESPACE`
- `WEGENT_MODE`

Authentication headers:

- Use `Authorization: Bearer <token>` when `token` is configured.
- Use `X-API-Key: <api_key>` when `api_key` is configured and no token is configured.
- If both are configured, prefer Bearer token for consistency with current CLI login behavior.
- If only an API key is configured, `ask` must include `--model` so it can skip default team lookup.

## JSON Protocol

All automation-facing commands support `--json`. Commands that accept structured input support `--input -` to read JSON from stdin.

Success envelope:

```json
{
  "success": true,
  "data": {}
}
```

Error envelope:

```json
{
  "success": false,
  "error": {
    "code": "default_team_not_configured",
    "message": "No default team is configured for mode 'chat'.",
    "details": {}
  }
}
```

Exit code rules:

- `0`: success
- `1`: validation or command usage error
- `2`: authentication or authorization error
- `3`: Backend API error
- `4`: network or timeout error

## Backend API Mapping

| CLI capability | Backend endpoint |
| --- | --- |
| Kind list/get/create/update/delete | `/api/v1/namespaces/{namespace}/{kinds}` |
| Kind batch apply/delete | `/api/v1/namespaces/{namespace}/apply`, `/api/v1/namespaces/{namespace}/delete` |
| Default team lookup | `/api/users/default-teams` |
| Task create/detail/update/cancel | `/api/tasks/*` |
| Task runtime status | `/api/tasks/{task_id}/runtime-check` |
| Response create/get/cancel/delete | `/api/v1/responses/*` |

The CLI should keep endpoint paths in one client module so command modules do not assemble URLs directly.

## Package Structure

The old `wegent-cli/wegent` module should be replaced with focused modules:

```text
wegent-cli/wegent/
├── cli.py
├── client.py
├── config.py
├── errors.py
├── io.py
├── models.py
├── output.py
└── commands/
    ├── ask.py
    ├── config.py
    ├── kind.py
    ├── login.py
    ├── response.py
    └── task.py
```

Responsibilities:

- `client.py`: HTTP transport, auth headers, timeout handling, API error normalization.
- `errors.py`: shared error types and exit code mapping.
- `io.py`: stdin/file JSON/YAML loading and validation helpers.
- `output.py`: JSON envelope and optional human-readable rendering.
- `commands/*`: Click command definitions only; business behavior delegates to client/helpers.

## Non-Goals

The first implementation will not:

- add a local natural language parser
- add compatibility shims for old top-level `get/apply/delete/describe`
- implement rich terminal UI, spinners, or color-heavy formatting
- add local MCP servers
- change Backend behavior unless a CLI-facing endpoint is missing or broken

## Testing

Use test-first implementation for the new behavior.

Required test coverage:

- config precedence between defaults, config file, and environment variables
- auth header selection for Bearer token and API key
- stable JSON success and error envelopes
- default team resolution for `ask`
- `ask --model` bypassing default team lookup
- `ask --no-tools` omitting default `wegent_chat_bot`
- `kind apply --input -` and `kind delete --input -`
- `response create/get/cancel/delete` endpoint mapping
- task status/result endpoint mapping
- network, timeout, 401/403, and Backend error normalization

Integration tests should remain opt-in and must not silently skip real failures when explicitly requested.

## Rollout

1. Replace old CLI tests with tests for the new command contract.
2. Rebuild the Python package modules around the new command groups.
3. Update `wegent-cli/README.md` with AI-agent usage examples first, human examples second.
4. Run the `wegent-cli` test suite.
5. Keep unrelated repository modules unchanged unless a Backend endpoint bug blocks the CLI contract.

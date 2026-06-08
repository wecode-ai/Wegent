# wegent CLI

`wegent` gives agents and scripts AI-friendly command line access to a Wegent
backend. It is designed for predictable automation: commands accept structured
input, return structured output, and map failures to stable exit codes.

## Install

From this repository:

```bash
cd wegent-cli
pip install -e .
```

Or install the runtime dependencies and run the module directly:

```bash
cd wegent-cli
pip install -r requirements.txt
python -m wegent.cli --help
```

## Configure

The CLI reads configuration from flags, saved config, and environment variables.
Environment variables are the easiest option for AI-operated shells:

```bash
export WEGENT_SERVER=http://localhost:8000
export WEGENT_TOKEN=your-bearer-token
export WEGENT_NAMESPACE=default
export WEGENT_MODE=task
```

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `WEGENT_SERVER` | Backend server URL, for example `http://localhost:8000` |
| `WEGENT_TOKEN` | Bearer token for authenticated requests |
| `WEGENT_API_KEY` | API key for authenticated requests |
| `WEGENT_NAMESPACE` | Default namespace for `kind` commands |
| `WEGENT_MODE` | Default team mode used by `ask` when `--mode` is omitted |

When both `WEGENT_TOKEN` and `WEGENT_API_KEY` are set, the Bearer token is
preferred and sent as `Authorization: Bearer ...`.
API key authentication can call `/api/v1/responses` when the model is explicit.
`ask` without `--model` reads the default team endpoint, which requires a
Bearer token.

You can also save common settings:

```bash
wegent config set server http://localhost:8000
wegent config set namespace default
wegent config set token your-bearer-token
wegent config view --json
```

## Output Contract

Use `--json` for stable machine-readable output. Successful commands return:

```json
{
  "success": true,
  "data": {}
}
```

Failures return:

```json
{
  "success": false,
  "error": {
    "code": "api_error",
    "message": "Backend error message",
    "details": {}
  }
}
```

Without `--json`, commands emit YAML or assistant text for human inspection.

## Ask

`ask` sends the prompt to the backend Responses API at `/api/v1/responses`.
The CLI does not parse natural language locally.

```bash
wegent ask "Summarize the current task status" --json
wegent ask "Ping the default coding agent" --mode task --json
wegent ask "Use this exact model" --model default#coding-agent --no-tools --json
```

When `--model` is omitted, `ask` reads `/api/users/default-teams`, selects the
default team for `--mode` or `WEGENT_MODE`, and sends the model as
`namespace#team`. By default, `ask` includes Wegent chat tools; pass
`--no-tools` to omit them.

If you authenticate with only `WEGENT_API_KEY`, pass `--model` explicitly:

```bash
wegent ask "Summarize the current task status" --model default#coding-agent --json
```

## Responses API

Create a response from a JSON or YAML file:

```bash
cat > response.json <<'JSON'
{
  "model": "default#coding-agent",
  "input": "Explain the latest task result"
}
JSON

wegent response create --input response.json --json
wegent response create --input response.json --model default#review-agent --json
```

Structured payload fields are passed through to the backend, except
`"stream": true`. Streaming responses are currently rejected with
`unsupported_streaming` because this CLI command emits stable JSON/YAML
responses, not server-sent events.

Manage responses by id:

```bash
wegent response get resp_123 --json
wegent response cancel resp_123 --json
wegent response delete resp_123 --json
```

## Kinds

`kind` commands manage Wegent CRD resources such as `Ghost`, `Model`, `Shell`,
`Bot`, `Team`, `Workspace`, and `Task`.

```bash
wegent kind get team -n default --json
wegent kind get team coding-agent -n default --json
wegent kind describe team coding-agent -n default --json
```

Apply resources from JSON, YAML, or stdin:

```bash
wegent kind apply --file team.yaml --json
cat team.yaml | wegent kind apply --input - --json
```

Delete a named resource or resources from structured input:

```bash
wegent kind delete team coding-agent -n default --json
wegent kind delete --input obsolete-resources.yaml --json
```

## Tasks

Create a task with a backend task payload. Payloads with `team_id` are valid:

```bash
cat > task.json <<'JSON'
{
  "title": "Review repository status",
  "prompt": "Check the repo and summarize pending changes.",
  "team_id": 42
}
JSON

wegent task create --input task.json --json
```

Inspect and manage tasks:

```bash
wegent task status 123 --json
wegent task status 123 --runtime --json
wegent task result 123 --json
wegent task cancel 123 --json
```

`task result` returns assistant messages extracted from the task data along with
the raw task payload.

## Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Validation or usage error |
| `2` | Authentication or authorization error |
| `3` | Backend API error |
| `4` | Network error or timeout |

## Integration Smoke Test

Integration tests are opt-in because they require a running Wegent backend.
`WEGENT_TEST_SERVER` is required. `WEGENT_TEST_TOKEN` is optional and only
needed for backends that require authentication:

```bash
cd wegent-cli
WEGENT_TEST_SERVER=http://localhost:8000 pytest tests/test_integration.py --integration -m integration
```

## License

Apache License 2.0

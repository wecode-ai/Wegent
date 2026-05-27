---
sidebar_position: 18
---

# Local Device Command RPC

Local device command RPC lets the Backend send a preconfigured shell command to a specific online local executor device and wait for the completed result. It is intended for operational checks, workspace diagnostics, and backend-initiated probes. It does not participate in the Task/Subtask lifecycle and does not create chat messages.

## Architecture

The communication path is:

1. The API caller sends a `command_key`.
2. Backend resolves the real shell command from `LOCAL_DEVICE_COMMANDS`.
3. Backend reads the target device Socket.IO `socket_id` from Redis online device state.
4. Backend calls `device:execute_command` in the `/local-executor` namespace.
5. The local executor `CommandHandler` executes the command on the local machine.
6. The executor returns the completed result as the Socket.IO ack.
7. Backend optionally post-processes the result according to the command definition's `post_processor`.

This RPC is decoupled from `task:execute`, so it is suitable for short commands and one-shot diagnostics. Long-running interactive terminals and streaming stdout/stderr are outside the first version.

## API

Request:

```http
POST /api/devices/{device_id}/commands
```

Body:

```json
{
  "command_key": "repo_status",
  "path": "/optional/path",
  "args": ["--short"],
  "env": {
    "KEY": "VALUE"
  },
  "timeout_seconds": 60,
  "max_output_bytes": 1048576
}
```

Response:

```json
{
  "success": true,
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "duration": 0.42,
  "timed_out": false,
  "stdout_truncated": false,
  "stderr_truncated": false
}
```

When command startup fails, the command exits non-zero, or the command times out, `success` is `false`. Timeout results include `timed_out=true` and `error`.

`path` is the command execution directory. `cwd` remains as a backward-compatible alias; when both are provided, `path` wins. `args` is an array appended after the configured command and is not concatenated into a shell string. For example, `command_key=ls_a`, `path=/repo`, and `args=["backend"]` executes `["ls", "-a", "backend"]` in `/repo`.

## Security And Limits

This feature follows a trusted Backend and restricted API model. The HTTP API does not accept raw commands; it accepts only configured keys. The real command must be configured by the Backend through the command registry or `LOCAL_DEVICE_COMMANDS`. The `pwd`, `ls_a`, `list_directories`, and `git_clone` command keys are built in by default. `ls_a` uses the `file_list` post processor to filter `.` and `..` and return a file name array in `stdout`; `list_directories` uses the `directory_list` post processor to return only directory names under the current path in `stdout`. To add a built-in command, add one entry to `DEFAULT_LOCAL_DEVICE_COMMANDS` in `backend/app/services/device/command_registry.py`.

At runtime, add or override command definitions with a single environment variable. Simple commands can use string values; commands that need post processing can use object values:

```bash
LOCAL_DEVICE_COMMANDS='{"repo_status":"git status","repo_files":{"command":"ls -a","post_processor":"file_list"}}'
```

Pass `git_clone` parameters through `args`, for example:

```json
{
  "command_key": "git_clone",
  "path": "/Users/yunpeng7/AIGCWorkSpace",
  "args": ["https://github.com/wecode-ai/Wegent.git", "Wegent"]
}
```

Default protections are:

- Only devices owned by the current user and currently online can be called.
- The API can execute only command keys present in `LOCAL_DEVICE_COMMANDS`.
- Command results can use only Backend-registered post processors; API callers cannot pass arbitrary post processor functions.
- Default timeout is 60 seconds, capped at 600 seconds.
- stdout and stderr are each capped at 1 MiB by default and 5 MiB maximum.
- Backend and executor logs include command, device, duration, and exit code metadata.

Because commands run on the user's machine, callers must treat this API as high privilege and avoid exposing it to untrusted entry points.

## Executor Behavior

The local executor prefers Backend-provided `argv`; it falls back to the system shell only when `argv` is missing. If `path`/`cwd` is empty, the executor uses its current working directory. `env` is merged into the current process environment. On timeout, the executor terminates the command process group and returns a timeout result.

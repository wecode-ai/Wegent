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

This RPC is decoupled from `task:execute`, so it is suitable for short commands and one-shot diagnostics. Long-running interactive terminals and streaming stdout/stderr are not carried by this RPC. The macOS WeWork App embeds local project terminals through a Tauri local PTY, as described in "macOS App Local Terminal" below.

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

This feature follows a trusted Backend and restricted API model. The HTTP API does not accept raw commands; it accepts only configured keys. The real command must be configured by the Backend through the command registry or `LOCAL_DEVICE_COMMANDS`. The `pwd`, `home_dir`, `project_workspace_root`, `ls_a`, `ls_dirs`, `workspace_tree`, `workspace_read_text_file`, `project_folder_status`, `mkdir_p`, `path_exists`, `git_*`, `ls_skills`, `codex_threads_list`, `setup_shared_skills`, `open_terminal`, `sync_runtime_auth_file`, `read_runtime_auth_file`, `turn_file_changes_review`, and `turn_file_changes_revert` command keys are built in by default. `ls_a` uses the `file_list` post processor to filter `.` and `..` and return a file name array in `stdout`; `ls_dirs` uses the `directory_list` post processor to return only subdirectory names in the current directory. Workspace, runtime auth, Codex thread, and turn file changes commands use the `json` post processor for structured output. `open_terminal` starts the system terminal window on local devices with a graphical session; it is a one-shot launch command and does not provide streaming terminal interaction. To add a built-in command, add one entry to `DEFAULT_LOCAL_DEVICE_COMMANDS` in `backend/app/services/device/command_registry.py`.

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

### Turn File Changes Commands

`turn_file_changes_review` and `turn_file_changes_revert` accept only artifact ids in the form `turn-file-changes/<taskId>/<subtaskId>`. For runtime LocalTasks that do not have a central task row, `taskId` may be `0`. Both path segments must still contain only digits, and the command script uses a full regular-expression match to reject path traversal. The command reads `$WEGENT_EXECUTOR_HOME/artifacts/<artifactId>/metadata.json` and `changes.patch.gz`, verifies the workspace and patch checksum from metadata, and only then returns the diff or attempts a safe revert.

Callers should bind these commands to the current LocalTask's `deviceId + workspacePath`, not to the central Task API. This keeps review and revert on the same device and workspace that produced the artifact even when the runtime task has no `TaskResource`/`Subtask` rows.

### Workspace File Command Roots

`workspace_tree` and `workspace_read_text_file` reject any path outside an allowed workspace root. The Backend derives the allowed roots per request (never trusting a client-supplied `WEGENT_WORKSPACE_ROOTS`) from two sources for the user and device: WeWork projects whose workspace `source` is `local_path`, and runtime `DeviceWorkspace` mappings. The latter lets runtime-local tasks browse and preview files in their own workspace even when no `local_path` project points at that directory.

## Executor Behavior

The local executor prefers Backend-provided `argv`; it falls back to the system shell only when `argv` is missing. If `path`/`cwd` is empty, the executor uses its current working directory. `env` is merged into the current process environment. On timeout, the executor terminates the command process group and returns a timeout result.

## macOS App Local Terminal

When the WeWork macOS App opens a project that is bound to a local executor on the same Mac, it can embed a local terminal in the workspace panel. The App creates a local PTY through Tauri commands and renders the input/output stream with the frontend `xterm` component; it does not use the `/devices/{device_id}/commands` RPC.

Enablement rules:

- The runtime must be the macOS Tauri App. Regular browsers and the iOS App do not enable this path.
- The project device must be a local Claude Code device.
- The App and executor must correspond to the same backend. The frontend passes the current `apiBaseUrl` to the native layer; the native layer first scans running `wegent-executor` processes and matches their `WEGENT_BACKEND_URL`.
- If no matching process is found, the native layer falls back to local configuration files such as `WEGENT_EXECUTOR_HOME`, `~/.wecode/wegent-executor/device-config.json`, and `~/.wegent-executor/device-config.json`.
- For project terminals, an existing current task execution workspace path or project `localPath` on the current Mac is also accepted as a same-machine signal. This handles cases where multiple executor config files are temporarily out of sync. The same path is passed as the Tauri PTY `cwd` when the terminal starts.

This check intentionally does not use IP or MAC addresses. IPs can be duplicated or distorted by proxies, VPNs, container networks, and loopback routing. MAC addresses can also be unstable because of permissions, virtual interfaces, and privacy behavior. Matching a running executor process to the backend URL is closer to the executor connection that the App is actually using.

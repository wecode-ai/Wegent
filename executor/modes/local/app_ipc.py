# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Newline-delimited JSON-RPC bridge between WeWork and the local executor."""

from __future__ import annotations

import asyncio
import json
import shlex
import sys
from dataclasses import dataclass
from typing import Any, TextIO

from executor.modes.local.command_handler import CommandHandler
from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler
from shared.logger import setup_logger

logger = setup_logger("local_app_ipc")

DEFAULT_DEVICE_ID = "local-device"
DEFAULT_TIMEOUT_SECONDS = 60
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024


class AppIpcError(RuntimeError):
    """Raised when an app IPC request cannot be handled."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class LocalAppCommandDefinition:
    """Executor-side command definition for app-originated device commands."""

    command: str
    post_processor: str | None = None


LOCAL_APP_COMMANDS: dict[str, LocalAppCommandDefinition] = {
    "pwd": LocalAppCommandDefinition(command="pwd"),
    "home_dir": LocalAppCommandDefinition(command="printenv HOME"),
    "project_workspace_root": LocalAppCommandDefinition(
        command=(
            "sh -c "
            "'printf %s "
            '"${WEGENT_EXECUTOR_PROJECTS_DIR:-${WECODE_HOME:-$HOME/.wecode}/wegent-executor/workspace/projects}"\''
        )
    ),
    "ls_dirs": LocalAppCommandDefinition(
        command="ls -a -p",
        post_processor="directory_list",
    ),
    "mkdir_p": LocalAppCommandDefinition(command="mkdir -p"),
    "path_exists": LocalAppCommandDefinition(command="test -e"),
    "ls_skills": LocalAppCommandDefinition(
        command="python3 -c 'import json; print(json.dumps([]))'",
        post_processor="json",
    ),
}


class AppIpcServer:
    """Serve app-originated JSON-RPC requests over stdin/stdout."""

    def __init__(
        self,
        *,
        input_stream: TextIO | None = None,
        output: TextIO | None = None,
        runtime_work_handler: Any | None = None,
        command_handler: CommandHandler | None = None,
        device_id: str = DEFAULT_DEVICE_ID,
    ) -> None:
        self.input_stream = input_stream or sys.stdin
        self.output = output or sys.stdout
        self.runtime_work_handler = runtime_work_handler
        self.command_handler = command_handler or CommandHandler()
        self.device_id = device_id or DEFAULT_DEVICE_ID
        self._write_lock = asyncio.Lock()
        self._running = False

    async def serve(self) -> None:
        """Read request lines until stdin closes."""
        self._running = True
        await self.emit_event(
            "executor.ready",
            {"device_id": self.device_id, "ready": True},
        )
        while self._running:
            line = await asyncio.to_thread(self.input_stream.readline)
            if line == "":
                break
            await self.handle_line(line)

    def stop(self) -> None:
        """Stop the request loop after the current line is processed."""
        self._running = False

    async def handle_line(self, line: str) -> None:
        """Parse and dispatch one newline-delimited app IPC message."""
        if not line.strip():
            return

        request_id: str | None = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise AppIpcError("invalid_request", "Request must be a JSON object")

            request_id = self._request_id(message)
            if message.get("type") != "request":
                raise AppIpcError("invalid_request", "Request type must be 'request'")

            method = message.get("method")
            if not isinstance(method, str) or not method.strip():
                raise AppIpcError("invalid_request", "Request method is required")

            params = message.get("params")
            if params is None:
                params = {}
            if not isinstance(params, dict):
                raise AppIpcError("invalid_request", "Request params must be an object")

            result = await self.dispatch(method.strip(), params)
            await self._write(
                {
                    "type": "response",
                    "id": request_id,
                    "ok": True,
                    "result": result,
                }
            )
        except AppIpcError as exc:
            await self._write_error(request_id, exc.code, exc.message)
        except json.JSONDecodeError as exc:
            await self._write_error(request_id, "invalid_json", str(exc))
        except Exception as exc:
            logger.exception("Unhandled app IPC request error")
            await self._write_error(request_id, "internal_error", str(exc))

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        """Dispatch one app IPC request to runtime work or device command handlers."""
        if method == "device.execute_command":
            return await self._handle_device_command(params)

        if method == "runtime.tasks.guidance":
            method = "runtime.tasks.send"

        if method.startswith("runtime."):
            if self.runtime_work_handler is None:
                raise AppIpcError(
                    "runtime_unavailable",
                    "Runtime work handler is not available",
                )
            return await self.runtime_work_handler.handle_runtime_rpc(
                {"method": method, "payload": params}
            )

        raise AppIpcError("unsupported_method", f"Unsupported app IPC method: {method}")

    async def emit_event(self, event: str, payload: dict[str, Any]) -> None:
        """Emit one app IPC event line."""
        normalized_payload = dict(payload)
        normalized_payload.setdefault("device_id", self.device_id)
        await self._write(
            {
                "type": "event",
                "event": event,
                "payload": normalized_payload,
            }
        )

    async def _handle_device_command(self, params: dict[str, Any]) -> dict[str, Any]:
        command_key = params.get("command_key")
        if not isinstance(command_key, str) or not command_key.strip():
            raise AppIpcError("bad_request", "command_key is required")

        command_definition = LOCAL_APP_COMMANDS.get(command_key.strip())
        if command_definition is None:
            raise AppIpcError(
                "unknown_command",
                f"Device command key '{command_key}' is not configured",
            )

        args = self._string_list(params.get("args"))
        command_payload = {
            "command": command_definition.command,
            "argv": self._build_argv(command_definition.command, args),
            "cwd": self._string_or_none(params.get("path"))
            or self._string_or_none(params.get("cwd")),
            "env": self._string_env(params.get("env")),
            "timeout_seconds": self._positive_number(
                params.get("timeout_seconds"),
                default=DEFAULT_TIMEOUT_SECONDS,
            ),
            "max_output_bytes": int(
                self._positive_number(
                    params.get("max_output_bytes"),
                    default=DEFAULT_MAX_OUTPUT_BYTES,
                )
            ),
        }
        result = await self.command_handler.handle_execute_command(command_payload)
        return self._apply_post_processor(result, command_definition.post_processor)

    def _request_id(self, message: dict[str, Any]) -> str:
        request_id = message.get("id")
        if not isinstance(request_id, str) or not request_id.strip():
            raise AppIpcError("invalid_request", "Request id is required")
        return request_id

    async def _write_error(
        self,
        request_id: str | None,
        code: str,
        message: str,
    ) -> None:
        await self._write(
            {
                "type": "response",
                "id": request_id,
                "ok": False,
                "error": {
                    "code": code,
                    "message": message,
                },
            }
        )

    async def _write(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        async with self._write_lock:
            self.output.write(line)
            self.output.flush()

    def _build_argv(self, command: str, args: list[str]) -> list[str]:
        argv = shlex.split(command)
        if not argv:
            raise AppIpcError("bad_command", "Command resolved to an empty argv")
        return [*argv, *args]

    def _string_list(self, value: Any) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list):
            raise AppIpcError("bad_request", "args must be a list")
        if not all(isinstance(item, str) for item in value):
            raise AppIpcError("bad_request", "args must contain only strings")
        return value

    def _string_env(self, value: Any) -> dict[str, str]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise AppIpcError("bad_request", "env must be an object")
        env: dict[str, str] = {}
        for key, item in value.items():
            if isinstance(key, str) and key:
                env[key] = "" if item is None else str(item)
        return env

    def _string_or_none(self, value: Any) -> str | None:
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value or None

    def _positive_number(self, value: Any, *, default: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return default
        return parsed if parsed > 0 else default

    def _apply_post_processor(
        self,
        result: dict[str, Any],
        processor_name: str | None,
    ) -> dict[str, Any]:
        if not processor_name:
            return result
        if processor_name == "file_list":
            return self._file_list_result(result)
        if processor_name == "directory_list":
            return self._directory_list_result(result)
        if processor_name == "json":
            return self._json_result(result)
        raise AppIpcError(
            "bad_command",
            f"Unknown local command post processor: {processor_name}",
        )

    def _file_list_result(self, result: dict[str, Any]) -> dict[str, Any]:
        if not result.get("success"):
            return result
        processed = dict(result)
        entries = [
            line.strip()
            for line in str(processed.get("stdout") or "").splitlines()
            if line.strip()
        ]
        processed["stdout"] = [entry for entry in entries if entry not in {".", ".."}]
        return processed

    def _directory_list_result(self, result: dict[str, Any]) -> dict[str, Any]:
        if not result.get("success"):
            return result
        processed = dict(result)
        entries = [
            line.strip()
            for line in str(processed.get("stdout") or "").splitlines()
            if line.strip()
        ]
        processed["stdout"] = [
            entry.rstrip("/")
            for entry in entries
            if entry.endswith("/") and entry.rstrip("/") not in {".", ".."}
        ]
        return processed

    def _json_result(self, result: dict[str, Any]) -> dict[str, Any]:
        processed = dict(result)
        if processed.get("stdout_truncated"):
            processed["success"] = False
            processed["error"] = (
                "Command output exceeded max_output_bytes and was truncated; "
                "JSON is incomplete and cannot be parsed"
            )
            return processed

        try:
            parsed_stdout = json.loads(str(processed.get("stdout") or ""))
        except json.JSONDecodeError as exc:
            if not processed.get("success"):
                return processed
            processed["success"] = False
            processed["error"] = f"Failed to parse command JSON output: {exc}"
            return processed

        processed["stdout"] = parsed_stdout
        if not processed.get("success") and isinstance(parsed_stdout, dict):
            error = parsed_stdout.get("error")
            if isinstance(error, str) and error.strip() and not processed.get("error"):
                processed["error"] = error
        return processed


async def run_app_ipc(device_id: str = DEFAULT_DEVICE_ID) -> None:
    """Run the standalone app IPC server without a Backend channel."""
    server = AppIpcServer(device_id=device_id)
    runtime_work_handler = RuntimeWorkRpcHandler(
        responses_event_emitter=server.emit_event,
    )
    server.runtime_work_handler = runtime_work_handler

    await runtime_work_handler.start_codex_watcher()
    try:
        await server.serve()
    finally:
        await runtime_work_handler.stop_codex_watcher()

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local app IPC socket server for WeWork and the local executor sidecar."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from executor.modes.local.command_handler import CommandHandler
from executor.version import get_version
from shared.logger import setup_logger

logger = setup_logger("local_app_ipc")

DEFAULT_DEVICE_ID = "local-device"
DEFAULT_SOCKET_NAME = "app-ipc.sock"
DEFAULT_LOCK_NAME = "app-ipc.lock"
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


def app_ipc_socket_path() -> Path:
    """Return the local executor app IPC socket path."""
    override = os.environ.get("WEGENT_EXECUTOR_APP_IPC_SOCKET", "").strip()
    if override:
        return Path(override).expanduser()

    from executor.config.config import WEGENT_EXECUTOR_HOME

    return Path(WEGENT_EXECUTOR_HOME).expanduser() / DEFAULT_SOCKET_NAME


class AppIpcServer:
    """Serve app-originated JSON-RPC requests over the local sidecar socket."""

    def __init__(
        self,
        *,
        socket_path: str | Path | None = None,
        runtime_work_handler: Any | None = None,
        command_handler: CommandHandler | None = None,
        device_id: str = DEFAULT_DEVICE_ID,
    ) -> None:
        self.socket_path = Path(socket_path) if socket_path else app_ipc_socket_path()
        self.runtime_work_handler = runtime_work_handler
        self.command_handler = command_handler or CommandHandler()
        self.device_id = device_id or DEFAULT_DEVICE_ID
        self._server: asyncio.AbstractServer | None = None
        self._clients: set[asyncio.StreamWriter] = set()
        self._clients_lock = asyncio.Lock()
        self._lock_file: Any | None = None
        self._socket_stat: os.stat_result | None = None
        self._runtime_handler_ready = asyncio.Event()
        if self.runtime_work_handler is not None:
            self._runtime_handler_ready.set()
        self._running = False

    def set_runtime_work_handler(self, runtime_work_handler: Any) -> None:
        """Attach the runtime work handler after socket startup."""
        self.runtime_work_handler = runtime_work_handler
        self._runtime_handler_ready.set()

    async def start(self) -> bool:
        """Start listening on the sidecar socket.

        Returns False when another executor already owns the singleton lock.
        """
        if not self._acquire_sidecar_lock():
            logger.info("Local app IPC sidecar socket is already running")
            return False

        try:
            self._running = True
            self._prepare_socket_path()
            self._server = await asyncio.start_unix_server(
                self._handle_client,
                path=str(self.socket_path),
            )
            os.chmod(self.socket_path, 0o600)
            with contextlib.suppress(OSError):
                self._socket_stat = self.socket_path.stat()
            logger.info(
                "Local app IPC sidecar socket listening on %s", self.socket_path
            )
            return True
        except Exception:
            self.stop()
            raise

    async def serve_forever(self) -> None:
        """Listen on the sidecar socket until cancelled or stopped."""
        if not await self.start():
            return
        await self.wait_serving()

    async def wait_serving(self) -> None:
        """Wait while the socket server accepts clients."""
        if self._server is None:
            return
        async with self._server:
            await self._server.serve_forever()

    def stop(self) -> None:
        """Stop accepting socket clients."""
        self._running = False
        if self._server is not None:
            self._server.close()
        self._remove_socket_path()
        self._release_sidecar_lock()

    async def wait_closed(self) -> None:
        """Wait for the socket server to close."""
        if self._server is not None:
            await self._server.wait_closed()

    async def handle_line(self, line: str) -> dict[str, Any] | None:
        """Parse and dispatch one newline-delimited app IPC message."""
        if not line.strip():
            return None

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
            return self._response_message(request_id, result)
        except AppIpcError as exc:
            return self._error_message(request_id, exc.code, exc.message)
        except json.JSONDecodeError as exc:
            return self._error_message(request_id, "invalid_json", str(exc))
        except Exception as exc:
            logger.exception("Unhandled app IPC request error")
            return self._error_message(request_id, "internal_error", str(exc))

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        """Dispatch one app IPC request to runtime work or device command handlers."""
        if method == "device.execute_command":
            return await self._handle_device_command(params)

        if method == "runtime.tasks.guidance":
            method = "runtime.tasks.send"

        if method.startswith("runtime."):
            if self.runtime_work_handler is None:
                try:
                    await asyncio.wait_for(
                        self._runtime_handler_ready.wait(), timeout=30
                    )
                except asyncio.TimeoutError as exc:
                    raise AppIpcError(
                        "runtime_unavailable",
                        "Runtime work handler is not available",
                    ) from exc
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
        """Broadcast one app IPC event to every connected client."""
        message = self._event_message(event, payload)
        await self._broadcast(message)

    def _prepare_socket_path(self) -> None:
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        self._remove_socket_path(force=True)

    def _lock_path(self) -> Path:
        return self.socket_path.with_name(DEFAULT_LOCK_NAME)

    def _acquire_sidecar_lock(self) -> bool:
        """Acquire the local executor singleton lock for this user home."""
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self._lock_path()
        lock_file = open(lock_path, "a+", encoding="utf-8")
        try:
            if os.name != "nt":
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            lock_file.close()
            return False

        lock_file.seek(0)
        lock_file.truncate()
        lock_file.write(str(os.getpid()))
        lock_file.flush()
        self._lock_file = lock_file
        return True

    def _release_sidecar_lock(self) -> None:
        lock_file = self._lock_file
        self._lock_file = None
        if lock_file is None:
            return
        try:
            if os.name != "nt":
                import fcntl

                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            else:
                import msvcrt

                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        finally:
            lock_file.close()

    def _remove_socket_path(self, *, force: bool = False) -> None:
        expected_stat = self._socket_stat
        if not force and expected_stat is None:
            return
        try:
            current_stat = self.socket_path.stat()
            if (
                not force
                and expected_stat is not None
                and (
                    current_stat.st_ino != expected_stat.st_ino
                    or current_stat.st_dev != expected_stat.st_dev
                )
            ):
                return
            self.socket_path.unlink()
        except FileNotFoundError:
            return
        except OSError as exc:
            logger.warning(
                "Failed to remove app IPC socket %s: %s", self.socket_path, exc
            )
        finally:
            if not force:
                self._socket_stat = None

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        async with self._clients_lock:
            self._clients.add(writer)

        peer = writer.get_extra_info("peername")
        logger.info("Local app IPC client connected: %s", peer or "local")
        try:
            await self._write_to_client(
                writer,
                self._event_message(
                    "executor.ready",
                    {
                        "device_id": self.device_id,
                        "ready": True,
                        "version": get_version(),
                    },
                ),
            )
            while self._running:
                line = await reader.readline()
                if not line:
                    break
                response = await self.handle_line(
                    line.decode("utf-8", errors="replace")
                )
                if response is not None:
                    await self._write_to_client(writer, response)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Local app IPC client disconnected with error: %s", exc)
        finally:
            async with self._clients_lock:
                self._clients.discard(writer)
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def _broadcast(self, message: dict[str, Any]) -> None:
        async with self._clients_lock:
            clients = list(self._clients)

        stale_clients: list[asyncio.StreamWriter] = []
        for writer in clients:
            try:
                await self._write_to_client(writer, message)
            except Exception as exc:
                logger.warning("Failed to write app IPC event to client: %s", exc)
                stale_clients.append(writer)

        if stale_clients:
            async with self._clients_lock:
                for writer in stale_clients:
                    self._clients.discard(writer)

    async def _write_to_client(
        self,
        writer: asyncio.StreamWriter,
        message: dict[str, Any],
    ) -> None:
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        writer.write(line.encode("utf-8"))
        await writer.drain()

    def _response_message(self, request_id: str, result: Any) -> dict[str, Any]:
        return {
            "type": "response",
            "id": request_id,
            "ok": True,
            "result": result,
        }

    def _error_message(
        self,
        request_id: str | None,
        code: str,
        message: str,
    ) -> dict[str, Any]:
        return {
            "type": "response",
            "id": request_id,
            "ok": False,
            "error": {
                "code": code,
                "message": message,
            },
        }

    def _event_message(self, event: str, payload: dict[str, Any]) -> dict[str, Any]:
        normalized_payload = dict(payload)
        normalized_payload.setdefault("device_id", self.device_id)
        return {
            "type": "event",
            "event": event,
            "payload": normalized_payload,
        }

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


async def run_app_ipc_sidecar(device_id: str = DEFAULT_DEVICE_ID) -> None:
    """Run the app IPC socket server without a Backend channel."""
    server = AppIpcServer(device_id=device_id)
    if not await server.start():
        return

    runtime_handler_task = asyncio.create_task(_attach_runtime_work_handler(server))
    try:
        await server.wait_serving()
    finally:
        server.stop()
        await server.wait_closed()
        runtime_handler_task.cancel()
        await asyncio.gather(runtime_handler_task, return_exceptions=True)


async def _attach_runtime_work_handler(server: AppIpcServer) -> None:
    """Create and run the runtime work handler after the socket is available."""
    from executor.runtime_work.rpc_handler import RuntimeWorkRpcHandler

    runtime_work_handler = RuntimeWorkRpcHandler(
        responses_event_emitter=server.emit_event,
    )
    server.set_runtime_work_handler(runtime_work_handler)
    try:
        await runtime_work_handler.start_codex_watcher()
        await asyncio.Event().wait()
    finally:
        await runtime_work_handler.stop_codex_watcher()

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Command RPC handler for local executor mode."""

import asyncio
import os
import signal
import time
from typing import Any, Optional

from executor.platform_compat import sanitize_subprocess_environment
from shared.logger import setup_logger

logger = setup_logger("local_command_handler")

DEFAULT_TIMEOUT_SECONDS = 60.0
MAX_TIMEOUT_SECONDS = 600.0
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
MAX_OUTPUT_BYTES = 5 * 1024 * 1024


class CommandHandler:
    """Execute backend-requested commands on the local machine."""

    async def handle_execute_command(self, data: dict[str, Any]) -> dict[str, Any]:
        """Execute a command and return a completed process result."""
        started_at = time.monotonic()
        command = data.get("command")
        if not isinstance(command, str) or not command.strip():
            return self._error_result(
                "command is required",
                duration=self._elapsed(started_at),
            )

        cwd = self._normalize_cwd(data.get("cwd"))
        argv = self._normalize_argv(data.get("argv"))
        env = self._build_env(data.get("env"))
        timeout_seconds = self._normalize_float(
            data.get("timeout_seconds"),
            default=DEFAULT_TIMEOUT_SECONDS,
            upper_bound=MAX_TIMEOUT_SECONDS,
        )
        max_output_bytes = int(
            self._normalize_float(
                data.get("max_output_bytes"),
                default=DEFAULT_MAX_OUTPUT_BYTES,
                upper_bound=MAX_OUTPUT_BYTES,
            )
        )

        logger.info(
            "[CommandHandler] Executing command: cwd=%s, timeout=%s, mode=%s, command=%s",
            cwd or os.getcwd(),
            timeout_seconds,
            "argv" if argv else "shell",
            command[:200],
        )

        try:
            process = await self._create_process(command, argv=argv, cwd=cwd, env=env)
        except Exception as exc:
            logger.exception("[CommandHandler] Failed to start command")
            return self._error_result(str(exc), duration=self._elapsed(started_at))

        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=timeout_seconds,
            )
        except asyncio.TimeoutError:
            await self._terminate_process(process)
            duration = self._elapsed(started_at)
            return self._error_result(
                f"Command timed out after {timeout_seconds:g} seconds",
                duration=duration,
                timed_out=True,
            )

        stdout_text, stdout_truncated = self._decode_and_truncate(
            stdout, max_output_bytes
        )
        stderr_text, stderr_truncated = self._decode_and_truncate(
            stderr, max_output_bytes
        )
        exit_code = process.returncode

        return {
            "success": exit_code == 0,
            "exit_code": exit_code,
            "stdout": stdout_text,
            "stderr": stderr_text,
            "duration": self._elapsed(started_at),
            "timed_out": False,
            "stdout_truncated": stdout_truncated,
            "stderr_truncated": stderr_truncated,
        }

    async def _create_process(
        self,
        command: str,
        argv: Optional[list[str]],
        cwd: Optional[str],
        env: dict[str, str],
    ) -> asyncio.subprocess.Process:
        kwargs: dict[str, Any] = {}
        if os.name != "nt":
            kwargs["start_new_session"] = True

        if argv:
            return await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
                **kwargs,
            )

        return await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
            **kwargs,
        )

    async def _terminate_process(self, process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return

        try:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
            await asyncio.wait_for(process.wait(), timeout=2)
        except Exception:
            logger.warning("[CommandHandler] Graceful termination failed; killing")
            try:
                if os.name != "nt":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                return
            await process.wait()

    def _build_env(self, extra_env: Any) -> dict[str, str]:
        env = os.environ.copy()
        if isinstance(extra_env, dict):
            for key, value in extra_env.items():
                if isinstance(key, str) and key:
                    env[key] = "" if value is None else str(value)
        sanitize_subprocess_environment(env)
        return env

    def _normalize_cwd(self, cwd: Any) -> Optional[str]:
        if cwd is None:
            return None
        if not isinstance(cwd, str) or not cwd.strip():
            return None
        return cwd

    def _normalize_argv(self, argv: Any) -> Optional[list[str]]:
        if not isinstance(argv, list):
            return None
        normalized = [item for item in argv if isinstance(item, str)]
        if len(normalized) != len(argv) or not normalized:
            return None
        if not normalized[0].strip():
            return None
        return normalized

    def _normalize_float(
        self,
        value: Any,
        default: float,
        upper_bound: float,
    ) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            parsed = default
        if parsed <= 0:
            return default
        return min(parsed, upper_bound)

    def _decode_and_truncate(self, data: bytes, max_bytes: int) -> tuple[str, bool]:
        truncated = len(data) > max_bytes
        if truncated:
            data = data[:max_bytes]
        return data.decode("utf-8", errors="replace"), truncated

    def _error_result(
        self,
        error: str,
        duration: float,
        timed_out: bool = False,
    ) -> dict[str, Any]:
        return {
            "success": False,
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "duration": duration,
            "timed_out": timed_out,
            "error": error,
        }

    def _elapsed(self, started_at: float) -> float:
        return round(time.monotonic() - started_at, 6)

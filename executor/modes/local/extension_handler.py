# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Generic device extension execution for local executor mode."""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from executor.config import config
from executor.platform_compat import sanitize_ld_library_path
from shared.logger import setup_logger

if TYPE_CHECKING:
    from executor.modes.local.runner import LocalRunner

logger = setup_logger("local_extension_handler")

EXTENSION_NAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
EXTENSION_ACTION_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")
SCRIPT_PATH_PATTERN = re.compile(r"^[A-Za-z0-9._/-]+$")


class DeviceExtensionHandler:
    """Run backend-supplied extension scripts on the current device."""

    def __init__(self, runner: "LocalRunner"):
        self.runner = runner

    async def handle_run_extension(self, data: dict[str, Any]) -> dict[str, Any]:
        """Execute a generic extension script and return its JSON response."""

        try:
            extension_name = self._validate_name(
                "extension_name", data.get("extension_name"), EXTENSION_NAME_PATTERN
            )
            action = self._validate_name(
                "action", data.get("action"), EXTENSION_ACTION_PATTERN
            )
            task_id = self._validate_task_id(data.get("task_id"))
            script_path = self._validate_script_path(data.get("script_path"))
            payload = self._validate_payload(data.get("payload"))

            resolved_script_path = self._resolve_script_path(
                task_id, extension_name, script_path
            )
            response = self._run_script(
                resolved_script_path, action, extension_name, payload
            )

            if not isinstance(response, dict):
                return {
                    "success": False,
                    "message": "Extension response must be a JSON object",
                }
            return response
        except Exception as exc:
            logger.exception("Failed to run extension")
            return {
                "success": False,
                "message": str(exc),
            }

    def _validate_name(self, field: str, value: Any, pattern: re.Pattern[str]) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{field} is required")

        normalized = value.strip()
        if not pattern.match(normalized):
            raise ValueError(f"Invalid {field}: {normalized}")
        return normalized

    def _validate_task_id(self, value: Any) -> int:
        if not isinstance(value, int) or value <= 0:
            raise ValueError("task_id must be a positive integer")
        return value

    def _validate_script_path(self, value: Any) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("script_path is required")

        normalized = value.strip().lstrip("/")
        if not SCRIPT_PATH_PATTERN.match(normalized):
            raise ValueError(f"Invalid script_path: {normalized}")
        if normalized.startswith("../") or "/../" in normalized:
            raise ValueError(f"Invalid script_path: {normalized}")
        return normalized

    def _validate_payload(self, value: Any) -> dict[str, Any]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise ValueError("payload must be an object")
        return value

    def _resolve_script_path(
        self, task_id: int, extension_name: str, script_path: str
    ) -> Path:
        workspace_root = Path(config.LOCAL_WORKSPACE_ROOT).expanduser().resolve()
        extension_dir = (
            workspace_root / str(task_id) / ".claude" / "skills" / extension_name
        ).resolve()
        resolved_path = (extension_dir / script_path).resolve()

        if not resolved_path.is_file():
            raise FileNotFoundError(f"Extension script not found: {resolved_path}")
        if os.path.commonpath([str(extension_dir), str(resolved_path)]) != str(
            extension_dir
        ):
            raise ValueError(f"Script path escapes extension directory: {script_path}")

        return resolved_path

    def _run_script(
        self,
        script_path: Path,
        action: str,
        extension_name: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        env = os.environ.copy()

        # Fix PyInstaller LD_LIBRARY_PATH issue for child processes.
        # See: https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html
        sanitize_ld_library_path(env)

        env["WEGENT_EXTENSION_NAME"] = extension_name
        env["WEGENT_EXTENSION_ACTION"] = action
        env["WEGENT_EXTENSION_PAYLOAD"] = json.dumps(payload, ensure_ascii=True)

        for key, value in payload.items():
            env_key = f"WEGENT_EXT_{self._normalize_env_key(key)}"
            env[env_key] = "" if value is None else str(value)

        result = subprocess.run(
            ["bash", str(script_path), action],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
            check=False,
        )

        stdout = result.stdout.strip()
        stderr = result.stderr.strip()
        if result.returncode != 0:
            message = (
                stderr or stdout or f"Extension exited with code {result.returncode}"
            )
            return {
                "success": False,
                "message": message,
            }

        if not stdout:
            return {
                "success": False,
                "message": "Extension produced empty output",
            }

        try:
            return json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Extension returned invalid JSON: {exc}") from exc

    def _normalize_env_key(self, key: str) -> str:
        normalized = re.sub(r"[^A-Za-z0-9]+", "_", key).strip("_").upper()
        return normalized or "VALUE"

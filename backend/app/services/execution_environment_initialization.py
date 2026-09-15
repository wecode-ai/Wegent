# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Initialize reusable execution environments on authorized devices."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from app.models.kind import Kind
from app.services.device.command_service import execute_configured_device_command


def execution_environment_fingerprint(definition: dict[str, Any]) -> str:
    canonical = {
        "repositories": [
            {
                "name": str(repository.get("name") or "").strip(),
                "url": str(repository.get("url") or "").strip(),
                "ref": str(repository.get("ref") or "").strip(),
                "path": str(repository.get("path") or "").strip(),
                "primary": bool(repository.get("primary")),
            }
            for repository in definition.get("repositories") or []
            if isinstance(repository, dict)
        ],
        "setup_steps": [
            {
                "command": str(step.get("command") or "").strip(),
                "working_directory": str(step.get("working_directory") or "").strip(),
            }
            for step in definition.get("setup_steps") or []
            if isinstance(step, dict) and str(step.get("command") or "").strip()
        ],
    }
    return hashlib.sha256(
        json.dumps(canonical, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()


def preparing_execution_environment(definition: dict[str, Any]) -> dict[str, Any]:
    return {
        **definition,
        "status": "preparing",
        "fingerprint": execution_environment_fingerprint(definition),
        "prepared_device_id": "",
        "prepared_workspace_path": "",
        "prepared_at": None,
        "error": "",
    }


async def initialize_execution_environment(
    *,
    db: Any,
    device: Kind,
    environment_id: str,
    definition: dict[str, Any],
) -> dict[str, Any]:
    fingerprint = execution_environment_fingerprint(definition)
    device_key = _device_key(device)
    try:
        result = await execute_configured_device_command(
            db=db,
            user_id=int(device.user_id),
            device_id=device_key,
            command_key="environment_prepare",
            args=[
                json.dumps(
                    {
                        "environmentId": f"{environment_id}-{fingerprint[:12]}",
                        "repositories": definition.get("repositories") or [],
                        "setupSteps": definition.get("setup_steps") or [],
                        "fingerprint": fingerprint,
                    },
                    ensure_ascii=False,
                )
            ],
            timeout_seconds=600,
            max_output_bytes=5 * 1024 * 1024,
            allow_internal=True,
        )
        if not bool(result.get("success")) or result.get("exit_code") != 0:
            raise RuntimeError(
                str(
                    result.get("stderr")
                    or result.get("error")
                    or "Execution environment initialization failed"
                )
            )
    except Exception as error:
        return {
            **definition,
            "status": "error",
            "fingerprint": fingerprint,
            "prepared_device_id": device_key,
            "prepared_workspace_path": "",
            "prepared_at": None,
            "error": str(error),
        }
    stdout = result.get("stdout")
    prepared = stdout if isinstance(stdout, dict) else {}
    return {
        **definition,
        "status": "ready",
        "fingerprint": fingerprint,
        "prepared_device_id": device_key,
        "prepared_workspace_path": str(prepared.get("workspacePath") or ""),
        "prepared_at": datetime.now(timezone.utc),
        "error": "",
    }


def _device_key(device: Kind) -> str:
    payload = device.json if isinstance(device.json, dict) else {}
    spec = payload.get("spec") if isinstance(payload.get("spec"), dict) else {}
    return str(spec.get("deviceId") or device.name)

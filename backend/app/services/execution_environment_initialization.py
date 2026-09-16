# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Initialize reusable execution environments on authorized devices."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status

from app.core.distributed_lock import distributed_lock
from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device.command_service import execute_configured_device_command
from app.services.device.git_credentials import (
    DeviceGitCredentialResolutionError,
    sync_git_accounts_to_device,
)
from app.services.device.identity import record_route_id
from app.services.device.remote_control_policy import device_kind_type
from app.services.device.runtime_route import runtime_device_route_id
from shared.models.db import User


async def _sync_device_git_credentials(db: Any, device: Kind) -> None:
    """Provision the owner's Git accounts onto managed remote devices.

    Preparation declares device-local Git credentials, so a managed remote or
    cloud device must receive the accounts before cloning; without them the
    clone fails deep inside the executor with a raw credential error. Local
    and App installations resolve credentials from the machine's own Git
    setup, so syncing there would edit the user's personal Git configuration.
    """
    if device_kind_type(device) not in {DeviceType.CLOUD, DeviceType.REMOTE}:
        return
    user = db.get(User, int(device.user_id))
    if user is None:
        return
    try:
        await sync_git_accounts_to_device(
            db,
            user=user,
            device_id=record_route_id(device),
            allow_empty=False,
        )
    except DeviceGitCredentialResolutionError:
        # No Git accounts configured for the owner. Refuse to clear whatever
        # the device already has and let preparation continue; public
        # repositories do not need credentials, and a missing private
        # credential surfaces as the repository error below.
        return


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
    # Saving tolerates an empty repository list so a draft environment can be
    # stored, but preparation on a device cannot run without one; reject here
    # instead of letting the executor surface a raw internal error.
    repositories = [
        repository
        for repository in definition.get("repositories") or []
        if isinstance(repository, dict)
    ]
    if sum(1 for repository in repositories if bool(repository.get("primary"))) != 1:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Execution environment requires exactly one primary repository",
        )
    fingerprint = execution_environment_fingerprint(definition)
    # Persist the same identity queue rows carry, so a prepared workspace is
    # reused by exactly the installation that built it.
    device_key = runtime_device_route_id(device)
    # Concurrent preparations of one environment on one device race on the same
    # target directory; the callers release their row locks before calling in,
    # so serialize here instead. The RPC below can run for the full command
    # timeout, hence the watchdog-extended expiry.
    lock_name = f"execution-environment-init:{environment_id}:{device_key}"
    async with distributed_lock.acquire_watchdog_context_async(
        lock_name,
        expire_seconds=900,
        extend_interval_seconds=60,
    ) as acquired:
        if not acquired:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Execution environment initialization is already in progress "
                "on this device",
            )
        try:
            await _sync_device_git_credentials(db, device)
            result = await execute_configured_device_command(
                db=db,
                user_id=int(device.user_id),
                device_id=record_route_id(device),
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
            "prepared_at": datetime.now(timezone.utc).isoformat(),
            "error": "",
        }

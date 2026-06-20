# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API endpoints for local Codex thread discovery and binding."""

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.core.config import settings
from app.models.kind import Kind
from app.models.user import User
from app.schemas.local_codex import (
    LocalCodexBindRequest,
    LocalCodexBindResponse,
    LocalCodexThreadListResponse,
    LocalCodexThreadSummary,
)
from app.services.adapters.task_kinds.converters import convert_to_task_dict
from app.services.adapters.team_kinds import team_kinds_service
from app.services.device.command_service import (
    DeviceCommandError,
    DeviceCommandNotFoundError,
    DeviceCommandUnknownKeyError,
    execute_configured_device_command,
    local_device_command_service,
)
from app.services.local_codex_thread_service import (
    bind_local_codex_thread,
    normalize_codex_thread_id,
)

router = APIRouter()

CODEX_THREADS_COMMAND_KEY = "codex_threads_list"
CODEX_THREADS_TIMEOUT_SECONDS = 10
CODEX_THREADS_MAX_OUTPUT_BYTES = 256 * 1024
CODEX_THREADS_MAX_LIMIT = 100


@router.get(
    "/devices/{device_id}/threads",
    response_model=LocalCodexThreadListResponse,
)
async def list_device_codex_threads(
    device_id: str,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> LocalCodexThreadListResponse:
    """Discover local Codex threads on a device."""

    return LocalCodexThreadListResponse(
        threads=await _discover_device_codex_threads(
            db=db,
            user_id=current_user.id,
            device_id=device_id,
            limit=limit,
        )
    )


@router.post("/threads/bind", response_model=LocalCodexBindResponse)
async def bind_local_codex_thread_endpoint(
    request: LocalCodexBindRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> LocalCodexBindResponse:
    """Bind a discovered local Codex thread to a Wework task."""

    try:
        thread_id = normalize_codex_thread_id(request.thread_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    threads = await _discover_device_codex_threads(
        db=db,
        user_id=current_user.id,
        device_id=request.device_id,
        limit=CODEX_THREADS_MAX_LIMIT,
    )
    thread = next((item for item in threads if item.thread_id == thread_id), None)
    if thread is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Codex thread not found on device",
        )

    team = _get_user_team_or_404(db, current_user.id, request.team_id)
    try:
        binding = bind_local_codex_thread(
            db=db,
            user=current_user,
            team=team,
            device_id=request.device_id,
            thread_id=thread_id,
            title=thread.title or request.title,
            cwd=thread.cwd,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))

    return LocalCodexBindResponse(
        task_id=binding.task_id,
        task=convert_to_task_dict(binding.task, db, current_user.id),
        created=binding.created,
        thread_id=binding.thread_id,
        device_id=binding.device_id,
    )


def _get_user_team_or_404(db: Session, user_id: int, team_id: int | None) -> Kind:
    from app.services.share.team_share_service import team_share_service

    if team_id:
        team = team_share_service.get_resource(db, team_id, user_id)
        if not team:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid teamId or team is not accessible",
            )
        return team

    team = _get_configured_default_wework_team(db, user_id)
    if team:
        return team

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Default team is unavailable",
    )


def _get_configured_default_wework_team(db: Session, user_id: int) -> Kind | None:
    config = _parse_default_team_setting(settings.DEFAULT_TEAM_WEWORK)
    if not config:
        return None

    return team_kinds_service.get_team_by_name_and_namespace(
        db=db,
        team_name=config["name"],
        team_namespace=config["namespace"],
        user_id=user_id,
    )


def _parse_default_team_setting(value: str) -> dict[str, str] | None:
    if not value or not value.strip():
        return None

    parts = value.strip().split("#", 1)
    name = parts[0].strip()
    namespace = parts[1].strip() if len(parts) > 1 else "default"
    if not name:
        return None

    return {"name": name, "namespace": namespace}


async def _discover_device_codex_threads(
    *,
    db: Session,
    user_id: int,
    device_id: str,
    limit: int,
) -> list[LocalCodexThreadSummary]:
    capped_limit = min(max(int(limit), 1), CODEX_THREADS_MAX_LIMIT)
    try:
        result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key=CODEX_THREADS_COMMAND_KEY,
            env={"WEGENT_CODEX_THREADS_LIMIT": str(capped_limit)},
            timeout_seconds=CODEX_THREADS_TIMEOUT_SECONDS,
            max_output_bytes=CODEX_THREADS_MAX_OUTPUT_BYTES,
        )
    except DeviceCommandNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc))
    except DeviceCommandUnknownKeyError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    except DeviceCommandError as exc:
        if local_device_command_service.is_unavailable_error(exc):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc))

    stdout = result.get("stdout")
    if not isinstance(stdout, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Codex thread discovery returned an invalid response",
        )

    raw_threads = stdout.get("threads", [])
    if not isinstance(raw_threads, list):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Codex thread discovery returned invalid thread data",
        )

    return [
        LocalCodexThreadSummary.model_validate(_normalize_thread_summary(item))
        for item in raw_threads[:capped_limit]
        if isinstance(item, dict)
    ]


def _normalize_thread_summary(item: dict[str, Any]) -> dict[str, Any]:
    thread_id = item.get("threadId") or item.get("thread_id") or item.get("id")
    title = item.get("title") or thread_id
    return {
        "threadId": thread_id,
        "title": title,
        "cwd": item.get("cwd"),
        "updatedAt": item.get("updatedAt") or item.get("updated_at"),
        "archived": bool(item.get("archived", False)),
        "running": bool(item.get("running", False)),
    }

"""Reuse native transcript identity and collaboration authority for continuation."""

from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.schemas.base_role import BaseRole
from app.schemas.runtime_work import RuntimeTaskAddress, RuntimeTranscriptRequest


async def resolve_continuation_address(
    *,
    db: Session,
    user_id: int,
    address: RuntimeTaskAddress,
    allow_app_device_task_messaging: bool = False,
) -> RuntimeTaskAddress:
    """Take session identity from the existing authorized read, never client origin."""
    from app.services.runtime_work_service import get_runtime_transcript

    # The canonical context projection retains provider identity and workspace metadata.
    history = await get_runtime_transcript(
        db=db,
        user_id=user_id,
        address=RuntimeTranscriptRequest(
            deviceId=address.device_id,
            taskId=address.local_task_id,
            limit=1,
            conversationContextOnly=True,
        ),
        identity_only=True,
        **(
            {"allow_app_device_task_reading": True}
            if allow_app_device_task_messaging
            else {}
        ),
    )
    if history.local_task_id != address.local_task_id or not history.workspace_path:
        raise HTTPException(502, "Runtime returned a different continuation identity")
    handle = dict(address.runtime_handle or {})
    handle.update(runtime=history.runtime, origin=history.origin)
    origin = history.origin or {}
    handle["cloudProjectId"] = origin.get("cloudProjectId") or origin.get(
        "cloud_project_id"
    )
    return address.model_copy(
        update={"workspace_path": history.workspace_path, "runtime_handle": handle}
    )


def authorize_execution_origin(
    db: Session, user_id: int, origin: dict[str, Any] | None, project_id: str | None
) -> None:
    """Use the same current Issue and execute checks as project execution admission."""
    from app.services.collaboration_permissions import collaboration_permission_service
    from app.services.project_chat.service import project_chat_service

    origin = origin or {}
    if origin.get("projectStore") == "local":
        return
    project_id = (
        project_id or origin.get("cloudProjectId") or origin.get("cloud_project_id")
    )
    if not project_id:
        return
    project_id = str(project_id)
    issue_id = origin.get("loopItemId") or origin.get("loop_item_id")
    project_chat_service._require_scope(
        db,
        user_id=user_id,
        project_id=project_id,
        task_id=str(issue_id) if issue_id else None,
        required_role=BaseRole.Viewer,
    )
    if not collaboration_permission_service.check(
        db, user_id, "execute", project_id
    ).allowed:
        raise HTTPException(403, "Insufficient permission to execute in this project")

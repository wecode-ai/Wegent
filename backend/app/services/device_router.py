# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Device task router service.

This module handles routing tasks to local devices via WebSocket.
It formats task data similar to executor_kinds.dispatch_tasks()
and pushes tasks directly to devices via the /device namespace.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import create_access_token
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Ghost, Model, Shell, Task, Team
from app.services.context import context_service
from app.services.device_service import device_service
from shared.models.db.enums import DeviceStatus
from shared.utils.crypto import decrypt_api_key

logger = logging.getLogger(__name__)


async def route_task_to_device(
    db: Session,
    user_id: int,
    device_id: str,
    task: TaskResource,
    subtask: Subtask,
    team: Kind,
    user: User,
    auth_token: str = "",
    user_subtask: Optional[Subtask] = None,
) -> bool:
    """
    Route a task to a local device for execution.

    This function:
    1. Verifies device is online
    2. Formats task data (similar to dispatch_tasks)
    3. Updates subtask with device executor info
    4. Pushes task to device via WebSocket
    5. Updates device status to busy

    Args:
        db: Database session
        user_id: User ID
        device_id: Target device ID
        task: Task resource
        subtask: Assistant subtask to execute
        team: Team Kind
        user: User object
        auth_token: JWT token for API calls
        user_subtask: Optional user subtask for context retrieval

    Returns:
        True if task was successfully routed to device

    Raises:
        HTTPException: If device is offline or routing fails
    """
    from fastapi import HTTPException

    # Verify device is online
    device_info = await device_service.get_device_online_info(user_id, device_id)
    if not device_info:
        raise HTTPException(status_code=400, detail="Selected device is offline")

    # Update subtask with device executor info
    subtask.executor_name = f"device-{device_id}"
    subtask.executor_namespace = f"user-{user_id}"
    subtask.status = SubtaskStatus.RUNNING
    subtask.started_at = datetime.now()
    db.add(subtask)
    db.commit()

    # Update device status to busy
    device_service.update_device_status(db, user_id, device_id, DeviceStatus.BUSY)

    # Format task data for device
    task_data = await _format_task_data_for_device(
        db=db,
        task=task,
        subtask=subtask,
        team=team,
        user=user,
        auth_token=auth_token,
        user_subtask=user_subtask,
    )

    # Push task to device via WebSocket
    from app.core.socketio import get_sio

    sio = get_sio()
    device_room = f"device:{user_id}:{device_id}"

    await sio.emit("task:execute", task_data, room=device_room, namespace="/device")

    logger.info(
        f"[DeviceRouter] Task routed to device: task_id={task.id}, "
        f"subtask_id={subtask.id}, device_id={device_id}"
    )

    # Broadcast device status change
    await _broadcast_device_status(user_id, device_id, DeviceStatus.BUSY)

    return True


async def _format_task_data_for_device(
    db: Session,
    task: TaskResource,
    subtask: Subtask,
    team: Kind,
    user: User,
    auth_token: str = "",
    user_subtask: Optional[Subtask] = None,
) -> Dict[str, Any]:
    """
    Format task data for device execution.

    Similar to executor_kinds.dispatch_tasks() but simplified for device execution.

    Args:
        db: Database session
        task: Task resource
        subtask: Subtask to execute
        team: Team Kind
        user: User object
        auth_token: JWT token for API calls
        user_subtask: Optional user subtask for context retrieval

    Returns:
        Formatted task data dict
    """
    # Parse task and team CRDs
    task_crd = Task.model_validate(task.json)
    team_crd = Team.model_validate(team.json)

    # Get workspace info
    git_url = None
    git_repo = None
    git_domain = None
    git_repo_id = None
    branch_name = None

    workspace_ref = task_crd.spec.workspaceRef
    if workspace_ref:
        workspace = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == task.user_id,
                TaskResource.kind == "Workspace",
                TaskResource.name == workspace_ref.name,
                TaskResource.namespace == workspace_ref.namespace or "default",
            )
            .first()
        )
        if workspace:
            from app.schemas.kind import Workspace

            workspace_crd = Workspace.model_validate(workspace.json)
            if workspace_crd.spec.repository:
                repo = workspace_crd.spec.repository
                git_url = repo.url
                git_repo = repo.name
                git_domain = repo.domain
                git_repo_id = repo.id
                branch_name = repo.branch

    # Get user git info
    git_info = None
    if user.git_info:
        git_info = user.git_info.copy()
        if git_info.get("git_token"):
            try:
                git_info["git_token"] = decrypt_api_key(git_info["git_token"])
            except Exception as e:
                logger.warning(f"Failed to decrypt git token: {e}")

    # Get bots from team
    bots = []
    for member in team_crd.spec.members or []:
        bot_ref = member.botRef
        if not bot_ref:
            continue

        # Query bot
        bot_kind = (
            db.query(Kind)
            .filter(
                Kind.kind == "Bot",
                Kind.name == bot_ref.name,
                Kind.namespace == bot_ref.namespace or team.namespace,
            )
            .first()
        )
        if not bot_kind:
            continue

        bot_crd = Bot.model_validate(bot_kind.json)

        # Get shell info
        shell_type = "ClaudeCode"
        shell_base_image = None
        if bot_crd.spec.shellRef:
            shell_kind = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Shell",
                    Kind.name == bot_crd.spec.shellRef.name,
                    Kind.namespace == bot_crd.spec.shellRef.namespace
                    or bot_kind.namespace,
                )
                .first()
            )
            if shell_kind:
                shell_crd = Shell.model_validate(shell_kind.json)
                shell_type = shell_crd.spec.shellType or "ClaudeCode"
                shell_base_image = shell_crd.spec.baseImage

        # Get ghost info (system prompt, MCP servers, skills)
        system_prompt = ""
        mcp_servers = {}
        skills = []
        if bot_crd.spec.ghostRef:
            ghost_kind = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Ghost",
                    Kind.name == bot_crd.spec.ghostRef.name,
                    Kind.namespace == bot_crd.spec.ghostRef.namespace
                    or bot_kind.namespace,
                )
                .first()
            )
            if ghost_kind:
                ghost_crd = Ghost.model_validate(ghost_kind.json)
                system_prompt = ghost_crd.spec.systemPrompt or ""
                mcp_servers = ghost_crd.spec.mcpServers or {}
                skills = ghost_crd.spec.skills or []

        # Add team member prompt
        bot_prompt = system_prompt
        if member.prompt:
            bot_prompt += f"\n{member.prompt}"

        # Get model config
        agent_config = {}
        if bot_crd.spec.modelRef:
            model_kind = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == bot_crd.spec.modelRef.name,
                    Kind.namespace == bot_crd.spec.modelRef.namespace
                    or bot_kind.namespace,
                )
                .first()
            )
            if model_kind:
                model_crd = Model.model_validate(model_kind.json)
                agent_config = {
                    "model": (
                        model_crd.spec.modelConfig.model
                        if model_crd.spec.modelConfig
                        else None
                    ),
                    "protocol": model_crd.spec.protocol or "anthropic",
                }
                # Include env vars with decrypted API keys
                if model_crd.spec.modelConfig and model_crd.spec.modelConfig.env:
                    env_vars = {}
                    for key, value in model_crd.spec.modelConfig.env.items():
                        if "key" in key.lower() or "token" in key.lower():
                            try:
                                env_vars[key] = decrypt_api_key(value)
                            except Exception:
                                env_vars[key] = value
                        else:
                            env_vars[key] = value
                    agent_config["env"] = env_vars

        bots.append(
            {
                "id": bot_kind.id,
                "name": bot_kind.name,
                "shell_type": shell_type,
                "agent_config": agent_config,
                "system_prompt": bot_prompt,
                "mcp_servers": mcp_servers,
                "skills": skills,
                "role": member.role or "",
                "base_image": shell_base_image,
            }
        )

    # Generate auth token if not provided
    if not auth_token:
        try:
            auth_token = create_access_token(
                data={"sub": user.user_name, "user_id": user.id},
                expires_delta=1440,  # 24 hours
            )
        except Exception as e:
            logger.warning(f"Failed to generate auth token: {e}")

    # Get attachments from user subtask
    attachments_data = []
    if user_subtask:
        attachment_contexts = context_service.get_attachments_by_subtask(
            db=db, subtask_id=user_subtask.id
        )
        for ctx in attachment_contexts:
            if ctx.status != "ready":
                continue
            attachments_data.append(
                {
                    "id": ctx.id,
                    "original_filename": ctx.original_filename,
                    "file_extension": ctx.file_extension,
                    "file_size": ctx.file_size,
                    "mime_type": ctx.mime_type,
                }
            )

    # Task type
    task_type = (
        task_crd.metadata.labels.get("type", "online")
        if task_crd.metadata.labels
        else "online"
    )

    return {
        "subtask_id": subtask.id,
        "task_id": task.id,
        "team_id": team.id,
        "type": task_type,
        "prompt": subtask.prompt or "",
        "bot": bots,
        "mode": team_crd.spec.collaborationModel or "coordinate",
        "git_url": git_url,
        "git_repo": git_repo,
        "git_repo_id": git_repo_id,
        "git_domain": git_domain,
        "branch_name": branch_name,
        "user": {
            "id": user.id,
            "name": user.user_name,
            "git_domain": git_info.get("git_domain") if git_info else None,
            "git_token": git_info.get("git_token") if git_info else None,
            "git_id": git_info.get("git_id") if git_info else None,
            "git_login": git_info.get("git_login") if git_info else None,
            "git_email": git_info.get("git_email") if git_info else None,
        },
        "attachments": attachments_data,
        "auth_token": auth_token,
        "team_namespace": team.namespace,
    }


async def _broadcast_device_status(
    user_id: int, device_id: str, status: DeviceStatus
) -> None:
    """Broadcast device status change to user room."""
    from app.core.socketio import get_sio

    sio = get_sio()
    await sio.emit(
        "device:status",
        {"device_id": device_id, "status": status.value},
        room=f"user:{user_id}",
        namespace="/chat",
    )

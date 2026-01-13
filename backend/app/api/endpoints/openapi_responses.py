# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses endpoint.
Compatible with OpenAI Responses API format.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Bot, Task, Team
from app.schemas.openapi_response import (
    OutputMessage,
    OutputTextContent,
    ResponseCreateInput,
    ResponseDeletedObject,
    ResponseError,
    ResponseObject,
)
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service
from app.services.openapi.chat_response import (
    create_streaming_response,
    create_sync_response,
)
from app.services.openapi.helpers import (
    check_team_supports_direct_chat,
    extract_input_text,
    parse_model_string,
    parse_wegent_tools,
    subtask_status_to_message_status,
    wegent_status_to_openai_status,
)
from app.services.readers.kinds import KindType, kindReader

logger = logging.getLogger(__name__)

router = APIRouter()


def _task_to_response_object(
    task_dict: Dict[str, Any],
    model_string: str,
    subtasks: list = None,
    previous_response_id: str = None,
) -> ResponseObject:
    """Convert task dictionary to ResponseObject."""
    task_id = task_dict.get("id")
    wegent_status = task_dict.get("status", "PENDING")
    created_at = task_dict.get("created_at")

    # Convert datetime to unix timestamp
    if isinstance(created_at, datetime):
        created_at_unix = int(created_at.timestamp())
    else:
        created_at_unix = int(datetime.now().timestamp())

    # Build output from subtasks
    output = []
    if subtasks:
        for subtask in subtasks:
            if subtask.role == SubtaskRole.USER:
                msg = OutputMessage(
                    id=f"msg_{subtask.id}",
                    status=subtask_status_to_message_status(subtask.status.value),
                    content=[OutputTextContent(text=subtask.prompt)],
                    role="user",
                )
                output.append(msg)

            if subtask.role == SubtaskRole.ASSISTANT:
                result_text = ""
                if isinstance(subtask.result, dict):
                    result_text = subtask.result.get("value", str(subtask.result))
                elif isinstance(subtask.result, str):
                    result_text = subtask.result

                msg = OutputMessage(
                    id=f"msg_{subtask.id}",
                    status=subtask_status_to_message_status(subtask.status.value),
                    content=[OutputTextContent(text=result_text)],
                    role="assistant",
                )
                output.append(msg)

    # Build error if failed
    error = None
    error_message = task_dict.get("error_message")
    if wegent_status == "FAILED" and error_message:
        error = ResponseError(code="task_failed", message=error_message)

    return ResponseObject(
        id=f"resp_{task_id}",
        created_at=created_at_unix,
        status=wegent_status_to_openai_status(wegent_status),
        error=error,
        model=model_string,
        output=output,
        previous_response_id=previous_response_id,
    )


@router.post("")
async def create_response(
    request_body: ResponseCreateInput,
    db: Session = Depends(get_db),
    auth_context: security.AuthContext = Depends(security.get_auth_context),
):
    """
    Create a new response (execute a task).

    This endpoint is compatible with OpenAI's Responses API format.

    For Chat Shell type teams:
    - When stream=True: Returns SSE stream with OpenAI v1/responses compatible events.
    - When stream=False (default): Blocks until LLM completes, returns completed response.

    For non-Chat Shell type teams (Executor-based):
    - Returns response with status 'queued' immediately.
    - Use GET /api/v1/responses/{response_id} to poll for completion.

    Args:
        request_body: ResponseCreateInput containing:
        - model: Format "namespace#team_name" or "namespace#team_name#model_id"
        - input: The user prompt (string or list of messages)
        - stream: Whether to enable streaming output (default: False)
        - tools: Optional Wegent tools to enable server-side capabilities:
          - {"type": "wegent_chat_bot"}: Enable all server-side capabilities
            (deep thinking with web search, server MCP tools, message enhancement)
        - previous_response_id: Optional, for follow-up conversations

    Note:
        - By default, API calls use "clean mode" without server-side enhancements
        - Bot/Ghost MCP tools are always available (configured in the bot's Ghost CRD)
        - Use wegent_chat_bot to enable full server-side capabilities

    Returns:
        ResponseObject with status 'completed' (Chat Shell)
        or StreamingResponse with SSE events (Chat Shell + stream=true)
        or ResponseObject with status 'queued' (non-Chat Shell)
    """
    # Extract user and api_key_name from auth context
    current_user = auth_context.user
    api_key_name = auth_context.api_key_name

    # Parse model string
    model_info = parse_model_string(request_body.model)

    # Parse tools for settings
    tool_settings = parse_wegent_tools(request_body.tools)

    # Extract input text
    input_text = extract_input_text(request_body.input)

    # Determine task_id from previous_response_id if provided
    task_id = None
    previous_task_id = None
    if request_body.previous_response_id:
        # Extract task_id from resp_{task_id} format
        if request_body.previous_response_id.startswith("resp_"):
            try:
                previous_task_id = int(request_body.previous_response_id[5:])
                task_id = previous_task_id  # For follow-up, use the same task_id
            except ValueError:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Invalid previous_response_id format: '{request_body.previous_response_id}'",
                )

            # Verify previous task exists and belongs to the current user
            existing_task = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == previous_task_id,
                    TaskResource.kind == "Task",
                    TaskResource.is_active == True,
                )
                .first()
            )
            if not existing_task:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Previous response '{request_body.previous_response_id}' not found",
                )

    # Verify team exists and user has access
    team = kindReader.get_by_name_and_namespace(
        db,
        current_user.id,
        KindType.TEAM,
        model_info["namespace"],
        model_info["team_name"],
    )
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Team '{model_info['namespace']}#{model_info['team_name']}' not found or not accessible",
        )

    # If model_id is provided, verify that the model exists
    if model_info.get("model_id"):
        model_name = model_info["model_id"]
        model_namespace = model_info["namespace"]

        model = kindReader.get_by_name_and_namespace(
            db,
            current_user.id,
            KindType.MODEL,
            model_namespace,
            model_name,
        )

        # If not found and namespace is not default, try with default namespace
        # This handles the case where user passes group#group_team#public_model_id
        if not model and model_namespace != "default":
            model = kindReader.get_by_name_and_namespace(
                db,
                current_user.id,
                KindType.MODEL,
                "default",
                model_name,
            )

        if not model:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Model '{model_namespace}/{model_name}' not found",
            )
    else:
        # If model_id is not provided, verify that all team's bots have valid modelRef
        # Parse team JSON to Team CRD object
        team_crd = Team.model_validate(team.json)

        if not team_crd.spec.members:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Team '{model_info['namespace']}#{model_info['team_name']}' has no members configured",
            )

        # Validate all members' bots have valid modelRef
        for member in team_crd.spec.members:
            bot_ref = member.botRef
            bot_name = bot_ref.name
            bot_namespace = bot_ref.namespace

            if not bot_name:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Team '{model_info['namespace']}#{model_info['team_name']}' has invalid bot reference",
                )

            # Query the bot using kindReader
            bot_kind = kindReader.get_by_name_and_namespace(
                db,
                team.user_id,
                KindType.BOT,
                bot_namespace,
                bot_name,
            )

            if not bot_kind:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Bot '{bot_namespace}/{bot_name}' not found",
                )

            # Parse bot JSON to Bot CRD object and check modelRef
            bot_crd = Bot.model_validate(bot_kind.json)

            # modelRef must exist and have non-empty name and namespace
            model_ref = bot_crd.spec.modelRef
            if not model_ref or not model_ref.name or not model_ref.namespace:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Bot '{bot_namespace}/{bot_name}' does not have a valid model configured. Please specify model_id in the request or configure modelRef for the bot.",
                )

    # Check if team supports direct chat (Chat Shell type)
    supports_direct_chat = check_team_supports_direct_chat(db, team, current_user.id)

    if supports_direct_chat:
        # Chat Shell type: use direct LLM call (streaming or sync)
        if request_body.stream:
            return await create_streaming_response(
                db=db,
                user=current_user,
                team=team,
                model_info=model_info,
                request_body=request_body,
                input_text=input_text,
                tool_settings=tool_settings,
                task_id=task_id,
                api_key_name=api_key_name,
            )
        else:
            return await create_sync_response(
                db=db,
                user=current_user,
                team=team,
                model_info=model_info,
                request_body=request_body,
                input_text=input_text,
                tool_settings=tool_settings,
                task_id=task_id,
                api_key_name=api_key_name,
            )

    # Non-Chat Shell type (Executor-based): streaming not supported
    if request_body.stream:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Streaming is only supported for teams where all bots use Chat Shell type. "
            "Please set stream=false to use the queued response mode.",
        )

    # Non-Chat Shell type (Executor-based): create task and return queued response
    task_create = TaskCreate(
        prompt=input_text,
        team_name=model_info["team_name"],
        team_namespace=model_info["namespace"],
        task_type="chat",
        type="online",
        source="api",
        model_id=model_info.get("model_id"),
        force_override_bot_model=model_info.get("model_id") is not None,
        api_key_name=api_key_name,
    )

    try:
        task_dict = task_kinds_service.create_task_or_append(
            db, obj_in=task_create, user=current_user, task_id=task_id
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create task: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to create task: {str(e)}",
        )

    # Build previous_response_id for the response
    prev_resp_id = None
    if previous_task_id:
        prev_resp_id = f"resp_{previous_task_id}"

    # Get subtasks for output
    subtasks = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_dict.get("id"), Subtask.user_id == current_user.id
        )
        .order_by(Subtask.message_id.asc())
        .all()
    )

    return _task_to_response_object(
        task_dict,
        request_body.model,
        subtasks,
        previous_response_id=prev_resp_id,
    )


@router.get("/{response_id}", response_model=ResponseObject)
async def get_response(
    response_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Retrieve a response by ID.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseObject with current status and output
    """
    # Extract task_id from response_id
    if not response_id.startswith("resp_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'. Expected format: 'resp_{{task_id}}'",
        )

    try:
        task_id = int(response_id[5:])
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    # Get task detail
    try:
        task_dict = task_kinds_service.get_task_by_id(
            db, task_id=task_id, user_id=current_user.id
        )
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Response '{response_id}' not found",
            )
        raise

    # Get subtasks for output
    subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == current_user.id)
        .order_by(Subtask.message_id.asc())
        .all()
    )

    # Reconstruct model string from task team reference
    task_kind = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    model_string = "unknown"
    if task_kind and task_kind.json:
        task_crd = Task.model_validate(task_kind.json)
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace
        model_id = (
            task_crd.metadata.labels.get("modelId")
            if task_crd.metadata.labels
            else None
        )
        if model_id:
            model_string = f"{team_namespace}#{team_name}#{model_id}"
        else:
            model_string = f"{team_namespace}#{team_name}"

    return _task_to_response_object(task_dict, model_string, subtasks=subtasks)


@router.post("/{response_id}/cancel", response_model=ResponseObject)
async def cancel_response(
    response_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Cancel a running response.

    For Chat Shell type tasks (source="chat_shell"), this will stop the model request
    and save partial content to the subtask result.

    For other task types (Executor-based), this will call the executor_manager to cancel.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseObject with status 'cancelled' or current status
    """
    from sqlalchemy.orm.attributes import flag_modified

    from app.services.chat.storage import db_handler, session_manager

    # Extract task_id from response_id
    if not response_id.startswith("resp_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    try:
        task_id = int(response_id[5:])
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    # Get task to check if it's a Chat Shell type
    task_kind = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    if not task_kind:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Response '{response_id}' not found",
        )

    # Check if this is a Chat Shell task (source="chat_shell")
    task_crd = Task.model_validate(task_kind.json)
    source_label = (
        task_crd.metadata.labels.get("source") if task_crd.metadata.labels else None
    )
    is_chat_shell = source_label == "chat_shell"

    logger.info(
        f"[CANCEL] task_id={task_id}, source={source_label}, is_chat_shell={is_chat_shell}"
    )

    if is_chat_shell:
        # For Chat Shell tasks, use session_manager to cancel the stream
        # Find running assistant subtask
        running_subtask = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.user_id == current_user.id,
                Subtask.role == SubtaskRole.ASSISTANT,
                Subtask.status.in_(
                    [
                        SubtaskStatus.PENDING,
                        SubtaskStatus.RUNNING,
                    ]
                ),
            )
            .order_by(Subtask.id.desc())
            .first()
        )

        if running_subtask:
            logger.info(
                f"[CANCEL] Found running subtask: id={running_subtask.id}, status={running_subtask.status}"
            )

            # Get partial content from Redis before cancelling
            partial_content = await session_manager.get_streaming_content(
                running_subtask.id
            )
            logger.info(
                f"[CANCEL] Got partial content from Redis: length={len(partial_content) if partial_content else 0}"
            )

            # Cancel the stream (this sets the cancel event)
            await session_manager.cancel_stream(running_subtask.id)
            logger.info(f"[CANCEL] Stream cancelled for subtask {running_subtask.id}")

            # Update subtask status to COMPLETED with partial content
            running_subtask.status = SubtaskStatus.COMPLETED
            running_subtask.progress = 100
            running_subtask.completed_at = datetime.now()
            running_subtask.updated_at = datetime.now()
            running_subtask.result = {"value": partial_content or ""}

            # Update task status to COMPLETED
            if task_crd.status:
                task_crd.status.status = "COMPLETED"
                task_crd.status.errorMessage = ""
                task_crd.status.updatedAt = datetime.now()
                task_crd.status.completedAt = datetime.now()
                task_crd.status.result = {"value": partial_content or ""}

            task_kind.json = task_crd.model_dump(mode="json")
            task_kind.updated_at = datetime.now()
            flag_modified(task_kind, "json")

            db.commit()
            db.refresh(task_kind)
            db.refresh(running_subtask)

            logger.info(
                f"[CANCEL] Chat Shell task cancelled: task_id={task_id}, subtask_id={running_subtask.id}"
            )
        else:
            logger.info(f"[CANCEL] No running subtask found for task {task_id}")
    else:
        # For Executor-based tasks, use the existing cancel service
        try:
            await task_kinds_service.cancel_task(
                db=db,
                task_id=task_id,
                user_id=current_user.id,
                background_task_runner=background_tasks.add_task,
            )
        except HTTPException as e:
            if e.status_code == 404:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Response '{response_id}' not found",
                )
            raise

    # Get updated task data for response
    try:
        task_dict = task_kinds_service.get_task_by_id(
            db, task_id=task_id, user_id=current_user.id
        )
    except HTTPException:
        # If task not found after cancel, return minimal response
        return ResponseObject(
            id=response_id,
            created_at=int(datetime.now().timestamp()),
            status="cancelled",
            model="unknown",
            output=[],
        )

    # Get subtasks for output (to include partial content)
    subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == current_user.id)
        .order_by(Subtask.message_id.asc())
        .all()
    )

    # Reconstruct model string
    model_string = "unknown"
    if task_kind and task_kind.json:
        task_crd = Task.model_validate(task_kind.json)
        team_name = task_crd.spec.teamRef.name
        team_namespace = task_crd.spec.teamRef.namespace
        model_id = (
            task_crd.metadata.labels.get("modelId")
            if task_crd.metadata.labels
            else None
        )
        if model_id:
            model_string = f"{team_namespace}#{team_name}#{model_id}"
        else:
            model_string = f"{team_namespace}#{team_name}"

    return _task_to_response_object(task_dict, model_string, subtasks=subtasks)


@router.delete("/{response_id}", response_model=ResponseDeletedObject)
async def delete_response(
    response_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Delete a response.

    For Chat Shell type tasks with running streams, this will stop the model request
    before deleting.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseDeletedObject confirming deletion
    """
    from app.services.chat.storage import session_manager

    # Extract task_id from response_id
    if not response_id.startswith("resp_"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    try:
        task_id = int(response_id[5:])
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid response_id format: '{response_id}'",
        )

    # Get task to check if it's a Chat Shell type with running stream
    task_kind = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active == True,
        )
        .first()
    )

    if task_kind:
        # Check if this is a Chat Shell task (source="chat_shell")
        task_crd = Task.model_validate(task_kind.json)
        source_label = (
            task_crd.metadata.labels.get("source") if task_crd.metadata.labels else None
        )
        is_chat_shell = source_label == "chat_shell"

        if is_chat_shell:
            # For Chat Shell tasks, stop any running stream before deleting
            running_subtask = (
                db.query(Subtask)
                .filter(
                    Subtask.task_id == task_id,
                    Subtask.user_id == current_user.id,
                    Subtask.role == SubtaskRole.ASSISTANT,
                    Subtask.status.in_(
                        [
                            SubtaskStatus.PENDING,
                            SubtaskStatus.RUNNING,
                        ]
                    ),
                )
                .order_by(Subtask.id.desc())
                .first()
            )

            if running_subtask:
                logger.info(
                    f"[DELETE] Stopping running stream before delete: task_id={task_id}, subtask_id={running_subtask.id}"
                )
                # Cancel the stream (this sets the cancel event)
                await session_manager.cancel_stream(running_subtask.id)
                # Clean up streaming content from Redis
                await session_manager.delete_streaming_content(running_subtask.id)
                await session_manager.unregister_stream(running_subtask.id)
                logger.info(f"[DELETE] Stream stopped for subtask {running_subtask.id}")

    try:
        task_kinds_service.delete_task(db, task_id=task_id, user_id=current_user.id)
    except HTTPException as e:
        if e.status_code == 404:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Response '{response_id}' not found",
            )
        raise

    return ResponseDeletedObject(id=response_id)

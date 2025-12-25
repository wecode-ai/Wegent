# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses endpoint.
Compatible with OpenAI Responses API format.
"""

import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Union

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole
from app.models.user import User
from app.schemas.kind import Bot, Task, Team
from app.schemas.openapi_response import (
    InputItem,
    OutputMessage,
    OutputTextContent,
    ResponseCreateInput,
    ResponseDeletedObject,
    ResponseError,
    ResponseObject,
    WegentTool,
)
from app.schemas.task import TaskCreate
from app.services.adapters.task_kinds import task_kinds_service
from app.services.adapters.team_kinds import team_kinds_service

logger = logging.getLogger(__name__)

router = APIRouter()


def _wegent_status_to_openai_status(wegent_status: str) -> str:
    """Convert Wegent task status to OpenAI response status."""
    status_mapping = {
        "PENDING": "queued",
        "RUNNING": "in_progress",
        "COMPLETED": "completed",
        "FAILED": "failed",
        "CANCELLED": "cancelled",
        "CANCELLING": "in_progress",
        "DELETE": "failed",
    }
    return status_mapping.get(wegent_status, "incomplete")


def _subtask_status_to_message_status(subtask_status: str) -> str:
    """Convert subtask status to output message status."""
    status_mapping = {
        "PENDING": "in_progress",
        "RUNNING": "in_progress",
        "COMPLETED": "completed",
        "FAILED": "incomplete",
        "CANCELLED": "incomplete",
    }
    return status_mapping.get(subtask_status, "incomplete")


def _parse_model_string(model: str) -> Dict[str, Any]:
    """
    Parse model string to extract team namespace, team name, and optional model id.
    Format: namespace#team_name or namespace#team_name#model_id
    """
    parts = model.split("#")
    if len(parts) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid model format: '{model}'. Expected format: 'namespace#team_name' or 'namespace#team_name#model_id'",
        )

    result = {
        "namespace": parts[0],
        "team_name": parts[1],
        "model_id": parts[2] if len(parts) > 2 else None,
    }
    return result


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
                    status=_subtask_status_to_message_status(subtask.status.value),
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
                    status=_subtask_status_to_message_status(subtask.status.value),
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
        status=_wegent_status_to_openai_status(wegent_status),
        error=error,
        model=model_string,
        output=output,
        previous_response_id=previous_response_id,
    )


def _parse_wegent_tools(tools: Optional[List[WegentTool]]) -> Dict[str, Any]:
    """
    Parse Wegent custom tools from request.

    Args:
        tools: List of WegentTool objects

    Returns:
        Dict with parsed tool settings
    """
    result = {
        "enable_deep_thinking": False,
    }
    if tools:
        for tool in tools:
            if tool.type == "wegent_deep_thinking":
                result["enable_deep_thinking"] = True
    return result


def _extract_input_text(
    input_data: Union[str, List[InputItem]]
) -> str:
    """
    Extract the user input text from the input field.

    Args:
        input_data: Either a string or list of InputItem

    Returns:
        The user's input text
    """
    if isinstance(input_data, str):
        return input_data

    # For list input, get the last user message
    for item in reversed(input_data):
        if isinstance(item, InputItem) and item.role == "user":
            return item.content
        elif isinstance(item, dict) and item.get("role") == "user":
            return item.get("content", "")

    # If no user message found, return empty string
    return ""


def _check_team_supports_direct_chat(db: Session, team: Kind, user_id: int) -> bool:
    """
    Check if the team supports direct chat mode.

    Returns True only if ALL bots in the team use Chat Shell type.
    This is a simplified version of the check from chat.py.

    Args:
        db: Database session
        team: Team Kind object
        user_id: User ID for lookup

    Returns:
        True if team supports direct chat
    """
    from app.schemas.kind import Shell
    from app.services.chat.base import ChatServiceBase

    team_crd = Team.model_validate(team.json)

    for member in team_crd.spec.members:
        # Find bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return False

        # Get shell type
        bot_crd = Bot.model_validate(bot.json)

        # Check user's custom shells first
        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        # If not found, check public shells
        if not shell:
            shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == bot_crd.spec.shellRef.name,
                    Kind.namespace == bot_crd.spec.shellRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

        if not shell or not shell.json:
            return False

        shell_crd = Shell.model_validate(shell.json)
        shell_type = shell_crd.spec.shellType

        if not ChatServiceBase.is_direct_chat_shell(shell_type):
            return False

    return True


async def _create_streaming_response(
    db: Session,
    user: User,
    team: Kind,
    model_info: Dict[str, Any],
    request_body: ResponseCreateInput,
    input_text: str,
    tool_settings: Dict[str, Any],
    task_id: Optional[int] = None,
) -> StreamingResponse:
    """
    Create a streaming response for Chat Shell type teams.

    This function creates task and subtask records similar to chat_namespace.py,
    then streams the LLM response while updating subtask status.

    Args:
        db: Database session
        user: Current user
        team: Team Kind object
        model_info: Parsed model info
        request_body: Original request body
        input_text: Extracted input text
        tool_settings: Parsed tool settings
        task_id: Optional existing task ID for follow-up conversations

    Returns:
        StreamingResponse with SSE events
    """
    from app.models.subtask import SenderType, SubtaskStatus
    from app.services.chat.model_resolver import (
        get_bot_system_prompt,
        get_model_config_for_bot,
    )
    from app.services.openapi.streaming import streaming_service

    # Get first bot for model config and system prompt
    team_crd = Team.model_validate(team.json)
    if not team_crd.spec.members:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Team has no members configured",
        )

    first_member = team_crd.spec.members[0]
    bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == team.user_id,
            Kind.kind == "Bot",
            Kind.name == first_member.botRef.name,
            Kind.namespace == first_member.botRef.namespace,
            Kind.is_active == True,
        )
        .first()
    )

    if not bot:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Bot not found for team",
        )

    # Get bot IDs from team members
    bot_ids = []
    for member in team_crd.spec.members:
        member_bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if member_bot:
            bot_ids.append(member_bot.id)

    if not bot_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid bots found in team",
        )

    # Get model config
    try:
        model_config = get_model_config_for_bot(
            db,
            bot,
            team.user_id,
            override_model_name=model_info.get("model_id"),
            force_override=model_info.get("model_id") is not None,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    # Get system prompt
    system_prompt = get_bot_system_prompt(db, bot, team.user_id, first_member.prompt)

    # Apply deep thinking settings to system prompt if enabled
    if tool_settings.get("enable_deep_thinking"):
        from app.services.chat_v2.utils.prompts import append_deep_thinking_prompt

        system_prompt = append_deep_thinking_prompt(system_prompt, True)

    # Create or get task
    task = None
    if task_id:
        task = (
            db.query(Kind)
            .filter(
                Kind.id == task_id,
                Kind.user_id == user.id,
                Kind.kind == "Task",
                Kind.is_active == True,
            )
            .first()
        )
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Task {task_id} not found",
            )

    if not task:
        # Create new task
        from app.services.adapters.task_kinds import task_kinds_service

        new_task_id = task_kinds_service.create_task_id(db, user.id)

        if not task_kinds_service.validate_task_id(db, new_task_id):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to create task ID",
            )

        # Create workspace
        workspace_name = f"workspace-{new_task_id}"
        workspace_json = {
            "kind": "Workspace",
            "spec": {"repository": {}},
            "status": {"state": "Available"},
            "metadata": {"name": workspace_name, "namespace": "default"},
            "apiVersion": "agent.wecode.io/v1",
        }

        workspace = Kind(
            user_id=user.id,
            kind="Workspace",
            name=workspace_name,
            namespace="default",
            json=workspace_json,
            is_active=True,
        )
        db.add(workspace)

        # Create task
        title = input_text[:50] + "..." if len(input_text) > 50 else input_text
        task_json = {
            "kind": "Task",
            "spec": {
                "title": title,
                "prompt": input_text,
                "teamRef": {"name": team.name, "namespace": team.namespace},
                "workspaceRef": {"name": workspace_name, "namespace": "default"},
                "is_group_chat": False,
            },
            "status": {
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "result": None,
                "errorMessage": "",
                "createdAt": datetime.now().isoformat(),
                "updatedAt": datetime.now().isoformat(),
                "completedAt": None,
            },
            "metadata": {
                "name": f"task-{new_task_id}",
                "namespace": "default",
                "labels": {
                    "type": "online",
                    "taskType": "chat",
                    "autoDeleteExecutor": "false",
                    "source": "api",
                    **({"modelId": model_info.get("model_id")} if model_info.get("model_id") else {}),
                    **({"forceOverrideBotModel": "true"} if model_info.get("model_id") else {}),
                },
            },
            "apiVersion": "agent.wecode.io/v1",
        }

        task = Kind(
            id=new_task_id,
            user_id=user.id,
            kind="Task",
            name=f"task-{new_task_id}",
            namespace="default",
            json=task_json,
            is_active=True,
        )
        db.add(task)
        task_id = new_task_id

    # Get existing subtasks to determine message_id
    existing_subtasks = (
        db.query(Subtask)
        .filter(Subtask.task_id == task_id, Subtask.user_id == user.id)
        .order_by(Subtask.message_id.desc())
        .all()
    )

    next_message_id = 1
    parent_id = 0
    if existing_subtasks:
        next_message_id = existing_subtasks[0].message_id + 1
        parent_id = existing_subtasks[0].message_id

    # Create USER subtask
    user_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title="User message",
        bot_ids=bot_ids,
        role=SubtaskRole.USER,
        executor_namespace="",
        executor_name="",
        prompt=input_text,
        status=SubtaskStatus.COMPLETED,
        progress=100,
        message_id=next_message_id,
        parent_id=parent_id,
        error_message="",
        completed_at=datetime.now(),
        result=None,
        sender_type=SenderType.USER,
        sender_user_id=user.id,
    )
    db.add(user_subtask)

    # Create ASSISTANT subtask (will be updated during streaming)
    assistant_subtask = Subtask(
        user_id=user.id,
        task_id=task_id,
        team_id=team.id,
        title="Assistant response",
        bot_ids=bot_ids,
        role=SubtaskRole.ASSISTANT,
        executor_namespace="",
        executor_name="",
        prompt="",
        status=SubtaskStatus.PENDING,
        progress=0,
        message_id=next_message_id + 1,
        parent_id=next_message_id,
        error_message="",
        result=None,
        completed_at=datetime.now(),  # Placeholder
        sender_type=SenderType.TEAM,
        sender_user_id=0,
    )
    db.add(assistant_subtask)

    db.commit()
    db.refresh(task)
    db.refresh(user_subtask)
    db.refresh(assistant_subtask)

    # Generate response ID
    response_id = f"resp_{task_id}"
    created_at = int(datetime.now().timestamp())

    # Store IDs for use in the generator
    assistant_subtask_id = assistant_subtask.id
    task_kind_id = task_id

    async def raw_chat_stream() -> AsyncGenerator[str, None]:
        """Generate raw text chunks from the LLM and update subtask."""
        import asyncio

        from app.api.dependencies import get_db as get_db_session
        from app.services.chat.base import get_http_client
        from app.services.chat.message_builder import message_builder
        from app.services.chat.providers import get_provider
        from app.services.chat.providers.base import ChunkType

        cancel_event = asyncio.Event()
        accumulated_content = ""

        # Get a new db session for the generator
        db_gen = next(get_db_session())

        try:
            # Update assistant subtask status to RUNNING
            subtask = db_gen.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
            if subtask:
                subtask.status = SubtaskStatus.RUNNING
                db_gen.commit()

            # Build messages (include chat history if task has previous messages)
            history = []
            if existing_subtasks:
                # Build history from existing subtasks
                sorted_subtasks = sorted(existing_subtasks, key=lambda s: s.message_id)
                for st in sorted_subtasks:
                    if st.status == SubtaskStatus.COMPLETED:
                        if st.role == SubtaskRole.USER and st.prompt:
                            history.append({"role": "user", "content": st.prompt})
                        elif st.role == SubtaskRole.ASSISTANT and st.result:
                            if isinstance(st.result, dict):
                                content = st.result.get("value", "")
                                if content:
                                    history.append({"role": "assistant", "content": content})

            messages = message_builder.build_messages(
                history=history,
                current_message=input_text,
                system_prompt=system_prompt,
            )

            # Get provider
            client = await get_http_client()
            provider = get_provider(model_config, client)
            if not provider:
                logger.error("Failed to create provider from model config")
                # Update subtask as failed
                subtask = db_gen.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
                if subtask:
                    subtask.status = SubtaskStatus.FAILED
                    subtask.error_message = "Failed to create provider"
                    db_gen.commit()
                return

            # Stream response
            async for chunk in provider.stream_chat(messages, cancel_event):
                if chunk.type == ChunkType.CONTENT and chunk.content:
                    accumulated_content += chunk.content
                    yield chunk.content
                elif chunk.type == ChunkType.ERROR:
                    logger.error(f"LLM error: {chunk.error}")
                    # Update subtask as failed
                    subtask = db_gen.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
                    if subtask:
                        subtask.status = SubtaskStatus.FAILED
                        subtask.error_message = chunk.error or "Unknown LLM error"
                        db_gen.commit()
                    return

            # Update assistant subtask with completed status and result
            subtask = db_gen.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
            if subtask:
                subtask.status = SubtaskStatus.COMPLETED
                subtask.progress = 100
                subtask.result = {"value": accumulated_content}
                subtask.completed_at = datetime.now()
                db_gen.commit()

            # Update task status
            task_kind = db_gen.query(Kind).filter(Kind.id == task_kind_id).first()
            if task_kind:
                task_crd = Task.model_validate(task_kind.json)
                if task_crd.status:
                    task_crd.status.status = "COMPLETED"
                    task_crd.status.updatedAt = datetime.now()
                    task_crd.status.completedAt = datetime.now()
                    task_kind.json = task_crd.model_dump(mode="json")
                    from sqlalchemy.orm.attributes import flag_modified
                    flag_modified(task_kind, "json")
                    db_gen.commit()

        except Exception as e:
            logger.exception(f"Error in raw_chat_stream: {e}")
            # Update subtask as failed
            try:
                subtask = db_gen.query(Subtask).filter(Subtask.id == assistant_subtask_id).first()
                if subtask:
                    subtask.status = SubtaskStatus.FAILED
                    subtask.error_message = str(e)
                    db_gen.commit()
            except Exception:
                pass
            raise
        finally:
            db_gen.close()

    # Use streaming service to convert to OpenAI format
    async def generate():
        async for event in streaming_service.create_streaming_response(
            response_id=response_id,
            model_string=request_body.model,
            chat_stream=raw_chat_stream(),
            created_at=created_at,
            previous_response_id=request_body.previous_response_id,
        ):
            yield event

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("")
async def create_response(
    request_body: ResponseCreateInput,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Create a new response (execute a task).

    This endpoint is compatible with OpenAI's Responses API format.

    When stream=False (default):
    - The response is returned immediately with status 'queued'.
    - Use GET /api/v1/responses/{response_id} to poll for completion.

    When stream=True (only for Chat Shell type teams):
    - Returns SSE stream with OpenAI v1/responses compatible events.
    - Only supported when all team bots use Chat Shell type.

    Args:
        request_body: ResponseCreateInput containing:
        - model: Format "namespace#team_name" or "namespace#team_name#model_id"
        - input: The user prompt (string or list of messages)
        - stream: Whether to enable streaming output (default: False)
        - tools: Optional Wegent tools (e.g., [{"type": "wegent_deep_thinking"}])
        - previous_response_id: Optional, for follow-up conversations

    Returns:
        ResponseObject with status 'queued' (non-streaming)
        or StreamingResponse with SSE events (streaming)
    """
    # Parse model string
    model_info = _parse_model_string(request_body.model)

    # Parse tools for settings
    tool_settings = _parse_wegent_tools(request_body.tools)

    # Extract input text
    input_text = _extract_input_text(request_body.input)

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
                db.query(Kind)
                .filter(
                    Kind.id == previous_task_id,
                    Kind.kind == "Task",
                    Kind.user_id == current_user.id,
                    Kind.is_active == True,
                )
                .first()
            )
            if not existing_task:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Previous response '{request_body.previous_response_id}' not found",
                )

    # Verify team exists and user has access
    team = team_kinds_service.get_team_by_name_and_namespace(
        db, model_info["team_name"], model_info["namespace"], current_user.id
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

        model_exists = False

        if model_namespace == "default":
            # First, query personal model (user's own model)
            personal_model = (
                db.query(Kind)
                .filter(
                    Kind.user_id == current_user.id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if personal_model:
                model_exists = True
            else:
                # If personal model not found, query public model (user_id = 0)
                public_model = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.kind == "Model",
                        Kind.name == model_name,
                        Kind.namespace == model_namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )

                if public_model:
                    model_exists = True
        else:
            # If namespace is not default, query group model
            group_model = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if group_model:
                model_exists = True

        if not model_exists:
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

            # Query the bot from Kind table
            bot_kind = (
                db.query(Kind)
                .filter(
                    Kind.name == bot_name,
                    Kind.namespace == bot_namespace,
                    Kind.kind == "Bot",
                    Kind.user_id == team.user_id,
                    Kind.is_active == True,
                )
                .first()
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

    # Handle streaming mode
    if request_body.stream:
        # Check if team supports direct chat (streaming requires Chat Shell)
        supports_direct_chat = _check_team_supports_direct_chat(
            db, team, current_user.id
        )

        if not supports_direct_chat:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Streaming is only supported for teams where all bots use Chat Shell type. "
                "Please set stream=false to use the queued response mode.",
            )

        # Return streaming response
        return await _create_streaming_response(
            db=db,
            user=current_user,
            team=team,
            model_info=model_info,
            request_body=request_body,
            input_text=input_text,
            tool_settings=tool_settings,
            task_id=task_id,
        )

    # Non-streaming mode: create task and return queued response
    task_create = TaskCreate(
        prompt=input_text,
        team_name=model_info["team_name"],
        team_namespace=model_info["namespace"],
        task_type="chat",
        type="online",
        source="api",
        model_id=model_info.get("model_id"),
        force_override_bot_model=model_info.get("model_id") is not None,
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
        db.query(Kind)
        .filter(
            Kind.id == task_id,
            Kind.kind == "Task",
            Kind.is_active == True,
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

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseObject with status 'cancelled' or current status
    """
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

    # Cancel task using service (includes executor_manager call)
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

    # Reconstruct model string
    task_kind = (
        db.query(Kind)
        .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active == True)
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

    return _task_to_response_object(task_dict, model_string)


@router.delete("/{response_id}", response_model=ResponseDeletedObject)
async def delete_response(
    response_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Delete a response.

    Args:
        response_id: Response ID in format "resp_{task_id}"

    Returns:
        ResponseDeletedObject confirming deletion
    """
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

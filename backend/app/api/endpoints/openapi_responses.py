# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
OpenAPI v1/responses endpoint.
Compatible with OpenAI Responses API format.
"""

import logging
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole
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


@router.post("", response_model=ResponseObject, status_code=status.HTTP_201_CREATED)
async def create_response(
    request_body: ResponseCreateInput,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user_flexible),
):
    """
    Create a new response (execute a task).

    This endpoint is compatible with OpenAI's Responses API format.
    The response is returned immediately with status 'queued'.
    Use GET /api/v1/responses/{response_id} to poll for completion.

    Args:
        request_body: ResponseCreateInput containing model, input, and optional previous_response_id
        - model: Format "namespace#team_name" or "namespace#team_name#model_id"
        - input: The user prompt
        - previous_response_id: Optional, for follow-up conversations

    Returns:
        ResponseObject with status 'queued'
    """
    # Parse model string
    model_info = _parse_model_string(request_body.model)

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

    # Create task using TaskKindsService
    task_create = TaskCreate(
        prompt=request_body.input,
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

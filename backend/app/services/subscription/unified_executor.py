# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified subscription executor.

This module provides a unified execution path for subscription tasks,
using the ExecutionDispatcher to handle different shell types:
- Chat Shell -> SSE mode (synchronous execution)
- ClaudeCode/Agno/Dify -> HTTP+Callback mode (asynchronous execution)
"""

import logging
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User

logger = logging.getLogger(__name__)


@dataclass
class SubscriptionExecutionData:
    """Data container for subscription execution.

    Contains all necessary data for executing a subscription task.
    This is extracted from ORM objects to be thread-safe.
    """

    # IDs
    subscription_id: int
    execution_id: int
    task_id: int
    subtask_id: int
    user_id: int
    team_id: int
    user_subtask_id: Optional[int]

    # Execution data
    prompt: str
    model_override_name: Optional[str]

    # Settings
    preserve_history: bool
    history_message_count: int

    # Subscription info for notifications
    subscription_name: str
    subscription_display_name: str
    team_display_name: str
    trigger_type: str
    trigger_reason: str

    # Default values must come last
    is_subscription: bool = True


async def execute_subscription_unified(
    db: Session,
    task: TaskResource,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    execution_data: SubscriptionExecutionData,
) -> None:
    """Execute subscription task using unified dispatcher.

    This function uses the ExecutionDispatcher to automatically select
    the appropriate communication mode based on shell_type:
    - Chat Shell -> SSE mode (synchronous, waits for completion)
    - ClaudeCode/Agno/Dify -> HTTP+Callback mode (asynchronous)

    For SSE mode, this function waits for the AI response to complete
    and updates the BackgroundExecution status directly.

    For HTTP+Callback mode, this function returns immediately after
    dispatching the task. The status update comes through the
    /internal/callback API.

    Args:
        db: Database session
        task: Task resource
        assistant_subtask: Assistant subtask for AI response
        team: Team Kind object
        user: User object
        execution_data: Subscription execution data
    """
    from app.core.config import settings
    from app.services.chat.trigger.unified import build_execution_request
    from app.services.execution import (
        CommunicationMode,
        ExecutionRouter,
        SubscriptionResultEmitter,
        execution_dispatcher,
    )
    from app.services.subscription.event_handler import (
        create_subscription_event_handler,
    )

    logger.info(
        f"[execute_subscription_unified] Starting execution: "
        f"subscription_id={execution_data.subscription_id}, "
        f"execution_id={execution_data.execution_id}, "
        f"task_id={execution_data.task_id}"
    )

    # Build execution request
    request = await build_execution_request(
        task=task,
        assistant_subtask=assistant_subtask,
        team=team,
        user=user,
        message=execution_data.prompt,
        payload=None,
        user_subtask_id=execution_data.user_subtask_id,
        history_limit=(
            execution_data.history_message_count
            if execution_data.preserve_history
            else None
        ),
        is_subscription=True,
        enable_tools=True,
        enable_deep_thinking=True,
    )

    # Determine communication mode
    router = ExecutionRouter()
    target = router.route(request, device_id=None)

    logger.info(
        f"[execute_subscription_unified] Routing result: "
        f"mode={target.mode.value}, url={target.url}"
    )

    # Get base URL for detail link
    base_url = getattr(settings, "TASK_SHARE_BASE_URL", None)

    # Create event handler for notifications
    event_handler = create_subscription_event_handler(
        subscription_id=execution_data.subscription_id,
        execution_id=execution_data.execution_id,
        subscription_display_name=execution_data.subscription_display_name,
        team_display_name=execution_data.team_display_name,
        trigger_reason=execution_data.trigger_reason,
        task_id=execution_data.task_id,
        base_url=base_url,
    )

    if target.mode == CommunicationMode.SSE:
        # SSE mode (Chat Shell) - synchronous execution
        # Use SSEResultEmitter + dispatch + collect to wait for completion
        await _execute_sse_sync(
            request=request,
            execution_data=execution_data,
            event_handler=event_handler,
        )
    else:
        # HTTP+Callback mode (ClaudeCode/Agno/Dify) - asynchronous execution
        # Dispatch and return immediately, status update via callback
        await _execute_http_callback(
            request=request,
            execution_data=execution_data,
        )


async def _execute_sse_sync(
    request: Any,
    execution_data: SubscriptionExecutionData,
    event_handler: Any,
) -> None:
    """Execute subscription via SSE mode (synchronous).

    Waits for the AI response to complete and updates status.

    Args:
        request: ExecutionRequest
        execution_data: Subscription execution data
        event_handler: Event handler for notifications
    """
    import asyncio

    from app.services.execution import SubscriptionResultEmitter, execution_dispatcher
    from app.services.execution.emitters import SSEResultEmitter

    logger.info(
        f"[_execute_sse_sync] Starting SSE sync execution: "
        f"execution_id={execution_data.execution_id}"
    )

    # Create subscription result emitter for status callbacks
    subscription_emitter = SubscriptionResultEmitter(
        task_id=execution_data.task_id,
        subtask_id=execution_data.subtask_id,
        execution_id=execution_data.execution_id,
        on_status_changed=event_handler.on_execution_completed,
    )

    try:
        # Create SSEResultEmitter for collecting response
        emitter = SSEResultEmitter(
            task_id=execution_data.task_id,
            subtask_id=execution_data.subtask_id,
        )

        # Start dispatch task (runs concurrently)
        dispatch_task = asyncio.create_task(
            execution_dispatcher.dispatch(request, emitter=emitter)
        )

        # Collect all content from emitter
        accumulated_content, final_event = await emitter.collect()

        # Wait for dispatch task to complete
        try:
            await dispatch_task
        except Exception:
            pass  # Error already handled via emitter

        logger.info(
            f"[_execute_sse_sync] SSE sync completed: "
            f"execution_id={execution_data.execution_id}, "
            f"content_length={len(accumulated_content)}"
        )

        # Emit DONE event to trigger status update via subscription emitter
        from shared.models import EventType, ExecutionEvent

        done_event = ExecutionEvent(
            type=EventType.DONE,
            task_id=execution_data.task_id,
            subtask_id=execution_data.subtask_id,
            result=final_event.result if final_event else None,
        )
        await subscription_emitter.emit(done_event)

    except Exception as e:
        logger.error(
            f"[_execute_sse_sync] SSE sync failed: "
            f"execution_id={execution_data.execution_id}, error={e}",
            exc_info=True,
        )

        # Emit ERROR event to trigger status update via subscription emitter
        from shared.models import EventType, ExecutionEvent

        error_event = ExecutionEvent(
            type=EventType.ERROR,
            task_id=execution_data.task_id,
            subtask_id=execution_data.subtask_id,
            error=str(e),
        )
        await subscription_emitter.emit(error_event)

    finally:
        await subscription_emitter.close()


async def _execute_http_callback(
    request: Any,
    execution_data: SubscriptionExecutionData,
) -> None:
    """Execute subscription via HTTP+Callback mode (asynchronous).

    Dispatches the task and returns immediately.
    Status update comes through /internal/callback API.

    Args:
        request: ExecutionRequest
        execution_data: Subscription execution data
    """
    from app.services.execution import execution_dispatcher

    logger.info(
        f"[_execute_http_callback] Starting HTTP+Callback execution: "
        f"execution_id={execution_data.execution_id}"
    )

    try:
        # Dispatch task - this returns immediately
        # The executor_manager will call /internal/callback when done
        await execution_dispatcher.dispatch(request, device_id=None, emitter=None)

        logger.info(
            f"[_execute_http_callback] Task dispatched: "
            f"execution_id={execution_data.execution_id}, "
            f"task_id={execution_data.task_id}"
        )

    except Exception as e:
        logger.error(
            f"[_execute_http_callback] Dispatch failed: "
            f"execution_id={execution_data.execution_id}, error={e}",
            exc_info=True,
        )

        # Update execution status to FAILED
        from app.db.session import get_db_session
        from app.schemas.subscription import BackgroundExecutionStatus
        from app.services.subscription import subscription_service

        with get_db_session() as db:
            subscription_service.update_execution_status(
                db,
                execution_id=execution_data.execution_id,
                status=BackgroundExecutionStatus.FAILED,
                error_message=f"Failed to dispatch task: {e}",
            )


def extract_subscription_execution_data(
    ctx: Any,
    task: TaskResource,
    assistant_subtask: Subtask,
    user_subtask: Optional[Subtask],
) -> SubscriptionExecutionData:
    """Extract subscription execution data from context.

    This function extracts all necessary data from ORM objects
    into a thread-safe data container.

    Args:
        ctx: SubscriptionExecutionContext
        task: Task resource
        assistant_subtask: Assistant subtask
        user_subtask: User subtask (optional)

    Returns:
        SubscriptionExecutionData
    """
    from app.schemas.kind import Team

    # Extract model override from Subscription CRD's modelRef if specified
    model_override_name = None
    if ctx.subscription_crd.spec.modelRef:
        model_override_name = ctx.subscription_crd.spec.modelRef.name

    # Extract team display name from Team CRD
    team_display_name = ctx.team.name
    try:
        team_crd = Team.model_validate(ctx.team.json)
        if team_crd.spec and team_crd.spec.displayName:
            team_display_name = team_crd.spec.displayName
    except Exception:
        pass  # Use team name as fallback

    return SubscriptionExecutionData(
        subscription_id=ctx.subscription.id,
        execution_id=ctx.execution.id,
        task_id=task.id,
        subtask_id=assistant_subtask.id,
        user_id=ctx.user.id,
        team_id=ctx.team.id,
        user_subtask_id=user_subtask.id if user_subtask else None,
        prompt=ctx.execution.prompt or "",
        model_override_name=model_override_name,
        preserve_history=ctx.preserve_history,
        history_message_count=ctx.history_message_count,
        is_subscription=True,
        subscription_name=ctx.subscription.name,
        subscription_display_name=(
            ctx.subscription_crd.spec.displayName or ctx.subscription.name
        ),
        team_display_name=team_display_name,
        trigger_type=ctx.trigger_type,
        trigger_reason=ctx.execution.trigger_reason or "",
    )

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SSE Streaming service for task execution.

This service handles the streaming of task execution progress using SSE (Server-Sent Events).
"""

import asyncio
import json
import logging
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.schemas.kind import Task
from app.schemas.sse import (
    NodeFinishedData,
    NodeStartedData,
    SSEEvent,
    SSEEventType,
    StreamTaskCreate,
    WorkflowFinishedData,
    WorkflowStartedData,
)
from app.schemas.task import TaskCreate, TaskStatus

logger = logging.getLogger(__name__)

# Polling interval in seconds
POLL_INTERVAL = 1.0
# Maximum timeout for streaming (10 minutes)
MAX_STREAM_TIMEOUT = 600


class TaskStreamingService:
    """Service for streaming task execution progress"""

    def __init__(self):
        self.active_streams: Dict[int, bool] = {}

    async def stream_task_execution(
        self,
        db: Session,
        task_id: int,
        user_id: int,
    ) -> AsyncGenerator[str, None]:
        """
        Stream task execution progress as SSE events.

        Args:
            db: Database session
            task_id: Task ID to stream
            user_id: User ID for permission check

        Yields:
            SSE formatted event strings
        """
        start_time = datetime.now()
        workflow_run_id = f"run_{task_id}_{int(start_time.timestamp())}"

        # Track subtask states for change detection
        subtask_states: Dict[int, str] = {}
        subtask_started: Dict[int, bool] = {}
        last_task_status = None

        try:
            self.active_streams[task_id] = True

            # Emit workflow_started event
            started_event = SSEEvent(
                event=SSEEventType.WORKFLOW_STARTED,
                task_id=task_id,
                data=WorkflowStartedData(
                    task_id=task_id,
                    workflow_run_id=workflow_run_id,
                    created_at=start_time,
                ).model_dump(mode="json"),
            )
            yield started_event.to_sse_format()

            iteration = 0
            while self.active_streams.get(task_id, False):
                iteration += 1

                # Check timeout
                elapsed = (datetime.now() - start_time).total_seconds()
                if elapsed > MAX_STREAM_TIMEOUT:
                    error_event = SSEEvent(
                        event=SSEEventType.ERROR,
                        task_id=task_id,
                        message="Stream timeout exceeded",
                    )
                    yield error_event.to_sse_format()
                    break

                # Refresh database session to get latest data
                db.expire_all()

                # Get current task status
                task = (
                    db.query(Kind)
                    .filter(
                        Kind.id == task_id,
                        Kind.user_id == user_id,
                        Kind.kind == "Task",
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not task:
                    error_event = SSEEvent(
                        event=SSEEventType.ERROR,
                        task_id=task_id,
                        message="Task not found",
                    )
                    yield error_event.to_sse_format()
                    break

                task_crd = Task.model_validate(task.json)
                current_task_status = (
                    task_crd.status.status if task_crd.status else "PENDING"
                )

                # Get all assistant subtasks for this task
                subtasks = (
                    db.query(Subtask)
                    .filter(
                        Subtask.task_id == task_id,
                        Subtask.user_id == user_id,
                        Subtask.role == SubtaskRole.ASSISTANT,
                    )
                    .order_by(Subtask.message_id.asc())
                    .all()
                )

                # Process subtask state changes
                for idx, subtask in enumerate(subtasks):
                    subtask_id = subtask.id
                    current_subtask_status = subtask.status.value

                    # Check if node started (transition to RUNNING)
                    if (
                        current_subtask_status == SubtaskStatus.RUNNING.value
                        and not subtask_started.get(subtask_id, False)
                    ):
                        subtask_started[subtask_id] = True

                        # Get bot name from subtask
                        bot_name = None
                        if subtask.bot_ids:
                            bot = (
                                db.query(Kind)
                                .filter(
                                    Kind.id == subtask.bot_ids[0],
                                    Kind.kind == "Bot",
                                    Kind.is_active == True,
                                )
                                .first()
                            )
                            if bot:
                                bot_name = bot.name

                        node_started_event = SSEEvent(
                            event=SSEEventType.NODE_STARTED,
                            task_id=task_id,
                            data=NodeStartedData(
                                node_id=str(subtask_id),
                                node_type="bot",
                                title=subtask.title or f"Bot {idx + 1}",
                                bot_name=bot_name,
                                index=idx,
                            ).model_dump(mode="json"),
                        )
                        yield node_started_event.to_sse_format()

                    # Check if node finished (transition to COMPLETED/FAILED/CANCELLED)
                    previous_status = subtask_states.get(subtask_id)
                    if (
                        current_subtask_status
                        in [
                            SubtaskStatus.COMPLETED.value,
                            SubtaskStatus.FAILED.value,
                            SubtaskStatus.CANCELLED.value,
                        ]
                        and previous_status != current_subtask_status
                    ):
                        status_map = {
                            SubtaskStatus.COMPLETED.value: "succeeded",
                            SubtaskStatus.FAILED.value: "failed",
                            SubtaskStatus.CANCELLED.value: "failed",
                        }

                        node_finished_event = SSEEvent(
                            event=SSEEventType.NODE_FINISHED,
                            task_id=task_id,
                            data=NodeFinishedData(
                                node_id=str(subtask_id),
                                status=status_map.get(
                                    current_subtask_status, "failed"
                                ),
                                outputs=subtask.result,
                                error_message=subtask.error_message,
                                execution_metadata={
                                    "progress": subtask.progress,
                                    "completed_at": (
                                        subtask.completed_at.isoformat()
                                        if subtask.completed_at
                                        else None
                                    ),
                                },
                            ).model_dump(mode="json"),
                        )
                        yield node_finished_event.to_sse_format()

                    # Update tracked state
                    subtask_states[subtask_id] = current_subtask_status

                # Check if task is complete
                if current_task_status in [
                    TaskStatus.COMPLETED.value,
                    TaskStatus.FAILED.value,
                    TaskStatus.CANCELLED.value,
                ]:
                    elapsed_time = (datetime.now() - start_time).total_seconds()

                    status_map = {
                        TaskStatus.COMPLETED.value: "succeeded",
                        TaskStatus.FAILED.value: "failed",
                        TaskStatus.CANCELLED.value: "cancelled",
                    }

                    finished_event = SSEEvent(
                        event=SSEEventType.WORKFLOW_FINISHED,
                        task_id=task_id,
                        data=WorkflowFinishedData(
                            status=status_map.get(current_task_status, "failed"),
                            outputs=task_crd.status.result if task_crd.status else None,
                            total_steps=len(subtasks),
                            elapsed_time=elapsed_time,
                            error_message=(
                                task_crd.status.errorMessage if task_crd.status else None
                            ),
                        ).model_dump(mode="json"),
                    )
                    yield finished_event.to_sse_format()
                    break

                last_task_status = current_task_status

                # Send periodic ping to keep connection alive
                if iteration % 30 == 0:  # Every 30 seconds
                    ping_event = SSEEvent(
                        event=SSEEventType.PING,
                        task_id=task_id,
                    )
                    yield ping_event.to_sse_format()

                # Wait before next poll
                await asyncio.sleep(POLL_INTERVAL)

        except Exception as e:
            logger.error(f"Error streaming task {task_id}: {str(e)}", exc_info=True)
            error_event = SSEEvent(
                event=SSEEventType.ERROR,
                task_id=task_id,
                message=f"Streaming error: {str(e)}",
            )
            yield error_event.to_sse_format()
        finally:
            self.active_streams.pop(task_id, None)

    def stop_stream(self, task_id: int) -> None:
        """Stop streaming for a specific task"""
        self.active_streams[task_id] = False


# Global service instance
task_streaming_service = TaskStreamingService()

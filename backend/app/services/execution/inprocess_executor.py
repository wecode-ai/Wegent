# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
In-process executor for standalone mode.

Directly executes tasks within the Backend process without Docker containers
or HTTP calls to executor_manager. This enables a simplified single-process
deployment suitable for local development and small-scale deployments.

Design:
- Uses executor's AgentService directly for task execution
- Creates a custom EventTransport that bridges executor events to Backend's ResultEmitter
- Runs execution in a background task to avoid blocking
"""

import asyncio
import logging
from typing import Optional

from shared.models import (
    EmitterBuilder,
    EventType,
    ExecutionEvent,
    ExecutionRequest,
)
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.models.responses_api_emitter import EventTransport

from .dispatcher import extract_completed_result
from .emitters import ResultEmitter

logger = logging.getLogger(__name__)


class EmitterBridgeTransport(EventTransport):
    """Transport that bridges executor events to Backend's ResultEmitter.

    This transport converts OpenAI Responses API format events from the executor
    to ExecutionEvent format and emits them via the Backend's ResultEmitter.
    """

    def __init__(
        self,
        emitter: ResultEmitter,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
    ):
        """Initialize the bridge transport.

        Args:
            emitter: Backend's ResultEmitter to forward events to
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
        """
        self.emitter = emitter
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.message_id = message_id
        self._offset = 0  # Track cumulative text offset

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> dict:
        """Send event by converting and forwarding to ResultEmitter.

        Args:
            event_type: OpenAI Responses API event type
            task_id: Task ID
            subtask_id: Subtask ID
            data: Event data
            message_id: Optional message ID
            executor_name: Optional executor name
            executor_namespace: Optional executor namespace

        Returns:
            Status dict indicating success
        """
        msg_id = message_id or self.message_id

        # Convert OpenAI Responses API events to ExecutionEvent
        event = self._convert_event(event_type, data, msg_id)

        if event:
            await self.emitter.emit(event)

        return {"status": "success"}

    def _convert_event(
        self,
        event_type: str,
        data: dict,
        message_id: Optional[int],
    ) -> Optional[ExecutionEvent]:
        """Convert OpenAI Responses API event to ExecutionEvent.

        Args:
            event_type: OpenAI Responses API event type
            data: Event data
            message_id: Optional message ID

        Returns:
            ExecutionEvent or None if event should be skipped
        """
        # response.output_text.delta -> CHUNK
        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            delta = data.get("delta", "")
            event = ExecutionEvent(
                type=EventType.CHUNK.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                content=delta,
                offset=self._offset,
                message_id=message_id,
            )
            self._offset += len(delta)
            return event

        # response.completed -> DONE
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            response_data = data.get("response", {})
            return ExecutionEvent(
                type=EventType.DONE.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                content="",
                result=extract_completed_result(response_data),
                message_id=message_id,
            )

        # error -> ERROR
        elif event_type == ResponsesAPIStreamEvents.ERROR.value:
            return ExecutionEvent(
                type=EventType.ERROR.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                error=data.get("message", "Unknown error"),
                message_id=message_id,
            )

        # response.incomplete -> CANCELLED
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            return ExecutionEvent(
                type=EventType.CANCELLED.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                message_id=message_id,
            )

        # response.output_item.added with function_call -> TOOL_START
        elif event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value:
            item = data.get("item", {})
            if item.get("type") == "function_call":
                import json

                call_id = item.get("call_id") or item.get("id", "")
                name = item.get("name", "")
                arguments_str = item.get("arguments", "")
                arguments = {}
                if arguments_str:
                    try:
                        arguments = json.loads(arguments_str)
                    except (json.JSONDecodeError, TypeError):
                        pass

                return ExecutionEvent(
                    type=EventType.TOOL_START.value,
                    task_id=self.task_id,
                    subtask_id=self.subtask_id,
                    tool_use_id=call_id,
                    tool_name=name,
                    tool_input=arguments,
                    data={
                        "blocks": data.get("blocks", []),
                        "display_name": data.get("display_name"),
                    },
                    message_id=message_id,
                )
            return None

        # function_call_arguments.done -> TOOL_RESULT
        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value:
            return ExecutionEvent(
                type=EventType.TOOL_RESULT.value,
                task_id=self.task_id,
                subtask_id=self.subtask_id,
                tool_use_id=data.get("call_id", data.get("item_id")),
                tool_output=data.get("output"),
                data={"blocks": data.get("blocks", [])},
                message_id=message_id,
            )

        # response.reasoning_summary_part.added -> THINKING
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value:
            part = data.get("part", {})
            if part.get("type") == "reasoning":
                return ExecutionEvent(
                    type=EventType.THINKING.value,
                    task_id=self.task_id,
                    subtask_id=self.subtask_id,
                    content=part.get("text", ""),
                    message_id=message_id,
                )
            return None

        # Skip lifecycle events
        elif event_type in (
            ResponsesAPIStreamEvents.RESPONSE_CREATED.value,
            ResponsesAPIStreamEvents.RESPONSE_IN_PROGRESS.value,
            ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            ResponsesAPIStreamEvents.CONTENT_PART_ADDED.value,
            ResponsesAPIStreamEvents.CONTENT_PART_DONE.value,
            ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value,
            ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
        ):
            return None

        # Unknown event type, skip
        logger.debug(
            f"[EmitterBridgeTransport] Unknown event type: {event_type}, skipping"
        )
        return None


class InprocessExecutor:
    """In-process executor for standalone mode.

    Directly executes tasks within the Backend process by calling
    executor's AgentService. This eliminates the need for Docker
    containers or HTTP calls to executor_manager.

    IMPORTANT: This executor runs agent code directly in the current event loop
    to avoid event loop conflicts. The agent's async methods are called directly
    instead of using run_in_executor with sync methods, which would create
    separate event loops and cause issues with Socket.IO's Redis connections.

    Client Management Strategy:
    - Each task_id has its own Claude Code client (supports parallel execution)
    - Same task's follow-up messages reuse the same client (efficient)
    - Session IDs are persisted to disk for resume support
    - AgentService (singleton) manages client lifecycle via _agent_sessions
    """

    async def execute(
        self,
        request: ExecutionRequest,
        emitter: ResultEmitter,
    ) -> None:
        """Execute task in-process.

        Args:
            request: Execution request
            emitter: Result emitter for event emission
        """
        logger.info(
            f"[InprocessExecutor] Starting in-process execution: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        try:
            # Import executor modules
            # Note: These imports are done here to avoid circular imports
            # and to ensure executor module is only loaded when needed
            from executor.services.agent_service import AgentService

            # Create bridge transport that forwards events to Backend's emitter
            bridge_transport = EmitterBridgeTransport(
                emitter=emitter,
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                message_id=request.message_id,
            )

            # Create executor emitter with bridge transport
            executor_emitter = (
                EmitterBuilder()
                .with_task(request.task_id, request.subtask_id)
                .with_transport(bridge_transport)
                .with_executor_info(name="inprocess", namespace="standalone")
                .build()
            )

            # Convert request to task_data dict for AgentService
            task_data = request.to_dict()

            # Get or create agent service (singleton)
            agent_service = AgentService()

            # Create agent with custom emitter
            # AgentService caches agents by task_id, so same task reuses the same agent
            agent = agent_service.create_agent(task_data)
            if not agent:
                raise RuntimeError(f"Failed to create agent for task {request.task_id}")

            # Override agent's emitter with our bridge emitter
            if hasattr(agent, "emitter"):
                agent.emitter = executor_emitter

            # Execute task
            logger.info(
                f"[InprocessExecutor] Executing agent: "
                f"task_id={request.task_id}, agent={agent.get_name()}"
            )

            # Execute agent directly in current event loop
            # IMPORTANT: Do NOT use run_in_executor here!
            # Using run_in_executor would run the sync execute() method in a thread pool,
            # which then creates a new event loop (see ClaudeCodeAgent.execute() line 542-550).
            # When that event loop is closed after execution, it corrupts the event loop state
            # and causes "Event loop is closed" errors on subsequent requests.
            #
            # Instead, we call the async execute_async() method directly, which:
            # 1. Runs in the current event loop (same as Socket.IO's Redis connections)
            # 2. Doesn't create/close separate event loops
            # 3. Properly shares the event loop with all async operations
            status, error_message = await self._execute_agent_async(agent)

            logger.info(
                f"[InprocessExecutor] Execution completed: "
                f"task_id={request.task_id}, status={status}, error={error_message}"
            )

            # Note: The agent's emitter will have already sent DONE/ERROR events
            # through the bridge transport, so we don't need to emit them again here

            # Cleanup: Close Claude Code client after task completion
            # This releases resources since standalone mode doesn't need to keep
            # clients alive for container reuse like Docker mode does
            await self._cleanup_task_clients(request.task_id)

        except Exception as e:
            logger.exception(
                f"[InprocessExecutor] Execution error: "
                f"task_id={request.task_id}, error={e}"
            )
            # Emit error event
            await emitter.emit_error(
                task_id=request.task_id,
                subtask_id=request.subtask_id,
                error=str(e),
                message_id=request.message_id,
            )
            raise

    async def _execute_agent_async(
        self,
        agent,
    ) -> tuple:
        """Execute agent asynchronously in the current event loop.

        This method handles the agent lifecycle (pre_execute, execute, post_execute)
        similar to Agent.handle(), but uses async methods to stay in the current
        event loop.

        Args:
            agent: The agent instance to execute

        Returns:
            Tuple of (TaskStatus, error_message)
        """
        from shared.status import TaskStatus

        try:
            # Pre-execute phase (sync, but fast)
            logger.info(
                f"Agent[{agent.get_name()}][{agent.task_id}] handle: Starting pre_execute."
            )
            pre_status = agent.pre_execute()
            if pre_status not in (TaskStatus.SUCCESS, TaskStatus.RUNNING):
                return pre_status, f"Pre-execute failed with status: {pre_status}"

            # Execute phase - use async method if available
            logger.info(
                f"Agent[{agent.get_name()}][{agent.task_id}] handle: pre_execute succeeded, starting execute."
            )

            # Check if agent has execute_async method (ClaudeCodeAgent, AgnoAgent)
            if hasattr(agent, "execute_async"):
                status = await agent.execute_async()
            else:
                # Fallback to sync execute for agents without async support
                # Run in executor to avoid blocking, but this may have event loop issues
                loop = asyncio.get_running_loop()
                status = await loop.run_in_executor(None, agent.execute)

            logger.info(
                f"Agent[{agent.get_name()}][{agent.task_id}] handle: execute finished with result: {status}"
            )

            # Post-execute phase (sync, but fast)
            agent.post_execute()

            return status, None

        except Exception as e:
            logger.exception(
                f"Agent[{agent.get_name()}][{agent.task_id}] handle: Exception during execution: {e}"
            )
            return TaskStatus.FAILED, str(e)

    async def _cleanup_task_clients(self, task_id: int) -> None:
        """Cleanup Claude Code clients after task completion.

        In standalone mode, we close clients after each task to release resources.
        The session_id is already persisted to disk by response_processor.py,
        so follow-up messages can resume the session using the 'resume' parameter.

        Args:
            task_id: Task ID to cleanup
        """
        try:
            from executor.agents.claude_code.session_manager import SessionManager

            cleaned_count = await SessionManager.cleanup_task_clients(task_id)
            if cleaned_count > 0:
                logger.info(
                    f"[InprocessExecutor] Cleaned up {cleaned_count} client(s) "
                    f"for task_id={task_id}"
                )
        except Exception as e:
            # Log but don't fail - cleanup is best effort
            logger.warning(
                f"[InprocessExecutor] Error cleaning up clients for "
                f"task_id={task_id}: {e}"
            )

    async def cancel(self, task_id: int) -> bool:
        """Cancel a running task.

        Args:
            task_id: Task ID to cancel

        Returns:
            True if cancellation was successful
        """
        try:
            from executor.services.agent_service import AgentService

            agent_service = AgentService()
            status, _ = agent_service.cancel_task(task_id)
            return status.value == "success"
        except Exception as e:
            logger.error(
                f"[InprocessExecutor] Cancel error: task_id={task_id}, error={e}"
            )
            return False

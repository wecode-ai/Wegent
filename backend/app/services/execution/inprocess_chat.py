# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0


"""Package-mode Chat Shell execution and event transport."""

import logging
from typing import Optional

from shared.models import ExecutionRequest

from .emitters import ResultEmitter
from .response_parser import ResponsesAPIEventParser

logger = logging.getLogger(__name__)


async def dispatch_inprocess_chat(
    request: ExecutionRequest,
    emitter: ResultEmitter,
    event_parser: ResponsesAPIEventParser,
) -> None:
    """Dispatch Chat type task via in-process chat_shell module.

    Uses chat_shell's ChatService directly for in-process execution.
    Creates a bridge emitter that converts ResponsesAPIEmitter events
    to ResultEmitter events.

    Args:
        request: Execution request
        emitter: Result emitter for event emission
    """
    logger.info(
        f"[ExecutionDispatcher] In-process chat dispatch: "
        f"task_id={request.task_id}, subtask_id={request.subtask_id}"
    )

    try:
        # Import chat_shell's ChatService
        from chat_shell.services.chat_service import ChatService
        from shared.models import EmitterBuilder

        # Create a bridge transport that forwards events to our ResultEmitter
        bridge_transport = ChatShellBridgeTransport(
            emitter=emitter,
            event_parser=event_parser,
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=request.message_id,
        )

        # Create ResponsesAPIEmitter with bridge transport
        responses_emitter = (
            EmitterBuilder()
            .with_task(request.task_id, request.subtask_id)
            .with_transport(bridge_transport)
            .with_executor_info(name="inprocess-chat", namespace="standalone")
            .build()
        )

        # Create ChatService and process request
        chat_service = ChatService()

        logger.info(
            f"[ExecutionDispatcher] In-process chat: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )

        # Call ChatService.chat() which handles all the streaming internally
        await chat_service.chat(request, responses_emitter)

        logger.info(
            f"[ExecutionDispatcher] In-process chat completed: "
            f"task_id={request.task_id}, subtask_id={request.subtask_id}"
        )
    except Exception as e:
        logger.exception(
            f"[ExecutionDispatcher] In-process chat error: "
            f"task_id={request.task_id}, error={e}"
        )
        # Don't emit_error here — the outer dispatch() handler already
        # emits a classified error with format_error_message. Emitting
        # twice causes a race on the frontend.
        raise


class ChatShellBridgeTransport:
    """Transport that bridges chat_shell's ResponsesAPIEmitter to Backend's ResultEmitter.

    This transport receives OpenAI Responses API format events from chat_shell
    and converts them to ExecutionEvent format for the Backend's ResultEmitter.
    """

    def __init__(
        self,
        emitter: ResultEmitter,
        event_parser: ResponsesAPIEventParser,
        task_id: int,
        subtask_id: int,
        message_id: Optional[int] = None,
    ):
        """Initialize the bridge transport.

        Args:
            emitter: Backend's ResultEmitter to forward events to
            event_parser: Parser for converting OpenAI events to ExecutionEvent
            task_id: Task ID
            subtask_id: Subtask ID
            message_id: Optional message ID
        """
        self.emitter = emitter
        self.event_parser = event_parser
        self.task_id = task_id
        self.subtask_id = subtask_id
        self.message_id = message_id

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

        # Parse event using shared parser
        parsed_event = self.event_parser.parse(
            task_id=self.task_id,
            subtask_id=self.subtask_id,
            message_id=msg_id,
            event_type=event_type,
            data=data,
        )

        if parsed_event:
            await self.emitter.emit(parsed_event)

        return {"status": "success"}

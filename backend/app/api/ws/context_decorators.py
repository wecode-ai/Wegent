# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Additional decorators for WebSocket event handlers to reduce code intrusion.
"""

import logging
from functools import wraps
from typing import Callable, Optional, Type

from pydantic import ValidationError
from shared.telemetry.context import set_task_context

logger = logging.getLogger(__name__)


def auto_task_context(
    payload_class: Type,
    task_id_field: Optional[str] = "task_id",
    subtask_id_field: Optional[str] = None,
):
    """
    Decorator to automatically extract and set task context from event payload.

    This decorator:
    1. Validates the payload using the provided Pydantic model
    2. Extracts task_id and/or subtask_id from the validated payload
    3. Sets task context for trace logging
    4. Returns validation errors if payload is invalid

    Args:
        payload_class: Pydantic model class for payload validation
        task_id_field: Field name for task_id (default: "task_id", set to None to skip)
        subtask_id_field: Field name for subtask_id (default: None)

    Usage:
        @auto_task_context(TaskJoinPayload, task_id_field="task_id")
        async def on_task_join(self, sid: str, data: dict):
            # payload is already validated and task context is set
            payload = data  # data is now the validated payload object
            ...

        @auto_task_context(ChatCancelPayload, subtask_id_field="subtask_id")
        async def on_chat_cancel(self, sid: str, data: dict):
            # Only subtask_id is extracted and set
            ...

        @auto_task_context(ChatResumePayload, task_id_field="task_id", subtask_id_field="subtask_id")
        async def on_chat_resume(self, sid: str, data: dict):
            # Both task_id and subtask_id are extracted
            ...

    Example - Before:
        async def on_task_join(self, sid: str, data: dict):
            try:
                payload = TaskJoinPayload(**data)
            except ValidationError as e:
                return {"error": f"Invalid payload: {e}"}

            # Set task context for trace logging
            set_task_context(task_id=payload.task_id)

            # ... business logic

    Example - After:
        @auto_task_context(TaskJoinPayload)
        async def on_task_join(self, sid: str, data: dict):
            payload = data  # Already validated!
            # Task context already set!
            # ... business logic
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(self, sid: str, data: dict):
            # Validate payload
            try:
                payload = payload_class(**data)
            except ValidationError as e:
                error_msg = f"Invalid payload: {e}"
                logger.error(f"[WS] {func.__name__} validation error: {e}")
                return {"error": error_msg}

            # Extract and set task context
            context_kwargs = {}
            if task_id_field and hasattr(payload, task_id_field):
                task_id = getattr(payload, task_id_field)
                if task_id is not None:
                    context_kwargs["task_id"] = task_id

            if subtask_id_field and hasattr(payload, subtask_id_field):
                subtask_id = getattr(payload, subtask_id_field)
                if subtask_id is not None:
                    context_kwargs["subtask_id"] = subtask_id

            # Set task context if we have any values
            if context_kwargs:
                try:
                    set_task_context(**context_kwargs)
                except Exception as e:
                    logger.debug(f"Failed to set task context: {e}")

            # Call original function with validated payload
            # Replace data with validated payload object
            return await func(self, sid, payload)

        return wrapper

    return decorator


def auto_payload_validation(payload_class: Type):
    """
    Lightweight decorator to only validate payload without setting context.

    This is useful when you only need validation but handle context manually,
    or when the payload doesn't contain task/subtask IDs.

    Args:
        payload_class: Pydantic model class for payload validation

    Usage:
        @auto_payload_validation(ChatSendPayload)
        async def on_chat_send(self, sid: str, data: dict):
            payload = data  # Already validated!
            # Handle context manually if needed
            if payload.task_id:
                set_task_context(task_id=payload.task_id)
            ...

    Example - Before:
        async def on_disconnect(self, sid: str):
            try:
                session = await self.get_session(sid)
                ...
            except ValidationError as e:
                return {"error": f"Invalid payload: {e}"}

    Example - After:
        @auto_payload_validation(DisconnectPayload)
        async def on_disconnect(self, sid: str, data: dict):
            payload = data  # Validated!
            ...
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(self, sid: str, data: dict):
            # Validate payload
            try:
                payload = payload_class(**data)
            except ValidationError as e:
                error_msg = f"Invalid payload: {e}"
                logger.error(f"[WS] {func.__name__} validation error: {e}")
                return {"error": error_msg}

            # Call original function with validated payload
            return await func(self, sid, payload)

        return wrapper

    return decorator

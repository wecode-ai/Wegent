# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Generic OpenTelemetry Span Manager.

This module provides a reusable SpanManager class for managing OpenTelemetry spans
across all services (chat, executor, webhook, etc.).
"""

import logging
from typing import Any, Dict, Optional

from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode
from shared.telemetry.core import is_telemetry_enabled

from app.core.config import settings

logger = logging.getLogger(__name__)


class SpanManager:
    """
    Generic OpenTelemetry span manager for any operation requiring tracing.

    This class encapsulates all span-related logic including:
    - Span creation and lifecycle management
    - Setting common attributes (user, task, model info)
    - Error recording with detailed context
    - Success recording with response metrics

    Can be used by chat, executor, webhook, or any other service.

    Usage Example:
        ```python
        from shared.telemetry.context import SpanManager, TelemetryEventNames

        span_manager = SpanManager("chat.stream_response")
        span_manager.create_span()
        span_manager.enter_span()

        try:
            span_manager.set_base_attributes(
                task_id=123,
                subtask_id=456,
                user_id="user_123",
                user_name="john"
            )
            span_manager.set_model_attributes(model_config)

            # Your business logic here
            ...

            span_manager.record_success(
                response_length=1024,
                response_chunks=10,
                event_name=TelemetryEventNames.MODEL_REQUEST_SUCCESS
            )

        except Exception as e:
            span_manager.record_error(TelemetryEventNames.GENERAL_ERROR, str(e))
            span_manager.record_exception(e)

        finally:
            span_manager.exit_span()
        ```

    Or use as context manager:
        ```python
        with SpanManager("operation.name") as span_manager:
            span_manager.set_base_attributes(...)
            # Your logic here
        ```
    """

    def __init__(self, span_name: str = "operation"):
        """
        Initialize the SpanManager.

        Args:
            span_name: Name of the span to create
        """
        self.span_name = span_name
        self.span_context = None
        self.span = None

    def should_create_span(self) -> bool:
        """
        Check if span should be created based on OTEL configuration.

        Returns:
            True if OTEL is enabled and telemetry is available
        """
        try:
            return settings.OTEL_ENABLED and is_telemetry_enabled()
        except Exception:
            return False

    def create_span(self) -> bool:
        """
        Create a new OpenTelemetry span.

        Returns:
            True if span was created successfully, False otherwise
        """
        if not self.should_create_span():
            return False

        try:
            tracer = trace.get_tracer(__name__)
            self.span_context = tracer.start_as_current_span(self.span_name)
            return True
        except Exception as e:
            logger.debug(f"Failed to create span: {e}")
            return False

    def enter_span(self) -> Optional[Any]:
        """
        Enter the span context.

        Returns:
            The span object if successful, None otherwise
        """
        if self.span_context:
            try:
                self.span = self.span_context.__enter__()
                return self.span
            except Exception as e:
                logger.debug(f"Failed to enter span: {e}")
        return None

    def exit_span(self) -> None:
        """Exit the span context and clean up."""
        if self.span_context:
            try:
                self.span_context.__exit__(None, None, None)
            except Exception as e:
                logger.debug(f"Failed to exit span: {e}")

    def set_base_attributes(
        self,
        task_id: int,
        subtask_id: int,
        user_id: str,
        user_name: str,
    ) -> None:
        """
        Set base attributes for the span (user and task info).

        Args:
            task_id: Task ID
            subtask_id: Subtask ID
            user_id: User ID
            user_name: User name
        """
        if not self.span or not self.span.is_recording():
            return

        try:
            self.span.set_attribute("task.id", task_id)
            self.span.set_attribute("subtask.id", subtask_id)
            self.span.set_attribute("user.id", str(user_id))
            self.span.set_attribute("user.name", user_name)
        except Exception as e:
            logger.debug(f"Failed to set base attributes: {e}")

    def set_model_attributes(self, model_config: Dict[str, Any]) -> None:
        """
        Set model-related attributes for the span.

        Args:
            model_config: Model configuration dictionary
        """
        if not self.span or not self.span.is_recording():
            return

        try:
            # Try both 'model_id' and 'model' keys (different providers use different keys)
            model_name = model_config.get("model_id") or model_config.get(
                "model", "unknown"
            )
            model_type = model_config.get("model_type", "unknown")
            base_url = model_config.get("base_url", "unknown")

            self.span.set_attribute("model.id", model_name)
            self.span.set_attribute("model.type", model_type)
            self.span.set_attribute("model.base_url", base_url)
        except Exception as e:
            logger.debug(f"Failed to set model attributes: {e}")

    def record_error(
        self,
        error_type: str,
        error_message: str,
        model_config: Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Record an error in the span with detailed context.

        Args:
            error_type: Type of error (e.g., "BotNotFound", "StreamChunkError")
            error_message: Error message
            model_config: Optional model configuration for additional context

        Returns:
            Detailed error message with model context (if provided)
        """
        if not self.span or not self.span.is_recording():
            return error_message

        try:
            # Build detailed error message if model config is provided
            detailed_error = error_message
            if model_config:
                model_name = model_config.get("model_id") or model_config.get(
                    "model", "unknown"
                )
                model_type = model_config.get("model_type", "unknown")
                base_url = model_config.get("base_url", "unknown")

                detailed_error = f"{error_message} (model_id: {model_name}, model_type: {model_type}, base_url: {base_url})"

                # Set model attributes
                self.span.set_attribute("model.id", model_name)
                self.span.set_attribute("model.type", model_type)
                self.span.set_attribute("model.base_url", base_url)

            # Set error attributes
            self.span.set_attribute("error", True)
            self.span.set_attribute("error.type", error_type)
            self.span.set_attribute("error.message", detailed_error)
            self.span.set_status(Status(StatusCode.ERROR, description=detailed_error))

            return detailed_error
        except Exception as e:
            logger.debug(f"Failed to record error in span: {e}")
            return error_message

    def record_exception(self, exception: Exception) -> None:
        """
        Record an exception in the span.

        Args:
            exception: Exception object to record
        """
        if not self.span or not self.span.is_recording():
            return

        try:
            self.span.record_exception(exception)
            self.span.set_status(Status(StatusCode.ERROR, description=str(exception)))
        except Exception as e:
            logger.debug(f"Failed to record exception in span: {e}")

    def record_success(
        self,
        response_length: int = 0,
        response_chunks: int = 0,
        event_name: Optional[str] = None,
    ) -> None:
        """
        Record successful completion with response metrics.

        Args:
            response_length: Length of the full response
            response_chunks: Number of chunks in the response
            event_name: Optional event name to tag the success (e.g., TelemetryEventNames.MODEL_REQUEST_SUCCESS)
        """
        if not self.span or not self.span.is_recording():
            return

        try:
            self.span.set_status(Status(StatusCode.OK))

            # Set event name if provided
            if event_name:
                self.span.set_attribute("event.name", event_name)

            if response_length > 0:
                self.span.set_attribute("response.length", response_length)
            if response_chunks > 0:
                self.span.set_attribute("response.chunks", response_chunks)
        except Exception as e:
            logger.debug(f"Failed to record success in span: {e}")

    def __enter__(self):
        """Context manager entry."""
        self.create_span()
        self.enter_span()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        if exc_val:
            self.record_exception(exc_val)
        self.exit_span()
        return False  # Don't suppress exceptions

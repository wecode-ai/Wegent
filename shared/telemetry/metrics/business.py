# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Business metrics for Wegent services.

Provides pre-defined metrics for tracking business operations
such as sessions, messages, tasks, users, and model calls.
"""

import logging
from typing import Any, Dict, Optional

from opentelemetry.metrics import Counter, Histogram, UpDownCounter

from shared.telemetry.core import get_meter, is_telemetry_enabled

logger = logging.getLogger(__name__)


class WegentMetrics:
    """
    Pre-defined business metrics for Wegent services.
    All metrics are lazily initialized on first access.
    """

    _instance: Optional["WegentMetrics"] = None
    _initialized: bool = False

    def __new__(cls) -> "WegentMetrics":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._meter = get_meter("wegent.metrics")
        self._metrics: Dict[str, Any] = {}
        self._initialized = True

    def _get_or_create_counter(
        self, name: str, description: str, unit: str = "1"
    ) -> Counter:
        """Get or create a Counter metric."""
        if name not in self._metrics:
            self._metrics[name] = self._meter.create_counter(
                name=name, description=description, unit=unit
            )
        return self._metrics[name]

    def _get_or_create_up_down_counter(
        self, name: str, description: str, unit: str = "1"
    ) -> UpDownCounter:
        """Get or create an UpDownCounter metric."""
        if name not in self._metrics:
            self._metrics[name] = self._meter.create_up_down_counter(
                name=name, description=description, unit=unit
            )
        return self._metrics[name]

    def _get_or_create_histogram(
        self, name: str, description: str, unit: str = "ms"
    ) -> Histogram:
        """Get or create a Histogram metric."""
        if name not in self._metrics:
            self._metrics[name] = self._meter.create_histogram(
                name=name, description=description, unit=unit
            )
        return self._metrics[name]

    # Session metrics
    @property
    def session_opened(self) -> Counter:
        """Counter for opened sessions."""
        return self._get_or_create_counter(
            "wegent.session.opened",
            "Number of sessions opened",
        )

    @property
    def session_active(self) -> UpDownCounter:
        """UpDownCounter for currently active sessions."""
        return self._get_or_create_up_down_counter(
            "wegent.session.active",
            "Number of currently active sessions",
        )

    # Message metrics
    @property
    def message_sent(self) -> Counter:
        """Counter for sent messages."""
        return self._get_or_create_counter(
            "wegent.message.sent",
            "Number of messages sent",
        )

    @property
    def message_by_type(self) -> Counter:
        """Counter for messages by type."""
        return self._get_or_create_counter(
            "wegent.message.by_type",
            "Number of messages by type",
        )

    # Task metrics
    @property
    def task_created(self) -> Counter:
        """Counter for created tasks."""
        return self._get_or_create_counter(
            "wegent.task.created",
            "Number of tasks created",
        )

    @property
    def task_completed(self) -> Counter:
        """Counter for completed tasks."""
        return self._get_or_create_counter(
            "wegent.task.completed",
            "Number of tasks completed",
        )

    @property
    def task_failed(self) -> Counter:
        """Counter for failed tasks."""
        return self._get_or_create_counter(
            "wegent.task.failed",
            "Number of tasks failed",
        )

    @property
    def task_duration(self) -> Histogram:
        """Histogram for task execution duration."""
        return self._get_or_create_histogram(
            "wegent.task.duration",
            "Task execution duration in milliseconds",
            unit="ms",
        )

    # User metrics
    @property
    def user_active(self) -> Counter:
        """Counter for active users."""
        return self._get_or_create_counter(
            "wegent.user.active",
            "Number of active users",
        )

    @property
    def user_new(self) -> Counter:
        """Counter for new users."""
        return self._get_or_create_counter(
            "wegent.user.new",
            "Number of new user registrations",
        )

    # Model metrics
    @property
    def model_calls(self) -> Counter:
        """Counter for model API calls."""
        return self._get_or_create_counter(
            "wegent.model.calls",
            "Number of model API calls",
        )

    @property
    def model_tokens(self) -> Counter:
        """Counter for token consumption."""
        return self._get_or_create_counter(
            "wegent.model.tokens",
            "Number of tokens consumed",
            unit="tokens",
        )


def get_wegent_metrics() -> WegentMetrics:
    """
    Get the singleton WegentMetrics instance.

    Returns:
        WegentMetrics: The metrics instance
    """
    return WegentMetrics()


def record_session_opened(
    user_id: Optional[str] = None, team_id: Optional[str] = None
) -> None:
    """
    Record a session opened event.

    Args:
        user_id: Optional user identifier
        team_id: Optional team identifier
    """
    if not is_telemetry_enabled():
        return

    try:
        attributes = {}
        if user_id:
            attributes["user_id"] = user_id
        if team_id:
            attributes["team_id"] = team_id

        get_wegent_metrics().session_opened.add(1, attributes)
    except Exception as e:
        logger.debug(f"Failed to record session opened metric: {e}")


def record_session_active_change(delta: int) -> None:
    """
    Record a change in active session count.

    Args:
        delta: Change in active sessions (+1 for new session, -1 for closed session)
    """
    if not is_telemetry_enabled():
        return

    try:
        get_wegent_metrics().session_active.add(delta)
    except Exception as e:
        logger.debug(f"Failed to record session active metric: {e}")


def record_message_sent(
    user_id: Optional[str] = None,
    team_id: Optional[str] = None,
    bot_id: Optional[str] = None,
    message_type: Optional[str] = None,
) -> None:
    """
    Record a message sent event.

    Args:
        user_id: Optional user identifier
        team_id: Optional team identifier
        bot_id: Optional bot identifier
        message_type: Optional message type (e.g., "text", "code", "image")
    """
    if not is_telemetry_enabled():
        return

    try:
        metrics = get_wegent_metrics()

        # Record message sent
        attributes = {}
        if user_id:
            attributes["user_id"] = user_id
        if team_id:
            attributes["team_id"] = team_id
        if bot_id:
            attributes["bot_id"] = bot_id

        metrics.message_sent.add(1, attributes)

        # Record by message type if provided
        if message_type:
            metrics.message_by_type.add(1, {"message_type": message_type})

    except Exception as e:
        logger.debug(f"Failed to record message sent metric: {e}")


def record_task_created(
    user_id: Optional[str] = None, team_id: Optional[str] = None
) -> None:
    """
    Record a task created event.

    Args:
        user_id: Optional user identifier
        team_id: Optional team identifier
    """
    if not is_telemetry_enabled():
        return

    try:
        attributes = {}
        if user_id:
            attributes["user_id"] = user_id
        if team_id:
            attributes["team_id"] = team_id

        get_wegent_metrics().task_created.add(1, attributes)
    except Exception as e:
        logger.debug(f"Failed to record task created metric: {e}")


def record_task_completed(
    user_id: Optional[str] = None,
    team_id: Optional[str] = None,
    agent_type: Optional[str] = None,
    duration_ms: Optional[float] = None,
) -> None:
    """
    Record a task completed event.

    Args:
        user_id: Optional user identifier
        team_id: Optional team identifier
        agent_type: Optional agent type (e.g., "ClaudeCode", "Agno", "Dify")
        duration_ms: Optional task duration in milliseconds
    """
    if not is_telemetry_enabled():
        return

    try:
        metrics = get_wegent_metrics()

        attributes = {}
        if user_id:
            attributes["user_id"] = user_id
        if team_id:
            attributes["team_id"] = team_id
        if agent_type:
            attributes["agent_type"] = agent_type

        metrics.task_completed.add(1, attributes)

        # Record duration if provided
        if duration_ms is not None:
            duration_attrs = {}
            if agent_type:
                duration_attrs["agent_type"] = agent_type
            metrics.task_duration.record(duration_ms, duration_attrs)

    except Exception as e:
        logger.debug(f"Failed to record task completed metric: {e}")


def record_task_failed(
    user_id: Optional[str] = None,
    team_id: Optional[str] = None,
    agent_type: Optional[str] = None,
) -> None:
    """
    Record a task failed event.

    Args:
        user_id: Optional user identifier
        team_id: Optional team identifier
        agent_type: Optional agent type
    """
    if not is_telemetry_enabled():
        return

    try:
        attributes = {}
        if user_id:
            attributes["user_id"] = user_id
        if team_id:
            attributes["team_id"] = team_id
        if agent_type:
            attributes["agent_type"] = agent_type

        get_wegent_metrics().task_failed.add(1, attributes)
    except Exception as e:
        logger.debug(f"Failed to record task failed metric: {e}")


def record_user_activity(is_new: bool = False) -> None:
    """
    Record user activity.

    Args:
        is_new: Whether this is a new user registration
    """
    if not is_telemetry_enabled():
        return

    try:
        metrics = get_wegent_metrics()
        metrics.user_active.add(1)

        if is_new:
            metrics.user_new.add(1)

    except Exception as e:
        logger.debug(f"Failed to record user activity metric: {e}")


def record_model_call(
    model_name: Optional[str] = None,
    agent_type: Optional[str] = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
) -> None:
    """
    Record a model API call.

    Args:
        model_name: Name of the model called
        agent_type: Type of agent making the call
        input_tokens: Number of input tokens
        output_tokens: Number of output tokens
    """
    if not is_telemetry_enabled():
        return

    try:
        metrics = get_wegent_metrics()

        # Record model call
        call_attributes = {}
        if model_name:
            call_attributes["model_name"] = model_name
        if agent_type:
            call_attributes["agent_type"] = agent_type

        metrics.model_calls.add(1, call_attributes)

        # Record token consumption
        if input_tokens > 0:
            token_attrs = {"token_type": "input"}
            if model_name:
                token_attrs["model_name"] = model_name
            metrics.model_tokens.add(input_tokens, token_attrs)

        if output_tokens > 0:
            token_attrs = {"token_type": "output"}
            if model_name:
                token_attrs["model_name"] = model_name
            metrics.model_tokens.add(output_tokens, token_attrs)

    except Exception as e:
        logger.debug(f"Failed to record model call metric: {e}")

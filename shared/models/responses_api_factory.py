# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Factory module for ResponsesAPIEmitter.

This module provides:
- TransportFactory: Factory class for creating EventTransport instances
- EmitterBuilder: Builder pattern for constructing ResponsesAPIEmitter
- TransportType: Enum for transport types
- RedisTransport: Redis pub/sub transport for chat_shell bridge mode

Design Principles:
- Composition over Inheritance
- Depend on abstractions, not concretions
- Builder pattern solves parameter explosion problem
- Factory pattern encapsulates Transport creation logic

Usage:
    # Executor Docker mode
    emitter = EmitterBuilder() \\
        .with_task(task_id, subtask_id) \\
        .with_transport(TransportFactory.create_callback()) \\
        .with_executor_info(name="executor-1", namespace="default") \\
        .build()

    # Executor Local mode
    emitter = EmitterBuilder() \\
        .with_task(task_id, subtask_id) \\
        .with_transport(TransportFactory.create_websocket(ws_client)) \\
        .build()

    # Chat Shell SSE mode
    emitter = EmitterBuilder() \\
        .with_task(task_id, subtask_id) \\
        .with_transport(TransportFactory.create_generator()) \\
        .build()

    # Chat Shell Bridge mode
    emitter = EmitterBuilder() \\
        .with_task(task_id, subtask_id) \\
        .with_transport(TransportFactory.create_redis(session_manager)) \\
        .build()
"""

import json
import logging
from enum import Enum
from typing import TYPE_CHECKING, Any, Callable, Optional

from .responses_api_emitter import (
    CallbackTransport,
    EventTransport,
    GeneratorTransport,
    ResponsesAPIEmitter,
    WebSocketTransport,
)
from .throttled_transport import ThrottleConfig, ThrottledTransport

if TYPE_CHECKING:
    from shared.utils.callback_client import CallbackClient

logger = logging.getLogger(__name__)

__all__ = [
    "TransportType",
    "TransportFactory",
    "EmitterBuilder",
    "RedisTransport",
    "ThrottleConfig",
    "ThrottledTransport",
]


class TransportType(Enum):
    """Transport type enumeration."""

    CALLBACK = "callback"  # HTTP callback (executor Docker mode)
    WEBSOCKET = "websocket"  # WebSocket (executor local mode)
    GENERATOR = "generator"  # SSE generator (chat_shell)
    REDIS = "redis"  # Redis pub/sub (chat_shell bridge mode)


class RedisTransport(EventTransport):
    """Redis pub/sub transport for chat_shell bridge mode.

    Publishes streaming events to Redis Pub/Sub channel.
    WebSocketBridge subscribes to the channel and forwards events to WebSocket clients.

    This enables the bridge architecture:
    StreamingCore -> RedisTransport -> Redis Pub/Sub -> WebSocketBridge -> WebSocket
    """

    def __init__(self, storage_handler: Any):
        """Initialize Redis transport.

        Args:
            storage_handler: Storage handler with publish methods (required).
                           Must have a publish_streaming_chunk(subtask_id, data) method.

        Raises:
            ValueError: If storage_handler is None.
        """
        if storage_handler is None:
            raise ValueError(
                "storage_handler is required for RedisTransport. "
                "Pass session_manager from backend when creating the transport."
            )
        self._storage = storage_handler

    def _get_storage(self):
        """Get storage handler."""
        return self._storage

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> None:
        """Publish event to Redis channel.

        Args:
            event_type: Event type string
            task_id: Task ID
            subtask_id: Subtask ID
            data: Event data
            message_id: Optional message ID
            executor_name: Optional executor name (unused for Redis)
            executor_namespace: Optional executor namespace (unused for Redis)
        """
        storage = self._get_storage()
        event = {
            "event_type": event_type,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "data": data,
        }
        if message_id is not None:
            event["message_id"] = message_id

        await storage.publish_streaming_chunk(subtask_id, json.dumps(event))
        logger.debug(
            "[REDIS_TRANSPORT] Published event: type=%s, subtask_id=%d",
            event_type,
            subtask_id,
        )


class TransportFactory:
    """Factory class for creating EventTransport instances.

    Single responsibility: only responsible for creating Transport instances
    based on type.
    """

    @staticmethod
    def create_callback(
        callback_url: Optional[str] = None, client: Optional["CallbackClient"] = None
    ) -> CallbackTransport:
        """Create HTTP Callback Transport.

        Args:
            callback_url: URL for the callback endpoint (required if client is None)
            client: HTTP callback client. If None, creates CallbackClient with callback_url.

        Returns:
            CallbackTransport instance

        Raises:
            ValueError: If neither callback_url nor client is provided
        """
        if client is None:
            if callback_url is None:
                raise ValueError("callback_url is required when client is not provided")
            from shared.utils.callback_client import CallbackClient

            client = CallbackClient(callback_url=callback_url)
        return CallbackTransport(client)

    @staticmethod
    def create_websocket(
        client: Any, event_mapping: Optional[dict] = None
    ) -> WebSocketTransport:
        """Create WebSocket Transport.

        Args:
            client: WebSocket client (required)
            event_mapping: Event type to socket event name mapping

        Returns:
            WebSocketTransport instance
        """
        return WebSocketTransport(client, event_mapping)

    @staticmethod
    def create_generator(
        callback: Optional[Callable[[str, dict], Any]] = None,
    ) -> GeneratorTransport:
        """Create Generator Transport (for SSE).

        Args:
            callback: Optional callback function

        Returns:
            GeneratorTransport instance
        """
        return GeneratorTransport(callback)

    @staticmethod
    def create_redis(storage_handler: Any) -> RedisTransport:
        """Create Redis Transport.

        Args:
            storage_handler: Storage handler with publish methods (required).
                           Must have a publish_streaming_chunk(subtask_id, data) method.
                           Typically pass session_manager from backend.

        Returns:
            RedisTransport instance

        Raises:
            ValueError: If storage_handler is None
        """
        return RedisTransport(storage_handler)

    @staticmethod
    def create_callback_throttled(
        callback_url: Optional[str] = None,
        client: Optional["CallbackClient"] = None,
        config: Optional[ThrottleConfig] = None,
    ) -> ThrottledTransport:
        """Create HTTP Callback Transport with throttling.

        Args:
            callback_url: URL for the callback endpoint (required if client is None)
            client: HTTP callback client. If None, creates CallbackClient with callback_url.
            config: Throttle configuration

        Returns:
            ThrottledTransport wrapping CallbackTransport

        Raises:
            ValueError: If neither callback_url nor client is provided
        """
        base = TransportFactory.create_callback(
            callback_url=callback_url, client=client
        )
        return ThrottledTransport(base, config)

    @staticmethod
    def create_websocket_throttled(
        client: Any,
        event_mapping: Optional[dict] = None,
        config: Optional[ThrottleConfig] = None,
    ) -> ThrottledTransport:
        """Create WebSocket Transport with throttling.

        Args:
            client: WebSocket client (required)
            event_mapping: Event type to socket event name mapping
            config: Throttle configuration

        Returns:
            ThrottledTransport wrapping WebSocketTransport
        """
        base = TransportFactory.create_websocket(client, event_mapping)
        return ThrottledTransport(base, config)

    @staticmethod
    def with_throttle(
        transport: EventTransport,
        config: Optional[ThrottleConfig] = None,
    ) -> ThrottledTransport:
        """Add throttling to any Transport.

        Args:
            transport: Transport to wrap
            config: Throttle configuration

        Returns:
            ThrottledTransport wrapping the given transport
        """
        return ThrottledTransport(transport, config)


class EmitterBuilder:
    """Builder for constructing ResponsesAPIEmitter instances.

    Solves parameter explosion problem with fluent chainable API.

    Usage:
        # Executor Docker mode
        emitter = EmitterBuilder() \\
            .with_task(task_id, subtask_id) \\
            .with_transport(TransportFactory.create_callback()) \\
            .with_executor_info(name="executor-1", namespace="default") \\
            .build()

        # Executor Local mode
        emitter = EmitterBuilder() \\
            .with_task(task_id, subtask_id) \\
            .with_transport(TransportFactory.create_websocket(ws_client)) \\
            .build()

        # Chat Shell SSE mode
        emitter = EmitterBuilder() \\
            .with_task(task_id, subtask_id) \\
            .with_transport(TransportFactory.create_generator()) \\
            .build()
    """

    def __init__(self):
        """Initialize builder with default values."""
        self._task_id: Optional[int] = None
        self._subtask_id: Optional[int] = None
        self._transport: Optional[EventTransport] = None
        self._model: str = ""
        self._message_id: Optional[int] = None
        self._executor_name: Optional[str] = None
        self._executor_namespace: Optional[str] = None

    def with_task(self, task_id: int, subtask_id: int) -> "EmitterBuilder":
        """Set task information (required).

        Args:
            task_id: Task ID
            subtask_id: Subtask ID

        Returns:
            Self for chaining
        """
        self._task_id = task_id
        self._subtask_id = subtask_id
        return self

    def with_transport(self, transport: EventTransport) -> "EmitterBuilder":
        """Set transport layer (required).

        Args:
            transport: EventTransport instance

        Returns:
            Self for chaining
        """
        self._transport = transport
        return self

    def with_model(self, model: str) -> "EmitterBuilder":
        """Set model identifier (optional).

        Args:
            model: Model identifier string

        Returns:
            Self for chaining
        """
        self._model = model
        return self

    def with_message_id(self, message_id: int) -> "EmitterBuilder":
        """Set message ID (optional).

        Args:
            message_id: Message ID

        Returns:
            Self for chaining
        """
        self._message_id = message_id
        return self

    def with_executor_info(
        self,
        name: Optional[str] = None,
        namespace: Optional[str] = None,
    ) -> "EmitterBuilder":
        """Set executor information (optional).

        Args:
            name: Executor name
            namespace: Executor namespace

        Returns:
            Self for chaining
        """
        self._executor_name = name
        self._executor_namespace = namespace
        return self

    def build(self) -> ResponsesAPIEmitter:
        """Build ResponsesAPIEmitter instance.

        Returns:
            Configured ResponsesAPIEmitter

        Raises:
            ValueError: If required parameters are missing
        """
        if self._task_id is None or self._subtask_id is None:
            raise ValueError(
                "task_id and subtask_id are required. Use with_task() to set them."
            )
        if self._transport is None:
            raise ValueError("transport is required. Use with_transport() to set it.")

        return ResponsesAPIEmitter(
            task_id=self._task_id,
            subtask_id=self._subtask_id,
            transport=self._transport,
            model=self._model,
            message_id=self._message_id,
            executor_name=self._executor_name,
            executor_namespace=self._executor_namespace,
        )

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""WebSocket Bridge for Chat Streaming.

This module provides the WebSocketBridge that subscribes to Redis Pub/Sub channels
and forwards streaming events to WebSocket clients. This enables a unified
streaming architecture where:

1. chat_shell (Package or HTTP mode) publishes events to Redis channel
2. WebSocketBridge subscribes and forwards to WebSocket rooms
3. Single source of truth for streaming logic (in chat_shell)

Usage:
    bridge = WebSocketBridge(namespace, task_room, task_id)
    await bridge.start(subtask_id)
    # ... streaming happens in chat_shell ...
    await bridge.stop()
"""

import asyncio
import json
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


class WebSocketBridge:
    """Bridge between Redis Pub/Sub and WebSocket.

    Subscribes to a Redis channel for a specific subtask and forwards
    all events to the WebSocket room. This allows chat_shell to be the
    single source of truth for streaming logic while Backend handles
    only WebSocket delivery.

    Events are forwarded as:
    - type: "start" -> emit "chat:start"
    - type: "chunk" -> emit "chat:chunk"
    - type: "done" -> emit "chat:done"
    - type: "error" -> emit "chat:error"
    - type: "cancelled" -> emit "chat:cancelled"
    """

    def __init__(
        self,
        namespace: Any,
        task_room: str,
        task_id: int,
    ):
        """Initialize WebSocket bridge.

        Args:
            namespace: Socket.IO namespace for emitting events
            task_room: WebSocket room to emit events to
            task_id: Task ID for logging
        """
        self.namespace = namespace
        self.task_room = task_room
        self.task_id = task_id
        self._redis_client: Optional[Any] = None
        self._pubsub: Optional[Any] = None
        self._subscription_task: Optional[asyncio.Task] = None
        self._stop_event: asyncio.Event = asyncio.Event()
        self._subtask_id: Optional[int] = None

    async def start(self, subtask_id: int) -> bool:
        """Start subscribing to the Redis channel for a subtask.

        Args:
            subtask_id: Subtask ID to subscribe to

        Returns:
            True if subscription started successfully
        """
        from app.services.chat.storage import session_manager

        self._subtask_id = subtask_id
        self._stop_event.clear()

        # Subscribe to the streaming channel
        self._redis_client, self._pubsub = (
            await session_manager.subscribe_streaming_channel(subtask_id)
        )

        if not self._pubsub:
            logger.error(
                "[WS_BRIDGE] Failed to subscribe to channel: task_id=%d, subtask_id=%d",
                self.task_id,
                subtask_id,
            )
            return False

        # Start the forwarding task
        self._subscription_task = asyncio.create_task(
            self._forward_messages(subtask_id)
        )

        logger.info(
            "[WS_BRIDGE] Started bridge: task_id=%d, subtask_id=%d, room=%s",
            self.task_id,
            subtask_id,
            self.task_room,
        )
        return True

    async def stop(self) -> None:
        """Stop the subscription and cleanup resources."""
        self._stop_event.set()

        if self._subscription_task:
            try:
                self._subscription_task.cancel()
                await asyncio.wait_for(self._subscription_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            self._subscription_task = None

        if self._pubsub:
            try:
                await self._pubsub.unsubscribe()
                await self._pubsub.close()
            except Exception as e:
                logger.warning("[WS_BRIDGE] Error closing pubsub: %s", e)
            self._pubsub = None

        if self._redis_client:
            try:
                await self._redis_client.aclose()
            except Exception as e:
                logger.warning("[WS_BRIDGE] Error closing redis client: %s", e)
            self._redis_client = None

        logger.info(
            "[WS_BRIDGE] Stopped bridge: task_id=%d, subtask_id=%s",
            self.task_id,
            self._subtask_id,
        )

    async def _forward_messages(self, subtask_id: int) -> None:
        """Forward messages from Redis to WebSocket.

        Args:
            subtask_id: Subtask ID being streamed
        """
        try:
            async for message in self._pubsub.listen():
                if self._stop_event.is_set():
                    break

                if message["type"] != "message":
                    continue

                # Parse the message data
                try:
                    data = message["data"]
                    if isinstance(data, bytes):
                        data = data.decode("utf-8")

                    # Handle legacy STREAM_DONE format from publish_streaming_done
                    try:
                        parsed = json.loads(data)
                        if parsed.get("__type__") == "STREAM_DONE":
                            # Convert to new format
                            event = {
                                "type": "done",
                                "task_id": self.task_id,
                                "subtask_id": subtask_id,
                                "result": parsed.get("result", {}),
                            }
                        else:
                            event = parsed
                    except json.JSONDecodeError:
                        # Old format: just a chunk string
                        event = {
                            "type": "chunk",
                            "chunk": data,
                            "subtask_id": subtask_id,
                        }

                except Exception as e:
                    logger.warning("[WS_BRIDGE] Failed to parse message: %s", e)
                    continue

                # Forward to WebSocket based on event type
                event_type = event.pop("type", "chunk")
                await self._emit_event(event_type, event)

                # Stop after done/cancelled/error
                if event_type in ("done", "cancelled", "error"):
                    logger.info(
                        "[WS_BRIDGE] Received terminal event '%s', stopping bridge",
                        event_type,
                    )
                    break

        except asyncio.CancelledError:
            logger.info("[WS_BRIDGE] Subscription task cancelled")
        except Exception as e:
            logger.exception("[WS_BRIDGE] Error in message forwarding: %s", e)

    async def _emit_event(self, event_type: str, data: dict) -> None:
        """Emit an event to the WebSocket room.

        Args:
            event_type: Type of event (start, chunk, done, error, cancelled)
            data: Event data to emit
        """
        event_name = f"chat:{event_type}"

        try:
            await self.namespace.emit(
                event_name,
                data,
                room=self.task_room,
            )
            logger.debug(
                "[WS_BRIDGE] Emitted %s: task_id=%d, subtask_id=%s",
                event_name,
                self.task_id,
                data.get("subtask_id"),
            )
        except Exception as e:
            logger.error(
                "[WS_BRIDGE] Failed to emit %s: %s",
                event_name,
                e,
            )

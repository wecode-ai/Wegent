# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Throttled Transport decorator for event emission.

This module provides:
- ThrottleConfig: Configuration for throttling behavior
- ThrottledTransport: Decorator pattern wrapper for any EventTransport

Design:
- Uses Decorator pattern to wrap any EventTransport
- Aggregates high-frequency events (like text_delta) within time windows
- Lifecycle events (start, done, error) and tool events bypass throttling

Benefits:
- Reduces QPS for HTTP callbacks significantly
- Aggregates multiple tokens into single requests
- Configurable per-event-type intervals
- Buffer size limit for immediate flush

Usage:
    # Wrap any transport with throttling
    base_transport = CallbackTransport(client)
    throttled = ThrottledTransport(base_transport)

    # Custom configuration
    config = ThrottleConfig(
        default_interval=0.5,
        event_intervals={"response.output_text.delta": 0.2},
    )
    throttled = ThrottledTransport(base_transport, config)
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from .responses_api_emitter import EventTransport

logger = logging.getLogger(__name__)

__all__ = [
    "ThrottleConfig",
    "ThrottledTransport",
]


@dataclass
class ThrottleConfig:
    """Configuration for throttling behavior."""

    # Default aggregation interval (seconds)
    default_interval: float = 2

    # Custom intervals per event type
    event_intervals: Dict[str, float] = field(default_factory=dict)

    # Maximum buffer size (characters), flush immediately when exceeded
    max_buffer_size: int = 4096

    # Event types to throttle (None means throttle all non-bypass events)
    throttled_events: Optional[Set[str]] = None

    # Event types that bypass throttling (higher priority than throttled_events)
    bypass_events: Optional[Set[str]] = None

    def __post_init__(self):
        """Initialize default bypass events."""
        if self.bypass_events is None:
            # Default: don't throttle lifecycle events and tool events
            self.bypass_events = {
                "response.created",
                "response.completed",
                "response.incomplete",
                "error",
                "response.output_item.added",
                "response.output_item.done",
                "response.function_call_arguments.done",
            }

    def get_interval(self, event_type: str) -> float:
        """Get throttle interval for event type.

        Args:
            event_type: Event type string

        Returns:
            Throttle interval in seconds
        """
        return self.event_intervals.get(event_type, self.default_interval)

    def should_throttle(self, event_type: str) -> bool:
        """Check if event type should be throttled.

        Args:
            event_type: Event type string

        Returns:
            True if event should be throttled
        """
        # bypass_events has priority
        if self.bypass_events and event_type in self.bypass_events:
            return False
        # If throttled_events is specified, only throttle those
        if self.throttled_events is not None:
            return event_type in self.throttled_events
        # Default: throttle all non-bypass events
        return True


class ThrottledTransport(EventTransport):
    """Throttled Transport decorator.

    Uses Decorator pattern to wrap any EventTransport, providing throttling
    for high-frequency events.

    Throttling strategy:
    - Accumulates same-type events within time window
    - Sends aggregated content when window ends
    - Flushes immediately if buffer exceeds threshold
    - Lifecycle events (start, done, error) and tool events bypass throttling

    Usage:
        # Wrap CallbackTransport
        base_transport = CallbackTransport(client)
        throttled = ThrottledTransport(base_transport)

        # Custom configuration
        config = ThrottleConfig(
            default_interval=0.5,
            event_intervals={"response.output_text.delta": 0.2},
        )
        throttled = ThrottledTransport(base_transport, config)
    """

    def __init__(
        self,
        transport: EventTransport,
        config: Optional[ThrottleConfig] = None,
    ):
        """Initialize throttled transport.

        Args:
            transport: Wrapped transport
            config: Throttle configuration
        """
        self._transport = transport
        self._config = config or ThrottleConfig()

        # Buffer: grouped by (task_id, subtask_id, event_type)
        self._buffers: Dict[tuple, List[dict]] = {}
        self._last_send_times: Dict[tuple, float] = {}
        self._lock = asyncio.Lock()

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> Any:
        """Send event with throttling for high-frequency events.

        Args:
            event_type: Event type string
            task_id: Task ID
            subtask_id: Subtask ID
            data: Event data
            message_id: Optional message ID
            executor_name: Optional executor name
            executor_namespace: Optional executor namespace

        Returns:
            Transport-specific result
        """
        # Build event
        event = {
            "event_type": event_type,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "data": data,
            "message_id": message_id,
            "executor_name": executor_name,
            "executor_namespace": executor_namespace,
        }

        # Check if throttling is needed
        if not self._config.should_throttle(event_type):
            # No throttling, send directly
            return await self._transport.send(
                event_type,
                task_id,
                subtask_id,
                data,
                message_id,
                executor_name,
                executor_namespace,
            )

        # Throttle this event
        return await self._throttled_send(event)

    async def _throttled_send(self, event: dict) -> Any:
        """Send event with throttling.

        Args:
            event: Event dictionary

        Returns:
            Transport-specific result or buffered status
        """
        key = (event["task_id"], event["subtask_id"], event["event_type"])

        async with self._lock:
            interval = self._config.get_interval(event["event_type"])

            # Initialize buffer
            if key not in self._buffers:
                self._buffers[key] = []
                self._last_send_times[key] = 0
                logger.info(
                    f"[ThrottledTransport] Initialized buffer for key={key}, "
                    f"interval={interval}s"
                )

            # Add to buffer
            self._buffers[key].append(event)
            buffer_count = len(self._buffers[key])

            # Calculate buffer size
            buffer_size = self._calculate_buffer_size(self._buffers[key])

            current_time = time.time()
            time_since_last = current_time - self._last_send_times[key]

            logger.info(
                f"[ThrottledTransport] Event added to buffer: key={key}, "
                f"buffer_count={buffer_count}, buffer_size={buffer_size}, "
                f"time_since_last={time_since_last:.3f}s, interval={interval}s"
            )

            # Check if immediate send is needed
            should_send_now = (
                buffer_size >= self._config.max_buffer_size
                or time_since_last >= interval
            )

            if should_send_now:
                logger.info(
                    f"[ThrottledTransport] Flushing buffer: key={key}, "
                    f"reason={'buffer_size_exceeded' if buffer_size >= self._config.max_buffer_size else 'interval_exceeded'}, "
                    f"buffer_count={buffer_count}"
                )
                result = await self._flush_buffer(key)
                # Also flush any other expired buffers while we have the lock
                # This ensures streaming works even when asyncio tasks can't run
                await self._flush_expired_buffers(current_time)
                return result
            else:
                # Check and flush any other expired buffers
                # This is the key fix: instead of relying on _delayed_flush tasks
                # (which may not run if the event loop is blocked by async for),
                # we proactively flush expired buffers on each send call
                await self._flush_expired_buffers(current_time)
                return {"status": "buffered"}

    async def _flush_expired_buffers(self, current_time: float) -> None:
        """Flush all buffers that have exceeded their interval.

        This method is called on each send to ensure buffers are flushed
        even when asyncio tasks cannot run (e.g., when blocked by async for).

        Args:
            current_time: Current timestamp
        """
        # Note: This method is called while holding the lock
        for buffer_key in list(self._buffers.keys()):
            if not self._buffers[buffer_key]:
                continue

            # Get interval for this event type
            event_type = buffer_key[2]  # key is (task_id, subtask_id, event_type)
            interval = self._config.get_interval(event_type)

            # Check if this buffer has expired
            time_since_last = current_time - self._last_send_times.get(buffer_key, 0)
            if time_since_last >= interval:
                await self._flush_buffer(buffer_key)

    def _calculate_buffer_size(self, events: List[dict]) -> int:
        """Calculate buffer content size.

        Args:
            events: List of event dictionaries

        Returns:
            Total content size in characters
        """
        total = 0
        for e in events:
            data = e.get("data", {})
            # Try various content fields
            total += len(str(data.get("delta", "")))
            total += len(str(data.get("text", "")))
            if "part" in data:
                total += len(str(data["part"].get("content", "")))
        return total

    async def _flush_buffer(self, key: tuple) -> Any:
        """Flush buffer and send aggregated event.

        Args:
            key: Buffer key tuple

        Returns:
            Transport-specific result
        """
        if key not in self._buffers or not self._buffers[key]:
            logger.info(
                f"[ThrottledTransport] _flush_buffer: buffer empty for key={key}"
            )
            return {"status": "empty"}

        events = self._buffers[key]
        event_count = len(events)
        self._buffers[key] = []
        self._last_send_times[key] = time.time()

        logger.info(
            f"[ThrottledTransport] _flush_buffer: flushing {event_count} events for key={key}"
        )

        # Aggregate events
        aggregated = self._aggregate_events(events)

        logger.info(
            f"[ThrottledTransport] _flush_buffer: aggregated data keys={list(aggregated.get('data', {}).keys())}, "
            f"delta_len={len(aggregated.get('data', {}).get('delta', ''))}, "
            f"text_len={len(aggregated.get('data', {}).get('text', ''))}"
        )

        # Send via underlying transport
        return await self._transport.send(
            aggregated["event_type"],
            aggregated["task_id"],
            aggregated["subtask_id"],
            aggregated["data"],
            aggregated.get("message_id"),
            aggregated.get("executor_name"),
            aggregated.get("executor_namespace"),
        )

    def _aggregate_events(self, events: List[dict]) -> dict:
        """Aggregate multiple events into one.

        Args:
            events: List of event dictionaries

        Returns:
            Aggregated event dictionary
        """
        event_count = len(events)
        logger.info(
            f"[ThrottledTransport] _aggregate_events: aggregating {event_count} events"
        )

        if len(events) == 1:
            logger.info(
                f"[ThrottledTransport] _aggregate_events: single event, returning as-is, "
                f"data_keys={list(events[0].get('data', {}).keys())}"
            )
            return events[0]

        base = events[0].copy()
        base["data"] = base.get("data", {}).copy()

        # Aggregate delta field
        if "delta" in base["data"]:
            deltas = [e.get("data", {}).get("delta", "") for e in events]
            aggregated_delta = "".join(deltas)
            logger.info(
                f"[ThrottledTransport] _aggregate_events: aggregating delta field, "
                f"individual_lengths={[len(d) for d in deltas]}, "
                f"total_length={len(aggregated_delta)}"
            )
            base["data"]["delta"] = aggregated_delta

        # Aggregate text field
        if "text" in base["data"]:
            texts = [e.get("data", {}).get("text", "") for e in events]
            aggregated_text = "".join(texts)
            logger.info(
                f"[ThrottledTransport] _aggregate_events: aggregating text field, "
                f"individual_lengths={[len(t) for t in texts]}, "
                f"total_length={len(aggregated_text)}"
            )
            base["data"]["text"] = aggregated_text

        # Aggregate part.content field (reasoning)
        if "part" in base["data"] and "content" in base["data"]["part"]:
            base["data"]["part"] = base["data"]["part"].copy()
            contents = [
                e.get("data", {}).get("part", {}).get("content", "") for e in events
            ]
            aggregated_content = "".join(contents)
            logger.info(
                f"[ThrottledTransport] _aggregate_events: aggregating part.content field, "
                f"individual_lengths={[len(c) for c in contents]}, "
                f"total_length={len(aggregated_content)}"
            )
            base["data"]["part"]["content"] = aggregated_content

        return base

    async def flush_all(self) -> None:
        """Flush all buffers (call at task end)."""
        async with self._lock:
            for key in list(self._buffers.keys()):
                if self._buffers[key]:
                    await self._flush_buffer(key)

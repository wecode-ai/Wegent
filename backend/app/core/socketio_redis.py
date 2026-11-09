# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Observe the Redis callback path used by this Socket.IO worker."""

import asyncio
import logging
from typing import Any

from socketio import AsyncRedisManager

from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

ACK_PROBE_TIMEOUT_SECONDS = 5
ACK_PROBE_FAILURE_THRESHOLD = 3


def _log_ack(stage: str, message: dict[str, Any], outcome: str) -> None:
    logger.debug(
        "Socket.IO Redis ACK stage=%s host_id=%s sid=%s callback_id=%s outcome=%s",
        stage,
        message.get("host_id"),
        message.get("sid"),
        message.get("id"),
        outcome,
    )


class ObservedRedisManager(AsyncRedisManager):
    """Trace cross-worker ACKs and exercise their real subscriber and waiter."""

    def __init__(self, url: str, *, redis_options: dict[str, Any]) -> None:
        super().__init__(url, redis_options=redis_options)
        self._probe_sid = f"wegent-ack-probe:{self.host_id}"
        self._probe_failures = 0

    @property
    def ack_ready(self) -> bool:
        return self._probe_failures < ACK_PROBE_FAILURE_THRESHOLD

    async def _publish(self, data: dict[str, Any]) -> int | None:
        subscribers = await super()._publish(data)
        if data.get("method") == "callback":
            outcome = "published"
            if subscribers is None:
                outcome = "failed"
            elif subscribers == 0:
                outcome = "no_subscribers"
            _log_ack("publish", data, outcome)
        return subscribers

    async def _handle_callback(self, message: dict[str, Any]) -> None:
        if message.get("host_id") != self.host_id:
            return
        if not logger.isEnabledFor(logging.DEBUG):
            await super()._handle_callback(message)
            return
        _log_ack("receive", message, "received")
        sid, callback_id = message.get("sid"), message.get("id")
        matched = (
            isinstance(sid, str)
            and type(callback_id) is int
            and callback_id > 0
            and callback_id in self.callbacks.get(sid, {})
            and "args" in message
        )
        await super()._handle_callback(message)
        _log_ack("match", message, "matched" if matched else "missing")

    async def _probe_ack_round_trip(self) -> None:
        acknowledged = asyncio.Event()
        callback_id = self._generate_ack_id(self._probe_sid, acknowledged.set)
        try:
            await self._publish(
                {
                    "method": "callback",
                    "host_id": self.host_id,
                    "sid": self._probe_sid,
                    "namespace": "/",
                    "id": callback_id,
                    "args": [],
                }
            )
            await acknowledged.wait()
        finally:
            # Keep the ACK counter so a late probe cannot match a later probe.
            self.callbacks[self._probe_sid].pop(callback_id, None)

    @trace_async(span_name="socketio.ack_probe", tracer_name=__name__)
    async def check_ack(self) -> None:
        """Update readiness from one bounded round trip."""
        was_ready = self.ack_ready
        try:
            await asyncio.wait_for(
                self._probe_ack_round_trip(), timeout=ACK_PROBE_TIMEOUT_SECONDS
            )
        except Exception as error:
            self._probe_failures += 1
            if was_ready and not self.ack_ready:
                logger.warning(
                    "Socket.IO Redis ACK probe unhealthy host_id=%s failures=%d error_type=%s",
                    self.host_id,
                    self._probe_failures,
                    type(error).__name__,
                )
            else:
                logger.debug(
                    "Socket.IO Redis ACK probe failed host_id=%s failures=%d error_type=%s",
                    self.host_id,
                    self._probe_failures,
                    type(error).__name__,
                )
        else:
            self._probe_failures = 0
            if not was_ready:
                logger.info(
                    "Socket.IO Redis ACK probe recovered host_id=%s", self.host_id
                )

    async def run_ack_probe(self, interval_seconds: float) -> None:
        """Check independently of HTTP traffic and local Socket.IO connections."""
        while True:
            await self.check_ack()
            await asyncio.sleep(interval_seconds)

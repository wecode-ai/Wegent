# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Exercise ACK completion and cancellation using the real manager callbacks."""

import asyncio
import unittest
from typing import Any
from unittest.mock import patch

from app.core import socketio_redis


class SocketIOProbeShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_ack_does_not_swallow_probe_cancellation(self) -> None:
        manager = socketio_redis.ObservedRedisManager(
            "redis://localhost", redis_options={}
        )
        published = asyncio.get_running_loop().create_future()

        async def publish(message: dict[str, Any]) -> int:
            published.set_result(message)
            return 1

        with patch.object(manager, "_publish", publish):
            probe = asyncio.create_task(manager.run_ack_probe(interval_seconds=60))
            try:
                message = await published
                await manager._handle_callback(message)
                asyncio.get_running_loop().call_soon(probe.cancel)
                done, _ = await asyncio.wait({probe}, timeout=1)
                self.assertEqual(
                    done, {probe}, "ACK completion lost shutdown cancellation"
                )
                self.assertTrue(probe.cancelled())
                self.assertEqual(set(manager.callbacks[manager._probe_sid]), {0})
            finally:
                probe.cancel()
                await asyncio.gather(probe, return_exceptions=True)

    async def test_probe_timeout_keeps_failure_count_and_cleans_callback(self) -> None:
        manager = socketio_redis.ObservedRedisManager(
            "redis://localhost", redis_options={}
        )

        async def publish(message: dict[str, Any]) -> int:
            return 1

        with (
            patch.object(manager, "_publish", publish),
            patch.object(socketio_redis, "ACK_PROBE_TIMEOUT_SECONDS", 0.01),
        ):
            for _ in range(socketio_redis.ACK_PROBE_FAILURE_THRESHOLD):
                await manager.check_ack()
        self.assertFalse(manager.ack_ready)
        self.assertEqual(set(manager.callbacks[manager._probe_sid]), {0})

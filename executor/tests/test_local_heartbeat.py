# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from unittest.mock import AsyncMock

import pytest

from executor.modes.local.heartbeat import LocalHeartbeatService


class DisconnectedClient:
    def __init__(self):
        self._connected = False
        self.connect_called = asyncio.Event()
        self.send_heartbeat = AsyncMock()

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> bool:
        self.connect_called.set()
        self._connected = True
        return True


class ConnectedHeartbeatFailingClient:
    def __init__(self):
        self._connected = True
        self.reconnect_called = asyncio.Event()
        self.send_heartbeat = AsyncMock(return_value=False)

    @property
    def connected(self) -> bool:
        return self._connected

    async def reconnect(self) -> bool:
        self.reconnect_called.set()
        return True


@pytest.mark.asyncio
async def test_heartbeat_reconnects_when_client_is_disconnected():
    client = DisconnectedClient()
    service = LocalHeartbeatService(client, interval=0.01)

    await service.start()
    try:
        await asyncio.wait_for(client.connect_called.wait(), timeout=0.2)
    finally:
        await service.stop()

    assert client.connected is True


@pytest.mark.asyncio
async def test_heartbeat_forces_reconnect_after_repeated_ack_failures():
    client = ConnectedHeartbeatFailingClient()
    service = LocalHeartbeatService(client, interval=0.01)

    await service.start()
    try:
        await asyncio.wait_for(client.reconnect_called.wait(), timeout=0.2)
    finally:
        await service.stop()

    assert client.send_heartbeat.await_count == 3

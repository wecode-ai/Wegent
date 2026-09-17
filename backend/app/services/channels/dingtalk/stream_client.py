# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""A single Stream session; the channel provider owns retry and cancellation."""

import asyncio
import json
from urllib.parse import quote_plus

from dingtalk_stream import DingTalkStreamClient
from websockets.asyncio.client import connect

from shared.telemetry.decorators import trace_async


class DingTalkStreamConnection(DingTalkStreamClient):
    @trace_async(tracer_name=__name__)
    async def connect_once(self) -> None:
        """Route SDK messages without its infinite retry or swallowed cancellation."""
        self.pre_start()
        connection = await asyncio.to_thread(self.open_connection)
        if not connection:
            raise ConnectionError("DingTalk did not return a Stream endpoint")

        uri = f'{connection["endpoint"]}?ticket={quote_plus(connection["ticket"])}'
        pending: set[asyncio.Task[None]] = set()
        async with connect(uri) as websocket:
            self.websocket = websocket
            try:
                async for raw_message in websocket:
                    task = asyncio.create_task(
                        self.background_task(json.loads(raw_message))
                    )
                    pending.add(task)
                    task.add_done_callback(pending.discard)
                # Finish received callbacks on a clean close before releasing the session.
                await asyncio.gather(*pending)
            finally:
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                self.websocket = None

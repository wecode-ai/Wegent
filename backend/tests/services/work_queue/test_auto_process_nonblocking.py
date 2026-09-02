# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Non-blocking boundaries for inbox auto-processing events."""

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.services.inbox.auto_process_handler import InboxAutoProcessHandler


async def _wait_for_thread(started: threading.Event) -> None:
    while not started.is_set():
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_auto_process_database_routing_does_not_block_event_loop():
    handler = InboxAutoProcessHandler()
    event = SimpleNamespace(
        message_id=11,
        queue_id=3,
        recipient_user_id=7,
        sender_user_id=8,
    )
    started = threading.Event()
    release = threading.Event()

    def blocking_load(*_args):
        started.set()
        release.wait()
        return None

    safety_release = threading.Timer(2, release.set)
    safety_release.start()
    try:
        with patch.object(
            handler,
            "_load_auto_process_config_sync",
            side_effect=blocking_load,
        ):
            handling = asyncio.create_task(handler.on_message_created(event))
            await asyncio.wait_for(_wait_for_thread(started), timeout=0.5)
            assert not handling.done()
            release.set()
            await handling
    finally:
        release.set()
        safety_release.cancel()

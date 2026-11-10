# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Worker cancellation must signal the captured local stream, not its replacement."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.chat.storage.session import SessionManager


@pytest.mark.asyncio
async def test_sync_cancel_uses_existing_flag_and_captured_local_event():
    manager = SessionManager()
    cache = SimpleNamespace(
        delete=AsyncMock(), set_from_sync=MagicMock(return_value=True)
    )
    manager._cache = cache
    old_event = await manager.register_stream(100)
    loop = MagicMock()

    assert manager.cancel_stream_from_sync(100, loop)
    new_event = await manager.register_stream(100)
    loop.call_soon_threadsafe.call_args.args[0]()

    cache.set_from_sync.assert_called_once_with("chat:cancel:100", True, expire=300)
    assert old_event.is_set()
    assert not new_event.is_set()

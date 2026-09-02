# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.chat.storage.session import SessionManager


@pytest.mark.asyncio
async def test_attach_stream_preserves_cancel_before_worker_registration() -> None:
    manager = SessionManager()
    cache = AsyncMock()
    cache.set.return_value = True
    cache.get.return_value = True
    manager._cache = cache

    assert await manager.cancel_stream(101) is True
    cancel_event = await manager.attach_stream(101)

    assert await manager.is_cancelled(101) is True
    assert cancel_event.is_set()
    cache.delete.assert_not_awaited()

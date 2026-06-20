# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, Mock

import pytest

from app.api.ws.connection_utils import enter_connect_room, save_connect_session


@pytest.mark.asyncio
async def test_save_connect_session_rejects_stale_connection_at_info_level():
    namespace = Mock()
    namespace.save_session = AsyncMock(side_effect=KeyError("Session not found"))
    logger = Mock()

    with pytest.raises(ConnectionRefusedError, match="disconnected"):
        await save_connect_session(
            namespace,
            "sid-1",
            {"user_id": 7},
            logger=logger,
            log_prefix="[WS]",
        )

    logger.info.assert_called_once()
    logger.warning.assert_not_called()


@pytest.mark.asyncio
async def test_enter_connect_room_rejects_stale_connection_at_info_level():
    namespace = Mock()
    namespace.enter_room = AsyncMock(side_effect=KeyError("sid-1"))
    logger = Mock()

    with pytest.raises(ConnectionRefusedError, match="disconnected"):
        await enter_connect_room(
            namespace,
            "sid-1",
            "user:7",
            logger=logger,
            log_prefix="[WS]",
        )

    logger.info.assert_called_once()
    logger.warning.assert_not_called()

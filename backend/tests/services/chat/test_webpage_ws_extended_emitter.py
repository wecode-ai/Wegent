# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.unit
class TestExtendedEventEmitter:
    @pytest.mark.asyncio
    async def test_emit_chat_error_proxies_to_websocket_emitter(self):
        """Disconnect paths should be able to emit chat:error via the extended emitter."""
        from app.services.chat.webpage_ws_extended_emitter import ExtendedEventEmitter

        emitter = ExtendedEventEmitter()
        mock_ws = AsyncMock()

        with patch.object(emitter, "_get_ws_emitter", return_value=mock_ws):
            await emitter.emit_chat_error(
                task_id=1267,
                subtask_id=1703,
                error="Device disconnected",
                message_id=42,
            )

        mock_ws.emit_chat_error.assert_awaited_once_with(
            task_id=1267,
            subtask_id=1703,
            error="Device disconnected",
            error_type=None,
            message_id=42,
        )

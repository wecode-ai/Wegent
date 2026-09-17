# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for channel terminal result delivery."""

from typing import Any, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.channels.callback import (
    BaseCallbackInfo,
    BaseChannelCallbackService,
    ChannelCallbackRegistry,
    ChannelType,
)
from app.services.execution.emitters import ResultEmitter


class FakeCallbackService(BaseChannelCallbackService[BaseCallbackInfo]):
    def __init__(self, emitter: ResultEmitter):
        super().__init__(ChannelType.DINGTALK)
        self.emitter = emitter

    async def _create_emitter(
        self,
        task_id: int,
        subtask_id: int,
        callback_info: BaseCallbackInfo,
    ) -> Optional[ResultEmitter]:
        return self.emitter

    def _parse_callback_info(self, data: dict[str, Any]) -> BaseCallbackInfo:
        return BaseCallbackInfo.from_dict(data)

    def _extract_thinking_display(self, thinking: Any) -> str:
        return ""


@pytest.mark.asyncio
async def test_registry_preserves_terminal_result_metadata(monkeypatch):
    service = MagicMock()
    service.get_callback_info = AsyncMock(return_value=object())
    service.send_task_result = AsyncMock(return_value=True)
    registry = ChannelCallbackRegistry()
    monkeypatch.setattr(registry, "_services", {ChannelType.DINGTALK: service})
    result = {
        "value": "I will inspect.",
        "value_origin": "process_fallback",
    }

    sent = await registry.handle_task_completed(
        task_id=1,
        subtask_id=2,
        status="COMPLETED",
        result=result,
    )

    assert sent is True
    service.send_task_result.assert_awaited_once_with(
        task_id=1,
        subtask_id=2,
        content="I will inspect.",
        status="COMPLETED",
        error_message=None,
        result=result,
    )


@pytest.mark.asyncio
async def test_reconstructed_emitter_receives_result_without_process_chunk():
    emitter = AsyncMock(spec=ResultEmitter)
    service = FakeCallbackService(emitter)
    service.get_callback_info = AsyncMock(
        return_value=BaseCallbackInfo(
            channel_type=ChannelType.DINGTALK,
            channel_id=1,
            conversation_id="conversation-1",
        )
    )
    service._get_or_create_emitter = AsyncMock(return_value=emitter)
    service._remove_emitter = AsyncMock()
    service.delete_callback_info = AsyncMock()
    result = {
        "value": "I will inspect.",
        "value_origin": "process_fallback",
    }

    sent = await service.send_task_result(
        task_id=1,
        subtask_id=2,
        content="I will inspect.",
        result=result,
    )

    assert sent is True
    emitter.emit_chunk.assert_not_awaited()
    emitter.emit_done.assert_awaited_once_with(
        task_id=1,
        subtask_id=2,
        result=result,
    )

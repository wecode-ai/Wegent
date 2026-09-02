# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest

from app.services.execution.agents.video.intent_analyzer import (
    VideoIntentAnalyzer,
    VideoIntentResult,
    _load_video_intent_history,
    _VideoIntentHistory,
)


@pytest.mark.asyncio
async def test_video_intent_history_is_loaded_before_async_llm() -> None:
    analyzer = VideoIntentAnalyzer()
    expected = VideoIntentResult(
        merged_prompt="merged",
        should_use_image=True,
        image_mode="reference",
    )
    analyzer._call_llm = AsyncMock(return_value=expected)
    run_sync = AsyncMock(
        return_value=_VideoIntentHistory(
            prev_prompt="previous",
            prev_image="https://images.example/reference.png",
        )
    )

    with patch(
        "app.services.execution.agents.video.intent_analyzer.run_sync_in_executor",
        run_sync,
    ):
        result = await analyzer.analyze(
            task_id=1,
            current_prompt="current",
            secondary_model_config={"model": "intent"},
            exclude_subtask_ids=[2, 3],
        )

    run_sync.assert_awaited_once_with(
        _load_video_intent_history,
        1,
        [2, 3],
    )
    analyzer._call_llm.assert_awaited_once_with(
        "previous",
        "current",
        True,
        {"model": "intent"},
    )
    assert result.reference_image == "https://images.example/reference.png"

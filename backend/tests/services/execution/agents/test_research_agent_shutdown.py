# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.shutdown import StreamAdmissionClosedError
from shared.models import ExecutionRequest


@pytest.mark.asyncio
async def test_shutdown_rejection_does_not_start_research() -> None:
    from app.services.execution.agents.research_agent import ResearchAgent

    request = ExecutionRequest(
        task_id=1,
        subtask_id=2,
        message_id=3,
        prompt="Research this",
        model_config={"protocol": "gemini-deep-research"},
    )
    emitter = AsyncMock()
    session_manager = MagicMock()
    session_manager.register_stream = AsyncMock()
    session_manager.unregister_stream = AsyncMock()
    shutdown_manager = MagicMock()
    shutdown_manager.register_stream = AsyncMock(
        side_effect=StreamAdmissionClosedError(request.subtask_id)
    )
    shutdown_manager.unregister_stream = AsyncMock()

    with (
        patch(
            "app.services.chat.storage.session.session_manager",
            session_manager,
        ),
        patch(
            "app.services.execution.agents.research_agent.shutdown_manager",
            shutdown_manager,
        ),
        patch(
            "app.services.execution.agents.research_agent." "GeminiInteractionClient"
        ) as client,
        pytest.raises(StreamAdmissionClosedError) as raised,
    ):
        await ResearchAgent().execute(request, emitter)

    assert raised.value.error_code == "server_shutting_down"
    session_manager.register_stream.assert_not_awaited()
    session_manager.unregister_stream.assert_not_awaited()
    shutdown_manager.unregister_stream.assert_not_awaited()
    emitter.emit_start.assert_not_awaited()
    emitter.emit.assert_not_awaited()
    client.assert_not_called()

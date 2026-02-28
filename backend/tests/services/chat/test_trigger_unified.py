# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from shared.models import ExecutionRequest


@pytest.mark.unit
class TestBuildExecutionRequestUserSubtaskId:
    @pytest.mark.asyncio
    async def test_propagates_user_subtask_id_to_execution_request(self):
        """Ensure user_subtask_id is always propagated for downstream RAG persistence."""
        from app.services.chat.trigger import unified as trigger_unified

        mock_db = MagicMock()

        request_from_builder = ExecutionRequest(task_id=1, subtask_id=2)
        mock_builder = MagicMock()
        mock_builder.build.return_value = request_from_builder

        async def _process_contexts_passthrough(db, request, user_subtask_id, user_id):
            return request

        with patch.object(trigger_unified, "SessionLocal", return_value=mock_db):
            with patch(
                "app.services.execution.TaskRequestBuilder", return_value=mock_builder
            ):
                with patch.object(
                    trigger_unified,
                    "_process_contexts",
                    new=AsyncMock(side_effect=_process_contexts_passthrough),
                ) as mock_process_contexts:
                    task = MagicMock()
                    task.id = 1
                    task.json = {}

                    assistant_subtask = MagicMock()
                    assistant_subtask.id = 2

                    team = MagicMock()
                    user = MagicMock()
                    user.id = 7

                    result = await trigger_unified.build_execution_request(
                        task=task,
                        assistant_subtask=assistant_subtask,
                        team=team,
                        user=user,
                        message="hello",
                        payload=None,
                        user_subtask_id=123,
                    )

                    assert result.user_subtask_id == 123
                    mock_builder.build.assert_called_once()
                    mock_process_contexts.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_does_not_process_contexts_when_user_subtask_id_is_none(self):
        """When user_subtask_id is missing, contexts processing should be skipped."""
        from app.services.chat.trigger import unified as trigger_unified

        mock_db = MagicMock()

        request_from_builder = ExecutionRequest(task_id=1, subtask_id=2)
        mock_builder = MagicMock()
        mock_builder.build.return_value = request_from_builder

        with patch.object(trigger_unified, "SessionLocal", return_value=mock_db):
            with patch(
                "app.services.execution.TaskRequestBuilder", return_value=mock_builder
            ):
                with patch.object(
                    trigger_unified, "_process_contexts", new=AsyncMock()
                ) as mock_process_contexts:
                    task = MagicMock()
                    task.id = 1
                    task.json = {}

                    assistant_subtask = MagicMock()
                    assistant_subtask.id = 2

                    team = MagicMock()
                    user = MagicMock()
                    user.id = 7

                    result = await trigger_unified.build_execution_request(
                        task=task,
                        assistant_subtask=assistant_subtask,
                        team=team,
                        user=user,
                        message="hello",
                        payload=None,
                        user_subtask_id=None,
                    )

                    assert result.user_subtask_id is None
                    mock_builder.build.assert_called_once()
                    mock_process_contexts.assert_not_awaited()

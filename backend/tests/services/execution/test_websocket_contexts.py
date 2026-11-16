# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Completion events must expose the same context briefs as history sync."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.models.subtask_context import SubtaskContext
from app.schemas.subtask_context import SubtaskContextBrief
from app.services.chat.webpage_ws_chat_emitter import WebPageSocketEmitter
from app.services.execution.emitters import WebSocketResultEmitter


@pytest.mark.asyncio
@pytest.mark.parametrize("has_artifact", [False, True])
async def test_done_broadcasts_persisted_context_briefs(has_artifact: bool) -> None:
    context = SubtaskContext(
        id=9,
        subtask_id=2,
        user_id=7,
        context_type="remote_workspace_artifact",
        name="report.txt",
        status="ready",
        binary_data=b"",
        type_data={
            "task_id": 1,
            "relative_path": "outputs/report.txt",
            "file_size": 32,
            "mime_type": "text/plain",
            "sha256": "a" * 64,
            "source": {"workspace_root": "/private/workspace"},
        },
    )
    briefs = [SubtaskContextBrief.from_model(context)] if has_artifact else []
    sio = AsyncMock()
    ws_emitter = WebPageSocketEmitter(sio)
    emitter = WebSocketResultEmitter(task_id=1, subtask_id=2)
    db = MagicMock()

    with (
        patch(
            "app.services.chat.webpage_ws_chat_emitter.get_webpage_ws_emitter",
            return_value=ws_emitter,
        ),
        patch("app.db.session.SessionLocal", return_value=db),
        patch(
            "app.services.context.context_service.context_service.get_briefs_by_subtask",
            return_value=briefs,
        ) as get_briefs,
    ):
        await emitter.emit_done(task_id=1, subtask_id=2, result={"value": "Done"})

    event, payload = sio.emit.await_args.args
    assert event == "chat:done"
    assert payload.get("contexts") == [
        brief.model_dump(mode="json") for brief in briefs
    ]
    assert "binary_data" not in str(payload)
    assert "/private/workspace" not in str(payload)
    assert sio.emit.await_args.kwargs["room"] == "task:1"
    get_briefs.assert_called_once_with(db.__enter__.return_value, 2)

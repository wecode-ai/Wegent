# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.kind import ModelRef
from app.schemas.work_queue import AutoProcessConfig, TeamRef
from app.services.chat.storage.task_manager import TaskCreationResult
from app.services.inbox.direct_agent_handler import InboxDirectAgentHandler
from shared.models.db.enums import TriggerMode


@pytest.mark.asyncio
async def test_handle_passes_model_override_to_created_task():
    handler = InboxDirectAgentHandler()
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=7,
        user_name="queue-owner",
    )

    event = SimpleNamespace()
    auto_process = AutoProcessConfig(
        enabled=True,
        mode="direct_agent",
        triggerMode=TriggerMode.IMMEDIATE,
        teamRef=TeamRef(name="queue-team", namespace="default"),
        modelRef=ModelRef(name="gpt-5", namespace="default"),
        forceOverrideBotModel=True,
    )
    message = SimpleNamespace(
        id=11,
        status=None,
        process_task_id=None,
        content_snapshot=[],
    )
    work_queue = SimpleNamespace(id=3, user_id=7)
    team = SimpleNamespace(id=17, name="queue-team", namespace="default", user_id=7)

    create_task_result = TaskCreationResult(
        task=SimpleNamespace(id=123),
        user_subtask=SimpleNamespace(id=456),
        assistant_subtask=SimpleNamespace(id=789),
        ai_triggered=True,
    )

    with (
        patch.object(handler, "_resolve_team", return_value=team),
        patch.object(handler, "_extract_user_message", return_value="queue message"),
        patch.object(handler, "_find_latest_workspace_params", return_value={}),
        patch.object(
            handler,
            "_resolve_model_override",
            return_value=("gpt-5", True, "public"),
            create=True,
        ),
        patch.object(handler, "_register_task_completion_listener"),
        patch.object(handler, "_trigger_ai_in_background"),
        patch(
            "app.services.chat.storage.task_manager.create_chat_task",
            new_callable=AsyncMock,
            return_value=create_task_result,
        ) as mock_create_chat_task,
        patch("app.services.inbox.attachments.link_inbox_attachments_to_subtask"),
    ):
        await handler.handle(
            event=event,
            auto_process=auto_process,
            message=message,
            work_queue=work_queue,
            db=db,
        )

    params = mock_create_chat_task.await_args.kwargs["params"]
    assert params.model_id == "gpt-5"
    assert params.force_override_bot_model is True
    assert params.force_override_bot_model_type == "public"


def test_resolve_model_override_uses_public_model_type_for_public_model():
    handler = InboxDirectAgentHandler()
    db = MagicMock()
    owner = SimpleNamespace(id=7)
    auto_process = AutoProcessConfig(
        enabled=True,
        mode="direct_agent",
        triggerMode=TriggerMode.IMMEDIATE,
        teamRef=TeamRef(name="queue-team", namespace="default"),
        modelRef=ModelRef(name="gpt-5", namespace="default"),
        forceOverrideBotModel=True,
    )

    with patch(
        "app.services.inbox.direct_agent_handler.kindReader.get_by_name_and_namespace",
        return_value=SimpleNamespace(user_id=0, namespace="default"),
        create=True,
    ):
        model_name, force_override, model_type = handler._resolve_model_override(
            db=db,
            owner=owner,
            auto_process=auto_process,
        )

    assert model_name == "gpt-5"
    assert force_override is True
    assert model_type == "public"

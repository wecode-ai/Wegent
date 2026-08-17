# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for device-targeted subscription task creation."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.schemas.subscription import SubscriptionExecutionTarget
from app.tasks.subscription_tasks import (
    _add_subscription_labels_to_task,
    _create_subscription_task,
)


@pytest.mark.asyncio
async def test_device_subscription_task_uses_task_surface():
    """Device subscriptions must load the same task-mode capabilities as device chat."""
    ctx = SimpleNamespace(
        subscription=SimpleNamespace(id=88),
        subscription_crd=SimpleNamespace(
            spec=SimpleNamespace(
                knowledgeBaseRefs=None,
                modelRef=None,
                executionTarget=SubscriptionExecutionTarget(
                    type="local",
                    device_id="local-device-1",
                ),
            )
        ),
        execution=SimpleNamespace(prompt="check mail", inbox_message_id=0),
        workspace_info=SimpleNamespace(
            git_url="",
            git_repo="",
            git_repo_id=0,
            git_domain="",
            branch_name="",
        ),
        preserve_history=False,
        bound_task_id=0,
        user=SimpleNamespace(id=7),
        team=SimpleNamespace(id=9),
        resolved_device_id=None,
    )
    creation_result = SimpleNamespace(
        task=SimpleNamespace(id=123),
        user_subtask=None,
        assistant_subtask=SimpleNamespace(id=456),
    )
    create_chat_task = AsyncMock(return_value=creation_result)

    with patch(
        "app.services.chat.storage.create_chat_task",
        create_chat_task,
    ):
        result = await _create_subscription_task(
            db=MagicMock(),
            ctx=ctx,
            task_title="Daily mail report",
        )

    assert result is not None
    params = create_chat_task.await_args.kwargs["params"]
    assert params.task_type == "task"
    assert params.device_id == "local-device-1"


def test_device_subscription_repairs_reused_task_surface():
    """Reused device tasks must not retain the legacy chat-mode label."""
    task = SimpleNamespace(
        id=123,
        is_active=1,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": "task-123",
                "namespace": "default",
                "labels": {"taskType": "chat"},
            },
            "spec": {
                "title": "Daily mail report",
                "prompt": "check mail",
                "teamRef": {"name": "team-9", "namespace": "default"},
                "workspaceRef": {
                    "name": "workspace-123",
                    "namespace": "default",
                },
                "device_id": "local-device-1",
            },
            "status": {"state": "Available", "status": "COMPLETED"},
        },
    )
    db = MagicMock()

    with patch("app.tasks.subscription_tasks.task_store") as task_store:
        _add_subscription_labels_to_task(
            db=db,
            task=task,
            subscription_id=88,
            execution_id=99,
        )

    payload = task_store.update_json.call_args.kwargs["payload"]
    assert payload["metadata"]["labels"]["taskType"] == "task"

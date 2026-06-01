# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock

from app.models.task import TaskResource
from app.services.chat.standalone_workspace import (
    WORKSPACE_PATH_LABEL,
    WORKSPACE_SOURCE_LABEL,
)
from app.services.execution.request_builder import TaskRequestBuilder


def test_merge_standalone_chat_workspace_from_task_labels():
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.json = {
        "metadata": {
            "labels": {
                WORKSPACE_PATH_LABEL: "/tmp/chats/2026-05-29/hello",
                WORKSPACE_SOURCE_LABEL: "local_path",
            }
        }
    }
    workspace_data = {"repository": {}, "branch": None, "path": None}

    builder._merge_standalone_chat_workspace(task, workspace_data)

    assert workspace_data["project"] == {
        "project_id": None,
        "workspace_source": "local_path",
        "project_workspace_path": "/tmp/chats/2026-05-29/hello",
        "execution_target_type": "local",
        "device_id": None,
        "checkout_path": None,
        "local_path": "/tmp/chats/2026-05-29/hello",
    }

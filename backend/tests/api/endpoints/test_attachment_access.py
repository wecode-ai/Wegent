# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import ANY, Mock

from app.api.endpoints.adapter import attachments
from app.models.subtask_context import ContextType


def test_linked_attachment_access_uses_task_permission_not_uploader_owner(monkeypatch):
    context = SimpleNamespace(
        id=10,
        user_id=5,
        subtask_id=123,
        context_type=ContextType.ATTACHMENT.value,
    )
    current_user = SimpleNamespace(id=7)
    subtask = SimpleNamespace(task_id=99)
    get_by_id = Mock(return_value=subtask)
    check_task_access = Mock(return_value=True)

    monkeypatch.setattr(attachments.subtask_store, "get_by_id", get_by_id)
    monkeypatch.setattr(attachments, "_check_task_access", check_task_access)

    attachments._ensure_attachment_access(Mock(), context, current_user)

    get_by_id.assert_called_once_with(ANY, subtask_id=123)
    check_task_access.assert_called_once_with(ANY, 99, 7)

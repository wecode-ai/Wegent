# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app.core.exceptions import ForbiddenException
from app.schemas.work_queue import ForwardMessageRequest, ForwardRecipient
from app.services import message_forwarding_service as module
from app.services.message_forwarding_service import MessageForwardingService


def test_forward_messages_requires_source_task_access(monkeypatch):
    db = Mock()
    task = SimpleNamespace(id=100, user_id=7)

    @contextmanager
    def fake_db():
        yield db

    monkeypatch.setattr(module.task_store, "get_active_task", Mock(return_value=task))
    monkeypatch.setattr(module.task_access_store, "is_member", Mock(return_value=False))
    monkeypatch.setattr(module.subtask_store, "list_by_task_ordered", Mock())

    service = MessageForwardingService()
    monkeypatch.setattr(service, "get_db", fake_db)

    request = ForwardMessageRequest(
        sourceTaskId=100,
        recipients=[ForwardRecipient(type="user", id=2)],
    )

    with pytest.raises(ForbiddenException):
        service.forward_messages(sender_user_id=9, request=request)

    module.task_access_store.is_member.assert_called_once_with(
        db, task_id=100, user_id=9
    )
    module.subtask_store.list_by_task_ordered.assert_not_called()

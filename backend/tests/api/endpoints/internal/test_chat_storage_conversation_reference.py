# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""History replay for messages that reference previous tasks."""

from types import SimpleNamespace

from fastapi import HTTPException

from app.api.endpoints.internal.chat_storage import _build_user_message_content
from app.models.subtask_context import ContextStatus, ContextType


class _FakeQuery:
    def __init__(self, result):
        self._result = result

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def all(self):
        return self._result


class _FakeDb:
    def __init__(self, contexts):
        self.contexts = contexts

    def query(self, *args, **kwargs):
        return _FakeQuery(self.contexts)


def _reference_context() -> SimpleNamespace:
    return SimpleNamespace(
        id=31,
        context_type=ContextType.CONVERSATION.value,
        status=ContextStatus.READY.value,
        name="old task",
        type_data={"task_id": 7},
        created_at=None,
    )


def test_history_replays_referenced_conversation_before_user_text(monkeypatch):
    subtask = SimpleNamespace(id=11, user_id=2, prompt="continue this work")
    reference_prompt = (
        "<referenced_conversations>old transcript</referenced_conversations>"
    )
    monkeypatch.setattr(
        "app.services.chat.preprocessing.conversation_references."
        "build_conversation_references_prompt",
        lambda db, *, contexts, user_id: reference_prompt,
    )

    content = _build_user_message_content(
        _FakeDb([_reference_context()]),
        subtask,
        sender_username=None,
    )

    assert content == [
        {"type": "text", "text": reference_prompt},
        {"type": "text", "text": "continue this work"},
    ]


def test_history_keeps_stored_user_text_when_reference_is_unavailable(monkeypatch):
    subtask = SimpleNamespace(id=11, user_id=2, prompt="continue this work")

    def _raise(*args, **kwargs):
        raise HTTPException(status_code=404, detail="Referenced task is unavailable")

    monkeypatch.setattr(
        "app.services.chat.preprocessing.conversation_references."
        "build_conversation_references_prompt",
        _raise,
    )

    content = _build_user_message_content(
        _FakeDb([_reference_context()]),
        subtask,
        sender_username=None,
    )

    assert content == "continue this work"

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.models.subtask import SubtaskStatus
from wecode.video.api import recovery
from wecode.video.api.polling import (
    AIGC_CARD_POLL_CONTEXTS_KEY,
)


class _FakeQuery:
    def __init__(self, subtasks):
        self.subtasks = subtasks

    def filter(self, *_args):
        return self

    def all(self):
        return self.subtasks


class _FakeSession:
    def __init__(self, subtasks):
        self.subtasks = subtasks
        self.closed = False

    def query(self, _model):
        return _FakeQuery(self.subtasks)

    def close(self):
        self.closed = True


def _pending_subtask(last_poll_at: str):
    card_id = "card-1"
    return SimpleNamespace(
        id=2,
        task_id=1,
        status=SubtaskStatus.COMPLETED,
        result={
            AIGC_CARD_POLL_CONTEXTS_KEY: {
                card_id: {
                    "task_id": 1,
                    "subtask_id": 2,
                    "task_url": "http://aigc.example/status",
                    "card_id": card_id,
                    "card_type": "video_director_generation",
                    "status": "polling",
                    "poll_count": 7,
                    "scheduled_token": "old-token",
                    "last_poll_at": last_poll_at,
                }
            },
            "blocks": [
                {
                    "id": f"card-{card_id}",
                    "type": "card",
                    "card_id": card_id,
                    "card_type": "video_director_generation",
                    "card_status": "pending",
                    "card_data": {},
                }
            ],
        },
    )


def test_recovery_requeues_stale_card_from_completed_subtask(monkeypatch):
    old_time = datetime.now(timezone.utc) - timedelta(minutes=5)
    subtask = _pending_subtask(old_time.isoformat())
    db = _FakeSession([subtask])
    dispatched = []

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: db)
    monkeypatch.setattr(
        "wecode.video.api.tasks.dispatch_aigc_card_poll",
        lambda **kwargs: dispatched.append(kwargs) or "celery-task",
    )

    recovered_count = recovery._recover_stale_polls()

    assert recovered_count == 1
    assert dispatched[0]["subtask_id"] == 2
    assert dispatched[0]["poll_count"] == 7
    assert dispatched[0]["countdown"] == 0
    assert db.closed is True


def test_recovery_skips_fresh_card(monkeypatch):
    subtask = _pending_subtask(datetime.now(timezone.utc).isoformat())
    db = _FakeSession([subtask])
    dispatched = []

    monkeypatch.setattr("app.db.session.SessionLocal", lambda: db)
    monkeypatch.setattr(
        "wecode.video.api.tasks.dispatch_aigc_card_poll",
        lambda **kwargs: dispatched.append(kwargs),
    )

    assert recovery._recover_stale_polls() == 0
    assert dispatched == []


@pytest.mark.asyncio
async def test_chat_completion_preserves_poll_context(monkeypatch):
    import app.services.chat.storage as chat_storage
    from app.services.chat.trigger import lifecycle

    context = _pending_subtask(datetime.now(timezone.utc).isoformat()).result[
        AIGC_CARD_POLL_CONTEXTS_KEY
    ]

    async def existing_result(_subtask_id):
        return {AIGC_CARD_POLL_CONTEXTS_KEY: context}

    class EmptySessionManager:
        async def get_accumulated_content(self, _subtask_id):
            return ""

        async def finalize_and_get_blocks(self, _subtask_id, **_kwargs):
            return []

    monkeypatch.setattr(lifecycle, "_get_existing_subtask_result", existing_result)
    monkeypatch.setattr(chat_storage, "session_manager", EmptySessionManager())

    result = await lifecycle.collect_completed_result(
        2,
        status="COMPLETED",
        result={"value": "done"},
    )

    assert result[AIGC_CARD_POLL_CONTEXTS_KEY] == context

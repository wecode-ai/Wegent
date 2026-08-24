# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from typing import Any

from wecode.video.api.cards import create_pending_card_block
from wecode.video.api.client import AigcCardStatus
from wecode.video.api.polling import (
    AIGC_CARD_POLL_CONTEXTS_KEY,
    prepare_poll_context,
)
from wecode.video.api.tasks import (
    dispatch_aigc_card_poll,
    poll_aigc_card_status,
)


def _pending_block() -> dict[str, Any]:
    return create_pending_card_block(
        card_id="card-1",
        card_type="video_director_generation",
        preview_title="生成中",
        progress_text="正在生成剧本",
    )


def test_poll_card_status_persists_completed_card(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        "wecode.video.api.tasks.claim_poll",
        lambda **_kwargs: True,
    )
    monkeypatch.setattr(
        "wecode.video.api.tasks.finish_poll",
        lambda **kwargs: captured.update(finished=kwargs),
    )
    monkeypatch.setattr(
        "wecode.video.api.tasks.fetch_card_status",
        lambda _url: AigcCardStatus(
            status="completed",
            progress=100,
            progress_text="剧本已生成",
            card={"title": "一分钟短片"},
            error="",
        ),
    )

    def persist(_task_id, _subtask_id, block, status):
        captured.update(block=block, status=status)
        return {"status": status, "card_id": block["card_id"]}

    monkeypatch.setattr("wecode.video.api.tasks._persist_card", persist)

    result = poll_aigc_card_status.run(
        task_id=1,
        subtask_id=2,
        task_url="http://aigc.example/status",
        block=_pending_block(),
        scheduled_token="poll-token",
    )

    assert result["status"] == "completed"
    assert captured["status"] == "completed"
    assert captured["block"]["card_status"] == "populated"
    assert captured["block"]["card_data"]["title"] == "一分钟短片"
    assert captured["finished"]["status"] == "completed"


def test_poll_card_status_persists_progress_and_schedules_next(monkeypatch):
    captured = {}
    monkeypatch.setattr(
        "wecode.video.api.tasks.claim_poll",
        lambda **_kwargs: True,
    )
    monkeypatch.setattr(
        "wecode.video.api.tasks.fetch_card_status",
        lambda _url: AigcCardStatus(
            status="partial_ready",
            progress=65,
            progress_text="主体生成中",
            card={"title": "主体", "link": "/chat?mode=video"},
            error="",
        ),
    )

    def persist(_task_id, _subtask_id, block, status):
        captured.update(block=block, persisted_status=status)
        return {"status": status, "card_id": block["card_id"]}

    def schedule(**kwargs):
        captured["scheduled"] = kwargs

    monkeypatch.setattr("wecode.video.api.tasks._persist_card", persist)
    monkeypatch.setattr("wecode.video.api.tasks._schedule_next", schedule)

    result = poll_aigc_card_status.run(
        task_id=1,
        subtask_id=2,
        task_url="http://aigc.example/status",
        block=_pending_block(),
        scheduled_token="poll-token",
    )

    assert result == {"status": "processing", "poll_count": 1}
    assert captured["block"]["card_status"] == "partial_ready"
    assert captured["block"]["card_preview_data"]["progress"] == 65
    assert captured["scheduled"]["poll_count"] == 1


def test_dispatch_persists_context_before_queueing(monkeypatch):
    events = []
    monkeypatch.setattr(
        "wecode.video.api.tasks.create_poll_token",
        lambda: "poll-token",
    )
    monkeypatch.setattr(
        "wecode.video.api.tasks.persist_poll_context",
        lambda **kwargs: events.append(("persist", kwargs)),
    )

    class QueuedTask:
        id = "celery-task"

    def apply_async(**kwargs):
        events.append(("queue", kwargs))
        return QueuedTask()

    monkeypatch.setattr(poll_aigc_card_status, "apply_async", apply_async)

    task_id = dispatch_aigc_card_poll(
        task_id=1,
        subtask_id=2,
        task_url="http://aigc.example/status",
        block=_pending_block(),
    )

    assert task_id == "celery-task"
    assert [event[0] for event in events] == ["persist", "queue"]
    assert events[1][1]["kwargs"]["scheduled_token"] == "poll-token"


def test_poll_ignores_superseded_schedule(monkeypatch):
    monkeypatch.setattr(
        "wecode.video.api.tasks.claim_poll",
        lambda **_kwargs: False,
    )
    monkeypatch.setattr(
        "wecode.video.api.tasks.fetch_card_status",
        lambda _url: (_ for _ in ()).throw(AssertionError("must not poll")),
    )

    result = poll_aigc_card_status.run(
        task_id=1,
        subtask_id=2,
        task_url="http://aigc.example/status",
        block=_pending_block(),
        scheduled_token="old-token",
    )

    assert result == {"status": "stale", "card_id": "card-1"}


def test_prepare_poll_context_preserves_other_cards(monkeypatch):
    existing_context = {"card-old": {"status": "polling"}}
    subtask = SimpleNamespace(result={AIGC_CARD_POLL_CONTEXTS_KEY: existing_context})
    captured = {}
    monkeypatch.setattr(
        "wecode.video.api.polling.subtask_store.get_by_id",
        lambda _db, **_kwargs: subtask,
    )
    monkeypatch.setattr(
        "wecode.video.api.polling.subtask_store.update_result",
        lambda _db, **kwargs: captured.update(kwargs),
    )

    prepare_poll_context(
        None,
        task_id=1,
        subtask_id=2,
        task_url="http://aigc.example/status",
        block=_pending_block(),
        poll_count=0,
        scheduled_token="poll-token",
    )

    contexts = captured["result"][AIGC_CARD_POLL_CONTEXTS_KEY]
    assert set(contexts) == {"card-old", "card-1"}
    assert contexts["card-1"]["scheduled_token"] == "poll-token"

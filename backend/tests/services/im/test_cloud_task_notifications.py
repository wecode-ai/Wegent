# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta

import pytest

from app.models.im_session import IMPrivateSession
from app.services.im.cloud_task_notifications import (
    CloudTaskNotificationEvent,
    CloudTaskSnapshot,
    cloud_task_notification_service,
)
from app.services.im.session_service import im_session_service


def _session(user_id: int, key: str, minutes_ago: int) -> IMPrivateSession:
    return IMPrivateSession(
        session_key=key,
        user_id=user_id,
        channel_type="telegram",
        channel_id=10,
        conversation_id=key,
        sender_id=key,
        last_seen_at=datetime.now() - timedelta(minutes=minutes_ago),
    )


@pytest.mark.asyncio
async def test_dispatch_uses_latest_session_and_dedupes_recipients(
    fake_im_session_cache,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    older = _session(7, "older", 10)
    newer = _session(7, "newer", 1)
    await im_session_service.save_session(older)
    await im_session_service.save_session(newer)
    sent: list[tuple[str, str]] = []

    async def fake_send_text(db, session, text):
        sent.append((session.session_key, text))
        return {"success": True}

    monkeypatch.setattr(
        "app.services.im.cloud_task_notifications.im_notification_dispatcher.send_text",
        fake_send_text,
    )
    snapshot = CloudTaskSnapshot(
        project_id="11",
        project_name="Wegent",
        task_id="WEG-1",
        title="Notify participants",
        created_by_user_id=7,
        assignee_user_id=7,
        collaborator_user_ids=(7,),
        status="pending",
    )
    event = CloudTaskNotificationEvent(
        event_id="event-1",
        event_type="created",
        actor_user_id=7,
        actor_name="alice",
        after=snapshot,
    )

    result = await cloud_task_notification_service.dispatch(event)

    assert result["sent"] == 1
    assert sent[0][0] == "newer"
    assert "WEG-1 · Notify participants" in sent[0][1]


@pytest.mark.asyncio
async def test_dispatch_is_idempotent(
    fake_im_session_cache,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    await im_session_service.save_session(_session(9, "only", 0))
    calls = 0

    async def fake_send_text(db, session, text):
        nonlocal calls
        calls += 1
        return {"success": True}

    monkeypatch.setattr(
        "app.services.im.cloud_task_notifications.im_notification_dispatcher.send_text",
        fake_send_text,
    )
    snapshot = CloudTaskSnapshot(
        project_id="11",
        project_name="Wegent",
        task_id="WEG-2",
        title="One notification",
        created_by_user_id=9,
    )
    event = CloudTaskNotificationEvent(
        event_id="event-2",
        event_type="created",
        actor_user_id=9,
        actor_name="bob",
        after=snapshot,
    )

    first = await cloud_task_notification_service.dispatch(event)
    second = await cloud_task_notification_service.dispatch(event)

    assert first["sent"] == 1
    assert second["skipped"] == "duplicate_or_cache_error"
    assert calls == 1


def test_change_summary_only_includes_key_fields() -> None:
    before = CloudTaskSnapshot(
        project_id="11",
        project_name="Wegent",
        task_id="WEG-3",
        title="Old title",
        status="pending",
        priority="low",
    )
    after = CloudTaskSnapshot(
        project_id="11",
        project_name="Wegent",
        task_id="WEG-3",
        title="New title",
        status="in_progress",
        priority="high",
    )

    summary = cloud_task_notification_service.change_summary(before, after)

    assert "状态 pending → in_progress" in summary
    assert "优先级 low → high" in summary
    assert "title" not in summary

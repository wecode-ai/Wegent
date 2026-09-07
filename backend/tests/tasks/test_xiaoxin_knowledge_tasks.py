# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the daily Xiaoxin HR knowledge-sync trigger."""

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from celery.schedules import crontab

from app.core.celery_app import celery_app
from app.core.config import settings
from app.tasks.xiaoxin_knowledge_tasks import sync_xiaoxin_hr_knowledge


def _configure_daily_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    values = {
        "XIAOXIN_SYNC_ENABLED": True,
        "XIAOXIN_KNOWLEDGE_PULL_URL": "http://xiaoxin.test/knowledge/pull",
        "XIAOXIN_SIGN_SECRET": "placeholder-secret",
        "XIAOXIN_TARGET_KB_ID": 101,
        "XIAOXIN_SYNC_USER_ID": 102,
    }
    for name, value in values.items():
        monkeypatch.setattr(settings, name, value)


@pytest.mark.unit
def test_daily_beat_dispatches_at_3am_beijing_time() -> None:
    schedule = celery_app.conf.beat_schedule["sync-xiaoxin-hr-knowledge-daily"]

    assert schedule == {
        "task": "app.tasks.xiaoxin_knowledge_tasks.sync_xiaoxin_hr_knowledge",
        "schedule": crontab(hour=19, minute=0),
    }


@pytest.mark.unit
def test_daily_sync_disabled_has_no_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "XIAOXIN_SYNC_ENABLED", False)
    submit = MagicMock()
    session = MagicMock()
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.submit_xiaoxin_hr_sync", submit
    )
    monkeypatch.setattr("app.tasks.xiaoxin_knowledge_tasks.SessionLocal", session)

    result = sync_xiaoxin_hr_knowledge.run()

    assert result == {"status": "skipped", "reason": "sync_disabled"}
    submit.assert_not_called()
    session.assert_not_called()


@pytest.mark.unit
def test_daily_sync_incomplete_configuration_has_no_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_daily_sync(monkeypatch)
    monkeypatch.setattr(settings, "XIAOXIN_SIGN_SECRET", "")
    submit = MagicMock()
    session = MagicMock()
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.submit_xiaoxin_hr_sync", submit
    )
    monkeypatch.setattr("app.tasks.xiaoxin_knowledge_tasks.SessionLocal", session)

    result = sync_xiaoxin_hr_knowledge.run()

    assert result == {
        "status": "skipped",
        "reason": "missing_configuration:XIAOXIN_SIGN_SECRET",
    }
    submit.assert_not_called()
    session.assert_not_called()


@pytest.mark.unit
def test_daily_sync_without_pull_url_has_no_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_daily_sync(monkeypatch)
    monkeypatch.setattr(settings, "XIAOXIN_KNOWLEDGE_PULL_URL", "")
    submit = MagicMock()
    session = MagicMock()
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.submit_xiaoxin_hr_sync", submit
    )
    monkeypatch.setattr("app.tasks.xiaoxin_knowledge_tasks.SessionLocal", session)

    result = sync_xiaoxin_hr_knowledge.run()

    assert result == {
        "status": "skipped",
        "reason": "missing_configuration:XIAOXIN_KNOWLEDGE_PULL_URL",
    }
    submit.assert_not_called()
    session.assert_not_called()


@pytest.mark.unit
def test_daily_sync_lock_held_has_no_side_effects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_daily_sync(monkeypatch)
    lock = MagicMock()
    lock.acquire_context.return_value = nullcontext(False)
    submit = MagicMock()
    session = MagicMock()
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.distributed_lock",
        lock,
        raising=False,
    )
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.submit_xiaoxin_hr_sync", submit
    )
    monkeypatch.setattr("app.tasks.xiaoxin_knowledge_tasks.SessionLocal", session)

    result = sync_xiaoxin_hr_knowledge.run()

    assert {
        "result": result,
        "lock_call": lock.acquire_context.call_args,
        "submit_called": submit.called,
        "session_called": session.called,
    } == {
        "result": {
            "status": "skipped",
            "reason": "lock_held_by_another_instance",
        },
        "lock_call": (("sync_xiaoxin_hr_knowledge",), {"expire_seconds": 120}),
        "submit_called": False,
        "session_called": False,
    }


@pytest.mark.unit
def test_daily_sync_calls_shared_fixed_target_service_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _configure_daily_sync(monkeypatch)
    lock = MagicMock()
    lock.acquire_context.return_value = nullcontext(True)
    db = object()
    document = SimpleNamespace(id=202)
    submit = MagicMock(
        return_value=SimpleNamespace(knowledge_base_id=101, document=document)
    )
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.distributed_lock",
        lock,
        raising=False,
    )
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.submit_xiaoxin_hr_sync", submit
    )
    monkeypatch.setattr(
        "app.tasks.xiaoxin_knowledge_tasks.SessionLocal", lambda: nullcontext(db)
    )
    monkeypatch.setattr(
        "app.services.knowledge.xiaoxin.pull_xiaoxin_hr_snapshot",
        MagicMock(side_effect=AssertionError("daily task must not pull directly")),
    )
    monkeypatch.setattr(
        "app.services.knowledge.xiaoxin.project_xiaoxin_faq",
        MagicMock(side_effect=AssertionError("daily task must not render directly")),
    )

    result = sync_xiaoxin_hr_knowledge.run()

    assert {
        "result": result,
        "lock_call": lock.acquire_context.call_args,
        "submit_call": submit.call_args,
    } == {
        "result": {
            "status": "submitted",
            "knowledge_base_id": 101,
            "document_id": 202,
        },
        "lock_call": (("sync_xiaoxin_hr_knowledge",), {"expire_seconds": 120}),
        "submit_call": ((db,), {"trigger_source": "daily"}),
    }

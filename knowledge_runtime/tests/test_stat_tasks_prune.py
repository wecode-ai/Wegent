# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the weekly prune task (P1-7: retention config must take effect)."""

from types import SimpleNamespace
from unittest.mock import MagicMock


def test_prune_task_reads_retention_from_config(monkeypatch) -> None:
    """When the beat calls the task with no kwargs, retention must come from
    KNOWLEDGE_STAT_RETENTION_DAYS via settings — not a hardcoded default."""
    from knowledge_runtime import config
    from knowledge_runtime.tasks import stat_tasks

    monkeypatch.setattr(
        config,
        "get_settings",
        lambda: SimpleNamespace(knowledge_stat_retention_days=123),
    )

    captured: dict = {}

    def fake_prune(*, retention_days, stat_session_factory):
        captured["days"] = retention_days
        return 7

    monkeypatch.setattr(stat_tasks, "prune_old_runs", fake_prune)
    monkeypatch.setattr(
        "shared.db.stat_session.get_stat_session_factory", lambda: MagicMock()
    )

    result = stat_tasks.prune_old_runs_task(None)
    assert result == 7
    assert captured["days"] == 123


def test_prune_task_explicit_arg_overrides_config(monkeypatch) -> None:
    """A manual ``celery call`` with an explicit value overrides the env var."""
    from knowledge_runtime import config
    from knowledge_runtime.tasks import stat_tasks

    monkeypatch.setattr(
        config,
        "get_settings",
        lambda: SimpleNamespace(knowledge_stat_retention_days=123),
    )

    captured: dict = {}

    def fake_prune(*, retention_days, stat_session_factory):
        captured["days"] = retention_days
        return 0

    monkeypatch.setattr(stat_tasks, "prune_old_runs", fake_prune)
    monkeypatch.setattr(
        "shared.db.stat_session.get_stat_session_factory", lambda: MagicMock()
    )

    stat_tasks.prune_old_runs_task(999)
    assert captured["days"] == 999


def test_prune_task_skips_when_retention_zero(monkeypatch) -> None:
    """retention_days<=0 (retain-forever) short-circuits before opening a DB
    session — prune_old_runs must not be called."""
    from knowledge_runtime import config
    from knowledge_runtime.tasks import stat_tasks

    monkeypatch.setattr(
        config, "get_settings", lambda: SimpleNamespace(knowledge_stat_retention_days=0)
    )

    def fake_prune(*, retention_days, stat_session_factory):
        raise AssertionError("prune must not run when retention<=0")

    monkeypatch.setattr(stat_tasks, "prune_old_runs", fake_prune)

    # A regression that opens a DB session before the early return must still
    # fail this test, so assert the session factory is never touched.
    mock_get_session_factory = MagicMock()
    monkeypatch.setattr(
        "shared.db.stat_session.get_stat_session_factory", mock_get_session_factory
    )

    assert stat_tasks.prune_old_runs_task(None) == 0
    mock_get_session_factory.assert_not_called()

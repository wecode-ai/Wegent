# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from knowledge_engine.stat.filters import MetricFilter
from knowledge_engine.stat.query import KbStatQueryService
from knowledge_engine.stat.registry import (
    all_collectors,
    collectors_by_domains,
    collectors_by_names,
)
from knowledge_engine.stat.runner import collect_all, mark_kb_stat_orphaned_runs


def test_registry_imports_every_collector() -> None:
    collectors = all_collectors()
    names = [collector.name for collector in collectors]

    assert len(names) == 73
    assert len(names) == len(set(names))
    assert "chunks_count_distribution" in names
    assert "storage_usage" in names
    assert "user_participation_summary" in names
    assert "kb_thin_doc_rate" in names
    assert "thin_doc_alert" not in names
    assert "orphan_doc_alert" not in names
    # Removed collectors (P1-5 memory-peak + P2-2 knowledge_coverage) must
    # not reappear in the registry.
    assert "retrieval_score_distribution" not in names
    assert "query_dedup_rate" not in names
    assert "kb_slow_query_rate" not in names
    assert "knowledge_coverage" not in names


def test_exact_collector_selection_rejects_unknown_names() -> None:
    with pytest.raises(ValueError, match="Unknown or disabled collectors"):
        collectors_by_names(["collector_that_does_not_exist"])


def test_domain_selection_rejects_unknown_domains() -> None:
    with pytest.raises(ValueError, match="Unknown or disabled collector domains"):
        collectors_by_domains(["domain_that_does_not_exist"])


def test_collect_all_rejects_unknown_domain_before_creating_run() -> None:
    stat_session_factory = MagicMock()

    with pytest.raises(ValueError, match="Unknown or disabled collector domains"):
        collect_all(
            target_date=date(2026, 7, 20),
            domains=["domain_that_does_not_exist"],
            source_session_factory=MagicMock(),
            stat_session_factory=stat_session_factory,
        )

    stat_session_factory.assert_not_called()


def test_orphaned_run_reconciliation_is_scoped_to_target_date() -> None:
    session = MagicMock()
    session.execute.return_value.rowcount = 2
    stat_session_factory = MagicMock()
    stat_session_factory.return_value.__enter__.return_value = session
    target = date(2026, 7, 20)

    marked = mark_kb_stat_orphaned_runs(
        target_date=target,
        stat_session_factory=stat_session_factory,
    )

    assert marked == 2
    assert session.execute.call_count == 2
    for call in session.execute.call_args_list:
        assert "target_date = :target_date" in str(call.args[0])
        assert call.args[1]["target_date"] == target
    session.commit.assert_called_once()


def test_metric_filter_uses_one_inclusive_end_anchor() -> None:
    metric_filter = MetricFilter(
        target_date=date(2026, 7, 1),
        end_date=date(2026, 7, 20),
        lookback_days=7,
    )

    assert metric_filter.effective_period_start == date(2026, 7, 14)
    assert metric_filter.period_end_date == date(2026, 7, 20)
    assert metric_filter.effective_end_date == date(2026, 7, 21)


def test_explicit_period_start_wins_over_lookback() -> None:
    metric_filter = MetricFilter(
        target_date=date(2026, 7, 20),
        period_start_date=date(2026, 7, 3),
        lookback_days=7,
    )

    assert metric_filter.effective_period_start == date(2026, 7, 3)


def test_latest_metric_run_requires_successful_collector_and_full_admin_scope() -> None:
    session = MagicMock()
    session.execute.return_value.fetchone.return_value = SimpleNamespace(
        id=42,
        completed_at=None,
        status="partial",
    )
    service = KbStatQueryService(stat_session_factory=MagicMock())

    result = service._latest_run(
        session,
        collector_name="storage_usage",
        kb_ids=None,
    )

    assert result is not None
    sql = str(session.execute.call_args.args[0])
    params = session.execute.call_args.args[1]
    assert "c.collector_name = :collector_name" in sql
    assert "c.status = 'success'" in sql
    assert "r.kb_filter IS NULL" in sql
    assert params["collector_name"] == "storage_usage"


def test_latest_metric_run_accepts_full_or_matching_kb_run() -> None:
    session = MagicMock()
    session.execute.return_value.fetchone.return_value = None
    service = KbStatQueryService(stat_session_factory=MagicMock())

    service._latest_run(
        session,
        collector_name="kb_health_score",
        kb_ids=[7],
    )

    sql = str(session.execute.call_args.args[0])
    params = session.execute.call_args.args[1]
    assert "r.kb_filter IS NULL" in sql
    assert "JSON_CONTAINS(r.kb_filter, JSON_ARRAY(:scope_kb_0))" in sql
    assert params["scope_kb_0"] == 7


def test_latest_metric_run_requires_a_multi_kb_run_to_cover_every_requested_kb() -> (
    None
):
    session = MagicMock()
    session.execute.return_value.fetchone.return_value = None
    service = KbStatQueryService(stat_session_factory=MagicMock())

    service._latest_run(
        session,
        collector_name="kb_health_score",
        kb_ids=[7, 8],
    )

    sql = str(session.execute.call_args.args[0])
    assert "JSON_CONTAINS(r.kb_filter, " "JSON_ARRAY(:scope_kb_0, :scope_kb_1))" in sql


def test_explicit_run_requires_successful_collector_and_matching_scope() -> None:
    session = MagicMock()
    session.execute.return_value.fetchone.return_value = None
    service = KbStatQueryService(stat_session_factory=MagicMock())
    metric_filter = MetricFilter(
        target_date=date(2026, 7, 20),
        kb_ids=[7],
        run_id=123,
    )

    run_id, completed_at = service._resolve_run(
        session,
        metric_filter,
        metric_name="kb_health_score",
    )

    assert run_id is None
    assert completed_at is None
    sql = str(session.execute.call_args.args[0])
    assert "c.collector_name = :collector_name" in sql
    assert "c.status = 'success'" in sql
    assert "r.status IN ('completed', 'partial')" in sql


def _make_spec(*, date_col, kb_col="kb_id", order_by="stat_date", limit=60):
    return SimpleNamespace(
        table="kb_stat_kb_health_score",
        schema=[],
        date_col=date_col,
        kb_col=kb_col,
        query_options=SimpleNamespace(order_by=order_by, limit=limit),
    )


def test_stat_date_metric_aggregates_across_runs() -> None:
    """A stat_date metric must span successful runs, not pin one run_id.

    The daily beat writes only the current day per run (lookback_days=1), so a
    30-day trend is assembled by taking the latest run per stat_date across
    all completed runs. Pinning a single run_id would yield one point.
    """
    session = MagicMock()
    session.execute.return_value.fetchall.return_value = []
    service = KbStatQueryService(stat_session_factory=MagicMock())
    spec = _make_spec(date_col="stat_date", kb_col="kb_id")
    metric_filter = MetricFilter(
        target_date=date(2026, 7, 20),
        kb_ids=[7],
        lookback_days=30,
    )

    service._fetch_one(
        session,
        "kb_health_score",
        spec,
        metric_filter,
        run_id=10,
        run_completed_at=None,
    )

    sql = str(session.execute.call_args.args[0])
    # Cross-run dedup: latest run_id per (stat_date, kb_id)
    assert "MAX(run_id) AS max_run" in sql
    assert "GROUP BY stat_date, kb_id" in sql
    assert "t.stat_date = latest.stat_date" in sql
    assert "t.kb_id = latest.kb_id" in sql
    # Must NOT collapse to a single run
    assert "run_id = :run_id" not in sql


def test_stat_date_metric_excludes_failed_runs() -> None:
    """Failed/timed-out runs must not pollute the trend."""
    session = MagicMock()
    session.execute.return_value.fetchall.return_value = []
    service = KbStatQueryService(stat_session_factory=MagicMock())
    spec = _make_spec(date_col="stat_date", kb_col=None)
    metric_filter = MetricFilter(target_date=date(2026, 7, 20), lookback_days=30)

    service._fetch_one(
        session,
        "rag_call_frequency",
        spec,
        metric_filter,
        run_id=10,
        run_completed_at=None,
    )

    sql = str(session.execute.call_args.args[0])
    assert "r.status IN ('completed', 'partial')" in sql
    assert "c.status = 'success'" in sql


def test_snapshot_metric_still_uses_single_latest_run() -> None:
    """Snapshot metrics (date_col is None) have no time axis: keep single run."""
    session = MagicMock()
    session.execute.return_value.fetchall.return_value = []
    service = KbStatQueryService(stat_session_factory=MagicMock())
    spec = _make_spec(date_col=None, kb_col=None, order_by=None, limit=10)
    metric_filter = MetricFilter(target_date=date(2026, 7, 20), lookback_days=30)

    service._fetch_one(
        session, "some_snapshot", spec, metric_filter, run_id=10, run_completed_at=None
    )

    sql = str(session.execute.call_args.args[0])
    params = session.execute.call_args.args[1]
    assert "run_id = :run_id" in sql
    assert params["run_id"] == 10
    assert "MAX(run_id)" not in sql


def test_collect_all_re_raises_soft_time_limit(monkeypatch) -> None:
    """A soft timeout must propagate to Celery, not be swallowed as a normal
    return (P1-4). Without the re-raise, collect_all returns run_id and Celery
    marks a timed-out task SUCCESS — defeating soft_time_limit retry/alerts."""
    from knowledge_engine.stat import runner
    from knowledge_engine.stat.runner import SoftTimeLimitExceeded

    def boom(*args, **kwargs):
        raise SoftTimeLimitExceeded()

    fake_collector = SimpleNamespace(domain="retrieval", name="fake", fn=boom)
    monkeypatch.setattr(runner, "all_collectors", lambda: [fake_collector])

    stat_session = MagicMock()
    stat_session.execute.return_value.lastrowid = 1

    with pytest.raises(SoftTimeLimitExceeded):
        collect_all(
            target_date=date(2026, 7, 20),
            source_session_factory=MagicMock(),
            stat_session_factory=MagicMock(return_value=stat_session),
        )

    # The run was still finalized as failed before re-raising.
    finalize_calls = [str(c.args[0]) for c in stat_session.execute.call_args_list]
    assert any("UPDATE kb_stat_runs" in s for s in finalize_calls)

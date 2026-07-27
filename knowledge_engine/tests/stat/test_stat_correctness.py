# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from knowledge_engine.stat.extractors.query_event import _parse_event
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

    assert len(names) == 77
    assert len(names) == len(set(names))
    assert "chunks_count_distribution" in names
    assert "storage_usage" in names
    assert "user_participation_summary" in names
    assert "kb_thin_doc_rate" in names
    assert "thin_doc_alert" not in names
    assert "orphan_doc_alert" not in names


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


def test_query_event_is_parsed_once_for_fact_reuse() -> None:
    row = SimpleNamespace(
        id=99,
        created_at=datetime(2026, 7, 20, 12, 30),
        user_id=12,
        type_data={
            "knowledge_id": "7",
            "rag_result": {
                "injection_mode": "rag_retrieval",
                "chunks_count": 3,
                "retrieval_count": 2,
                "restricted_mode": False,
                "query": "  Hello   WORLD ",
                "latency_ms": 120,
            },
            "adoption_result": {"cited_count": 1},
            "kb_head_result": {"document_ids": [1]},
        },
    )

    event = _parse_event(row, run_id=5)

    assert event["kb_id"] == 7
    assert event["is_rag"] is True
    assert event["is_kb_head"] is True
    assert event["hit"] is True
    assert event["adopted"] is True
    assert event["query_hash"] is not None

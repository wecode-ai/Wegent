# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Boundary tests for user_pattern_evolution and user_participation_summary.

Covers tmp/b88.md §五: each source query must apply an exclusive end bound
(``created_at < effective_end_date``), exclude NULL user_id, and (for
members) count only approved direct-user members; the participation Top-500
ordering must be stable (total DESC, user_id ASC).
"""

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

from knowledge_engine.stat.collectors.deep_analysis import user_pattern_evolution
from knowledge_engine.stat.collectors.user_behavior import user_participation_summary
from knowledge_engine.stat.filters import MetricFilter


def _source_calls(mock_session):
    """Return [(sql_text, params_dict)] for each source_session.execute call."""
    out = []
    for call in mock_session.execute.call_args_list:
        sql = str(call.args[0])
        params = call.args[1] if len(call.args) > 1 else call.kwargs
        out.append((sql, params))
    return out


# --------------------------------------------------------------------------- #
# user_pattern_evolution
# --------------------------------------------------------------------------- #


def test_user_pattern_evolution_has_6month_window_and_exclusive_end() -> None:
    source = MagicMock()
    source.execute.return_value.fetchall.return_value = []
    stat = MagicMock()
    mfilter = MetricFilter(target_date=date(2026, 7, 29), lookback_days=30)

    user_pattern_evolution(1, mfilter, source_session=source, stat_session=stat)

    sql, params = _source_calls(source)[0]
    assert "created_at >= DATE_SUB(:end_date, INTERVAL 6 MONTH)" in sql
    assert "created_at < :end_date" in sql
    assert "sc.user_id IS NOT NULL" in sql
    # exclusive end bound is effective_end_date (target_date + 1 day)
    assert params["end_date"] == mfilter.effective_end_date
    assert params["end_date"] == date(2026, 7, 30)


def test_user_pattern_evolution_kb_filter_preserved() -> None:
    source = MagicMock()
    source.execute.return_value.fetchall.return_value = []
    stat = MagicMock()
    mfilter = MetricFilter(target_date=date(2026, 7, 29), kb_ids=[7], lookback_days=30)

    user_pattern_evolution(1, mfilter, source_session=source, stat_session=stat)

    sql, params = _source_calls(source)[0]
    assert "JSON_EXTRACT(sc.type_data, '$.knowledge_id')" in sql
    assert params["kbf_0"] == 7


# --------------------------------------------------------------------------- #
# user_participation_summary
# --------------------------------------------------------------------------- #


def test_participation_summary_all_sources_bounded_by_end_date() -> None:
    source = MagicMock()
    source.execute.return_value.fetchall.return_value = []
    stat = MagicMock()
    mfilter = MetricFilter(target_date=date(2026, 7, 29), lookback_days=30)

    user_participation_summary(1, mfilter, source_session=source, stat_session=stat)

    calls = _source_calls(source)
    assert len(calls) == 4  # creators / uploaders / retrievers / members
    end_date = mfilter.effective_end_date
    for sql, params in calls:
        assert "created_at < :end_date" in sql
        assert "user_id IS NOT NULL" in sql
        assert params["end_date"] == end_date
        # No lookback-based start bound on any source (cumulative snapshot).
        assert "DATE_SUB" not in sql


def test_participation_summary_member_source_approved_user_only() -> None:
    source = MagicMock()
    source.execute.return_value.fetchall.return_value = []
    stat = MagicMock()
    mfilter = MetricFilter(target_date=date(2026, 7, 29), lookback_days=30)

    user_participation_summary(1, mfilter, source_session=source, stat_session=stat)

    calls = _source_calls(source)
    # The member query is the 4th source (resource_members).
    member_sql, _ = calls[3]
    assert "FROM resource_members" in member_sql
    assert "resource_type = 'KnowledgeBase'" in member_sql
    assert "entity_type = 'user'" in member_sql
    assert "status = 'approved'" in member_sql


def test_participation_summary_stable_sort_when_total_ties() -> None:
    """Equal totals must break ties by user_id ASC (stable Top-500)."""
    source = MagicMock()
    # Four source queries then the user-name query; user 2 is a creator,
    # user 1 is an uploader — both total 5, so user_id ASC wins (1 before 2).
    rows_per_query = [
        [SimpleNamespace(user_id=2, cnt=5)],  # creators
        [SimpleNamespace(user_id=1, cnt=5)],  # uploaders
        [],  # retrievers
        [],  # members
        [],  # user_names query (returns nothing → falls back to str(uid))
    ]
    it = iter(rows_per_query)

    def _execute(*args, **kwargs):
        m = MagicMock()
        m.fetchall.return_value = next(it)
        return m

    source.execute.side_effect = _execute
    stat = MagicMock()
    mfilter = MetricFilter(target_date=date(2026, 7, 29), lookback_days=30)

    user_participation_summary(1, mfilter, source_session=source, stat_session=stat)

    # INSERT order is the Top-500 order: user 1 then user 2 (tie on total=5).
    insert_uids = [call.args[1]["user_id"] for call in stat.execute.call_args_list]
    assert insert_uids == [1, 2]

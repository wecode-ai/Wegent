# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared query helpers for KB-stat metrics (metadata lives in metric_spec.py)."""

import logging
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Optional

from knowledge_engine.stat.filters import MetricFilter
from knowledge_engine.stat.metric_spec import (
    _DOMAIN_LABELS,
    _KB_DETAIL_DOMAINS,
    _KB_DETAIL_EXCLUDED_METRICS,
    _METRIC_COLLECTOR_OVERRIDES,
    _METRIC_SPECS,
)

logger = logging.getLogger(__name__)

_TZ_CN = timezone(timedelta(hours=8))


def _iso(dt: datetime | date | None) -> str | None:
    """Format datetime as +08:00 for display.

    MySQL stores UTC; naive datetimes are treated as UTC and converted to CST.
    """
    if dt is None:
        return None
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc).astimezone(_TZ_CN)
        return dt.isoformat()
    return dt.isoformat()


@lru_cache(maxsize=8)
def build_metric_list(scope: str = "admin") -> list[dict]:
    """Build domain-grouped metric metadata list for the /metrics/list API.

    Reads ``_METRIC_SPECS`` (the single source of truth in metric_spec.py)
    and groups by domain. Cached: the result depends only on ``scope``
    ("admin"/"kb") and on module-level constants, so it is immutable between
    deploys. Every page load calls /metrics/list; memoizing avoids rebuilding
    the domain map on each request.
    """
    domains: dict[str, list[dict]] = {}
    for name, spec in _METRIC_SPECS.items():
        if scope == "kb" and spec.domain not in _KB_DETAIL_DOMAINS:
            continue
        if scope == "kb" and name in _KB_DETAIL_EXCLUDED_METRICS:
            continue
        metric_meta = {
            "name": name,
            "label": spec.label,
            "chart_hint": spec.chart_hint,
            "description": spec.description,
            # date_col tells the frontend whether this metric responds to
            # the time-range selector (non-null = time-series) or is a
            # static snapshot (null). The frontend uses this to show a
            # "sliding window" vs "current snapshot" badge.
            "date_col": spec.date_col,
        }
        if spec.query_options and spec.query_options.limit:
            metric_meta["row_limit"] = spec.query_options.limit
        domains.setdefault(spec.domain, []).append(metric_meta)
    return [
        {"domain": d, "label": _DOMAIN_LABELS.get(d, d), "metrics": ms}
        for d, ms in sorted(domains.items())
    ]


def _collector_for_metric(metric_name: Optional[str]) -> Optional[str]:
    if metric_name is None:
        return None
    return _METRIC_COLLECTOR_OVERRIDES.get(metric_name, metric_name)


def _successful_run_condition(
    metric_name: str,
    filter: MetricFilter,
    *,
    run_column: str = "run_id",
    param_prefix: str = "metric_run",
) -> tuple[str, dict[str, Any]]:
    """Build an indicator-specific successful-run and scope predicate."""
    params: dict[str, Any] = {
        f"{param_prefix}_collector": _collector_for_metric(metric_name)
    }
    scope = "r.kb_filter IS NULL"
    if filter.kb_ids:
        placeholders = []
        for index, kb_id in enumerate(filter.kb_ids):
            key = f"{param_prefix}_kb_{index}"
            placeholders.append(f":{key}")
            params[key] = kb_id
        requested_scope = ", ".join(placeholders)
        scope = (
            "(r.kb_filter IS NULL OR "
            f"JSON_CONTAINS(r.kb_filter, JSON_ARRAY({requested_scope})))"
        )
    condition = (
        f"{run_column} IN ("
        "SELECT r.id FROM kb_stat_runs r "
        "JOIN kb_stat_collector_runs c ON c.run_id = r.id "
        f"WHERE c.collector_name = :{param_prefix}_collector "
        "AND c.status = 'success' "
        "AND r.status IN ('completed', 'partial') "
        f"AND {scope})"
    )
    return condition, params


def _cross_run_latest_query(
    *,
    table: str,
    date_col: str,
    spec,
    filter: MetricFilter,
    metric_name: str,
    qopts,
    ignore_limit: bool,
) -> tuple[str, dict[str, Any]]:
    """Build a cross-run "latest successful run per (date, kb)" query.

    Both ``target_date`` and ``stat_date`` metrics write only the current day's
    row per run (the daily beat uses ``lookback_days=1``). A multi-day trend
    therefore must span ALL successful runs and pick the latest ``run_id`` per
    date — and per ``kb_id`` for per-KB tables, so the join does not collapse
    different KBs onto one run's row. Failed/timed-out runs are excluded by
    :func:`_successful_run_condition` so they never pollute the trend.
    """
    run_condition, params = _successful_run_condition(metric_name, filter)
    conds = [run_condition]
    if filter.effective_period_start:
        conds.append(f"{date_col} >= :start_date")
        params["start_date"] = filter.effective_period_start
    if filter.period_end_date:
        conds.append(f"{date_col} <= :end_date")
        params["end_date"] = filter.period_end_date
    if spec.kb_col and filter.kb_ids:
        placeholders = ", ".join(f":kid_{i}" for i in range(len(filter.kb_ids)))
        conds.append(f"{spec.kb_col} IN ({placeholders})")
        for i, kid in enumerate(filter.kb_ids):
            params[f"kid_{i}"] = kid

    where = " AND ".join(conds)

    dedup_cols = date_col
    if spec.kb_col:
        dedup_cols = f"{date_col}, {spec.kb_col}"

    order_by = qopts.order_by if qopts and qopts.order_by else date_col
    limit = None if ignore_limit else (qopts.limit if qopts and qopts.limit else 60)

    sql = (
        f"SELECT t.* FROM {table} t "
        f"INNER JOIN ("
        f"  SELECT {dedup_cols}, MAX(run_id) AS max_run "
        f"  FROM {table} WHERE {where} "
        f"  GROUP BY {dedup_cols}"
        f") latest ON t.{date_col} = latest.{date_col} "
        f"AND t.run_id = latest.max_run"
    )
    if spec.kb_col:
        sql += f" AND t.{spec.kb_col} = latest.{spec.kb_col}"
    sql += f" ORDER BY t.{order_by}"
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    return sql, params

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified metric filter and SQL clause builder for all collectors.
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional, Sequence


@dataclass(frozen=True)
class MetricFilter:
    """Unified filter conditions passed to every collector."""

    target_date: date
    kb_ids: Optional[Sequence[int]] = None  # None = all KBs
    namespaces: Optional[Sequence[str]] = None
    lookback_days: int = 30
    end_date: Optional[date] = None  # defaults to target_date
    period_start_date: Optional[date] = None  # dashboard period start
    run_id: Optional[int] = None  # specific run to query

    @property
    def effective_end_date(self) -> date:
        # Add 1 day so SQL `<= :end_date` includes the entire target_date.
        # Use this ONLY as the exclusive upper bound for `<=` over DATETIME
        # columns; for display/persistence prefer period_end_date.
        return (self.end_date or self.target_date) + timedelta(days=1)

    @property
    def period_end_date(self) -> date:
        # Inclusive end of the collection window, for display and persistence.
        return self.end_date or self.target_date

    @property
    def effective_period_start(self) -> date:
        return self.period_start_date or _subtract_days(
            self.target_date, self.lookback_days
        )


def _subtract_days(d: date, days: int) -> date:
    return d - timedelta(days=days)


def build_kb_in_clause(
    kb_ids: Optional[Sequence[int]], prefix: str = "kb"
) -> tuple[str, dict]:
    """Return (sql_fragment, params) for a KB id IN clause.

    Returns ('', {}) when kb_ids is empty or None.
    """
    if not kb_ids:
        return "", {}
    placeholders, params = [], {}
    for i, kid in enumerate(kb_ids):
        key = f"{prefix}_{i}"
        params[key] = kid
        placeholders.append(f":{key}")
    return f"IN ({', '.join(placeholders)})", params


def build_namespace_in_clause(
    namespaces: Optional[Sequence[str]], prefix: str = "ns"
) -> tuple[str, dict]:
    """Return (sql_fragment, params) for a namespace IN clause."""
    if not namespaces:
        return "", {}
    placeholders, params = [], {}
    for i, ns in enumerate(namespaces):
        key = f"{prefix}_{i}"
        params[key] = ns
        placeholders.append(f":{key}")
    return f"IN ({', '.join(placeholders)})", params

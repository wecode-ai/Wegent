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
    lookback_days: int = 30
    end_date: Optional[date] = None  # defaults to target_date
    period_start_date: Optional[date] = None  # dashboard period start
    run_id: Optional[int] = None  # specific run to query

    @property
    def effective_end_date(self) -> date:
        """Exclusive upper bound for DATETIME predicates."""
        return (self.end_date or self.target_date) + timedelta(days=1)

    @property
    def period_end_date(self) -> date:
        # Inclusive end of the collection window, for display and persistence.
        return self.end_date or self.target_date

    @property
    def effective_period_start(self) -> date:
        if self.period_start_date is not None:
            return self.period_start_date
        # An N-day inclusive window ends on period_end_date and therefore
        # starts N-1 days earlier.  Deriving both ends from the same anchor
        # prevents a caller-supplied end_date from drifting away from
        # target_date.
        days = max(1, self.lookback_days)
        return _subtract_days(self.period_end_date, days - 1)

    @property
    def period_days(self) -> int:
        return max(0, (self.period_end_date - self.effective_period_start).days + 1)


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

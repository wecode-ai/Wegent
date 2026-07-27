# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base statistics collection engine.

Provides collector registry, metric filters, runner orchestration,
and query service for KB operational statistics.
"""

from knowledge_engine.stat.runner import (
    collect_all,
    mark_kb_stat_stale_runs,
    prune_old_runs,
)

__all__ = ["collect_all", "mark_kb_stat_stale_runs", "prune_old_runs"]

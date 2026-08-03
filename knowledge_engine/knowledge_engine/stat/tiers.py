# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metric tier definitions — the single source of truth for the basic/advanced split.

``KB_STAT_ADVANCED_ENABLED=false`` (default) restricts collection and the
``/metrics/list`` response to the *basic* tier; ``true`` enables everything.
Filtering is collector-granular on the collection side (one collector may
produce several metrics, e.g. ``period_and_daily`` writes 3 tables) and
metric-granular on the query side. Both sets are kept here so runner.py and
the query service never drift apart.

A collector is basic if it produces any basic metric. dashboard is basic in
its entirety (its 3 collectors produce the totals/period/daily overview).
"""

# Basic collectors (14). When advanced is off, collect_all runs only these.
# Names match the ``name`` passed to ``@register_collector`` (which defaults
# to the function name when omitted).
BASIC_COLLECTORS: frozenset[str] = frozenset(
    {
        # dashboard (all 3 — totals / period / daily overview)
        "global_totals",
        "period_and_daily",
        "kb_daily_stats",
        # deep_analysis (kb_health_score is advanced — feeds the admin
        # platform_health_distribution trend + the health-score card)
        "kb_growth_curve",
        # doc_management (doc_upload_trend is advanced)
        "kb_avg_doc_length",
        "doc_index_failure_rate",
        # kb_lifecycle (kb_config_sanity is advanced)
        "kb_size_distribution",
        "kb_creation_trend",
        "kb_abandon_rate",
        # content_quality
        "kb_thin_doc_rate",
        "duplicate_doc_suspect",
        # retrieval
        "rag_vs_head_ratio",
        "kb_active_users",
        # sys_ops
        "storage_usage",
    }
)

# Basic metrics (15). The 3 dashboard collectors produce 4 metrics
# (global_totals / period_totals / daily_dashboard / kb_daily_stats); every
# other basic collector produces exactly 1. /metrics/list returns only these
# when advanced is off. kb_health_score / doc_upload_trend / kb_config_sanity
# are advanced (admin/detail cards moved to the advanced tier).
BASIC_METRICS: frozenset[str] = frozenset(
    {
        # dashboard (3 collectors → 4 metrics)
        "global_totals",
        "period_totals",
        "daily_dashboard",
        "kb_daily_stats",
        # deep_analysis
        "kb_growth_curve",
        # doc_management
        "kb_avg_doc_length",
        "doc_index_failure_rate",
        # kb_lifecycle
        "kb_size_distribution",
        "kb_creation_trend",
        "kb_abandon_rate",
        # content_quality
        "kb_thin_doc_rate",
        "duplicate_doc_suspect",
        # retrieval
        "rag_vs_head_ratio",
        "kb_active_users",
        # sys_ops
        "storage_usage",
    }
)

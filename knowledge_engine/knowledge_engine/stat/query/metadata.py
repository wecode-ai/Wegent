# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Metric metadata dicts + shared query helpers, extracted from query.py (P2-5 split)."""

import logging
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from typing import Any, Optional

from knowledge_engine.stat.filters import MetricFilter
from knowledge_engine.stat.metric_spec import (
    _KB_DETAIL_DOMAINS,
    _KB_DETAIL_EXCLUDED_METRICS,
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

    Lives here (not in metric_spec.py) because metric_spec.py is a codegen
    artifact — re-running gen_metric_specs.py overwrites it entirely.
    Keeping the metadata builder in query.py ensures date_col and any
    future runtime fields are never silently dropped by codegen.

    Cached: the result depends only on ``scope`` (two values: "admin"/"kb")
    and on module-level codegen constants, so it is immutable between
    deploys. Every page load calls /metrics/list; memoizing avoids
    rebuilding the domain map on each request.
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


_METRIC_TABLES: dict[str, str] = {
    # kb_lifecycle
    "kb_creation_trend": "kb_stat_kb_creation_trend",
    "kb_activity": "kb_stat_kb_activity",
    "kb_topic_distribution": "kb_stat_kb_topic_distribution",
    "kb_retrieval_config": "kb_stat_kb_retrieval_config",
    "kb_size_distribution": "kb_stat_kb_size_distribution",
    "kb_abandon_rate": "kb_stat_kb_abandon_rate",
    "kb_sharing": "kb_stat_kb_sharing",
    # dashboard
    "global_totals": "kb_stat_global_totals",
    "period_totals": "kb_stat_period_totals",
    "daily_dashboard": "kb_stat_daily_dashboard",
    # doc_management
    "doc_upload_trend": "kb_stat_doc_upload_trend",
    "doc_index_status": "kb_stat_doc_index_status",
    "doc_index_failure_rate": "kb_stat_doc_index_failure_rate",
    "doc_size_distribution": "kb_stat_doc_size_distribution",
    "doc_update_frequency": "kb_stat_doc_update_frequency",
    "doc_topic_distribution": "kb_stat_doc_topic_distribution",
    "doc_folder_depth": "kb_stat_doc_folder_depth",
    "doc_chunk_strategy": "kb_stat_doc_chunk_strategy",
    "doc_chunk_count_distribution": "kb_stat_doc_chunk_count_distribution",
    "doc_summary_status": "kb_stat_doc_summary_status",
    # retrieval
    "rag_call_frequency": "kb_stat_rag_call_frequency",
    "kb_head_frequency": "kb_stat_kb_head_frequency",
    "rag_vs_head_ratio": "kb_stat_rag_vs_head_ratio",
    "doc_reference_count": "kb_stat_doc_reference_count",
    "doc_read_count": "kb_stat_doc_read_count",
    "retrieval_mode_distribution": "kb_stat_retrieval_mode_distribution",
    "restricted_mode_usage": "kb_stat_restricted_mode_usage",
    "rag_call_limit": "kb_stat_rag_call_limit",
    "selected_documents_usage": "kb_stat_selected_documents_usage",
    "chunks_count_distribution": "kb_stat_chunks_count_distribution",
    # user_behavior
    "kb_creator_ranking": "kb_stat_kb_creator_ranking",
    "doc_uploader_ranking": "kb_stat_doc_uploader_ranking",
    "retrieval_active_user": "kb_stat_retrieval_active_user",
    "user_rag_head_preference": "kb_stat_user_rag_head_preference",
    "user_kb_binding": "kb_stat_user_kb_binding",
    "user_permission_distribution": "kb_stat_user_permission_distribution",
    "restricted_analyst_usage": "kb_stat_restricted_analyst_usage",
    "user_first_kb_usage": "kb_stat_user_first_kb_usage",
    "user_participation_summary": "kb_stat_user_participation_summary",
    # collaboration
    "kb_member_scale": "kb_stat_kb_member_scale",
    "invitation_chain": "kb_stat_invitation_chain",
    "share_link_usage": "kb_stat_share_link_usage",
    "approval_efficiency": "kb_stat_approval_efficiency",
    "cross_org_access": "kb_stat_cross_org_access",
    "permission_change_trend": "kb_stat_permission_change_trend",
    # sys_ops
    "storage_usage": "kb_stat_storage_usage",
    "attachment_storage": "kb_stat_attachment_storage",
    "doc_index_storage_view": "kb_stat_doc_index_storage_view",
    # deep_analysis
    "kb_health_score": "kb_stat_kb_health_score",
    "doc_value_ranking": "kb_stat_doc_value_ranking",
    "doc_lifecycle_trace": "kb_stat_doc_lifecycle_trace",
    "user_pattern_evolution": "kb_stat_user_pattern_evolution",
    "kb_growth_curve": "kb_stat_kb_growth_curve",
    "rag_head_verify_rate": "kb_stat_rag_head_verify_rate",
    "user_segmentation": "kb_stat_user_segmentation",
    # prometheus
    "prom_conversion_success_rate": "kb_stat_prom_conversion_success_rate",
    "prom_conversion_duration": "kb_stat_prom_conversion_duration",
    "prom_active_conversions": "kb_stat_prom_active_conversions",
    "prom_callback_success_rate": "kb_stat_prom_callback_success_rate",
    # per-KB detail metrics
    "kb_active_users": "kb_stat_kb_active_users",
    "kb_rag_head_ratio": "kb_stat_kb_rag_head_ratio",
    "kb_zero_chunk_rate": "kb_stat_kb_zero_chunk_rate",
    "kb_retrieval_mode_dist": "kb_stat_kb_retrieval_mode_dist",
    # quality metrics
    "kb_thin_doc_rate": "kb_stat_kb_thin_doc_rate",
    "doc_chunk_quality": "kb_stat_doc_chunk_quality",
    "content_freshness": "kb_stat_content_freshness",
    "kb_content_freshness": "kb_stat_kb_content_freshness",
    "duplicate_doc_suspect": "kb_stat_duplicate_doc_suspect",
    "kb_config_sanity": "kb_stat_kb_config_sanity",
    "answer_adoption_rate": "kb_stat_answer_adoption_rate",
    # P3 additions
    "kb_retrieval_hit_rate": "kb_stat_kb_retrieval_hit_rate",
    "kb_avg_doc_length": "kb_stat_kb_avg_doc_length",
    "cross_kb_query_user": "kb_stat_cross_kb_query_user",
}


_METRIC_DATE_COL: dict[str, Optional[str]] = {
    "kb_creation_trend": "stat_date",
    "kb_activity": None,
    "kb_topic_distribution": None,
    "kb_retrieval_config": None,
    "kb_size_distribution": "stat_date",
    "kb_abandon_rate": "stat_date",
    "kb_sharing": None,
    "global_totals": None,
    "period_totals": None,
    "daily_dashboard": "stat_date",
    "doc_upload_trend": "stat_date",
    "doc_index_status": None,
    "doc_index_failure_rate": "target_date",
    "doc_size_distribution": None,
    "doc_update_frequency": None,
    "doc_topic_distribution": None,
    "doc_folder_depth": None,
    "doc_chunk_strategy": None,
    "doc_chunk_count_distribution": None,
    "doc_summary_status": None,
    "rag_call_frequency": "stat_date",
    "kb_head_frequency": "stat_date",
    "rag_vs_head_ratio": "stat_date",
    "doc_reference_count": None,
    "doc_read_count": None,
    "retrieval_mode_distribution": None,
    "restricted_mode_usage": None,
    "rag_call_limit": None,
    "selected_documents_usage": None,
    "chunks_count_distribution": None,
    "kb_creator_ranking": None,
    "doc_uploader_ranking": None,
    "retrieval_active_user": None,
    "user_rag_head_preference": None,
    "user_kb_binding": None,
    "user_permission_distribution": None,
    "restricted_analyst_usage": None,
    "user_first_kb_usage": None,
    "user_participation_summary": None,
    "kb_member_scale": None,
    "invitation_chain": None,
    "share_link_usage": None,
    "approval_efficiency": None,
    "cross_org_access": None,
    "permission_change_trend": "stat_date",
    "storage_usage": "target_date",
    "attachment_storage": None,
    "doc_index_storage_view": None,
    "kb_health_score": "stat_date",
    "doc_value_ranking": None,
    "doc_lifecycle_trace": None,
    "user_pattern_evolution": None,
    "kb_growth_curve": "stat_date",
    "rag_head_verify_rate": "stat_date",
    "user_segmentation": None,
    "prom_conversion_success_rate": None,
    "prom_conversion_duration": None,
    "prom_active_conversions": None,
    "prom_callback_success_rate": None,
    # per-KB detail metrics
    "kb_active_users": None,
    "kb_rag_head_ratio": "stat_date",
    "kb_zero_chunk_rate": "stat_date",
    "kb_retrieval_mode_dist": None,
    # quality metrics
    "kb_thin_doc_rate": "stat_date",
    "doc_chunk_quality": None,
    "content_freshness": None,
    "kb_content_freshness": None,
    "duplicate_doc_suspect": None,
    "kb_config_sanity": None,
    "answer_adoption_rate": "stat_date",
    "kb_retrieval_hit_rate": "stat_date",
    "kb_avg_doc_length": None,
    "cross_kb_query_user": None,
}


_METRIC_KB_COL: dict[str, Optional[str]] = {
    "kb_creation_trend": None,
    "kb_activity": "kb_id",
    "kb_topic_distribution": None,
    "kb_retrieval_config": None,
    "kb_size_distribution": "kb_id",
    "kb_abandon_rate": None,
    "kb_sharing": "kb_id",
    "global_totals": None,
    "period_totals": None,
    "daily_dashboard": None,
    "doc_upload_trend": "kb_id",
    "doc_index_status": "kb_id",
    "doc_index_failure_rate": None,
    "doc_size_distribution": None,
    "doc_update_frequency": "kb_id",
    "doc_topic_distribution": "kb_id",
    "doc_folder_depth": "kb_id",
    "doc_chunk_strategy": None,
    "doc_chunk_count_distribution": None,
    "doc_summary_status": None,
    "rag_call_frequency": "kb_id",
    "kb_head_frequency": "kb_id",
    "rag_vs_head_ratio": None,
    "doc_reference_count": "kb_id",
    "doc_read_count": "kb_id",
    "retrieval_mode_distribution": None,
    "restricted_mode_usage": "kb_id",
    "rag_call_limit": "kb_id",
    "selected_documents_usage": "kb_id",
    "chunks_count_distribution": None,
    "kb_creator_ranking": None,
    "doc_uploader_ranking": None,
    "retrieval_active_user": None,
    "user_rag_head_preference": None,
    "user_kb_binding": "kb_id",
    "user_permission_distribution": None,
    "restricted_analyst_usage": "kb_id",
    "user_first_kb_usage": None,
    "user_participation_summary": None,
    "kb_member_scale": None,
    "invitation_chain": "kb_id",
    "share_link_usage": "kb_id",
    "approval_efficiency": "kb_id",
    "cross_org_access": "kb_id",
    "permission_change_trend": None,
    "storage_usage": "kb_id",
    "attachment_storage": None,
    "doc_index_storage_view": None,
    "kb_health_score": "kb_id",
    "doc_value_ranking": "kb_id",
    "doc_lifecycle_trace": "kb_id",
    "user_pattern_evolution": None,
    "kb_growth_curve": "kb_id",
    "rag_head_verify_rate": "kb_id",
    "user_segmentation": None,
    "prom_conversion_success_rate": None,
    "prom_conversion_duration": None,
    "prom_active_conversions": None,
    "prom_callback_success_rate": None,
    # per-KB detail metrics
    "kb_active_users": "kb_id",
    "kb_rag_head_ratio": "kb_id",
    "kb_zero_chunk_rate": "kb_id",
    "kb_retrieval_mode_dist": "kb_id",
    # quality metrics
    "kb_thin_doc_rate": "kb_id",
    "doc_chunk_quality": None,
    "content_freshness": None,
    "kb_content_freshness": "kb_id",
    "duplicate_doc_suspect": "kb_id",
    "kb_config_sanity": "kb_id",
    "answer_adoption_rate": "kb_id",
    "kb_retrieval_hit_rate": "kb_id",
    "kb_avg_doc_length": "kb_id",
    "cross_kb_query_user": None,
}


_METRIC_QUERY_OPTIONS: dict[str, dict[str, Any]] = {
    # kb_lifecycle
    "kb_creation_trend": {"order_by": "stat_date", "limit": 600},
    "kb_activity": {"order_by": "document_count DESC", "limit": 20},
    "kb_topic_distribution": {"order_by": "kb_count DESC", "limit": 20},
    "kb_retrieval_config": {"order_by": "kb_count DESC", "limit": 20},
    "kb_size_distribution": {"order_by": "stat_date", "limit": 10000},
    "kb_abandon_rate": {"order_by": "stat_date", "limit": 60},
    "kb_sharing": {"order_by": "member_count DESC", "limit": 20},
    # doc_management
    "doc_upload_trend": {"order_by": "stat_date", "limit": 20},
    "doc_index_status": {"order_by": "doc_count DESC", "limit": 20},
    "doc_index_failure_rate": {"order_by": "target_date", "limit": 60},
    "doc_size_distribution": {"order_by": "doc_count DESC", "limit": 20},
    "doc_update_frequency": {"order_by": "doc_count DESC", "limit": 20},
    "doc_topic_distribution": {"order_by": "doc_count DESC", "limit": 20},
    "doc_folder_depth": {"order_by": "folder_count DESC", "limit": 20},
    "doc_chunk_strategy": {"order_by": "doc_count DESC", "limit": 20},
    "doc_chunk_count_distribution": {"order_by": "doc_count DESC", "limit": 20},
    "doc_summary_status": {"order_by": "doc_count DESC", "limit": 20},
    # retrieval
    "rag_call_frequency": {"order_by": "stat_date", "limit": 20},
    "kb_head_frequency": {"order_by": "stat_date", "limit": 20},
    "rag_vs_head_ratio": {"order_by": "stat_date", "limit": 20},
    "doc_reference_count": {"order_by": "total_ref_count DESC", "limit": 20},
    "doc_read_count": {"order_by": "read_count DESC", "limit": 20},
    "retrieval_mode_distribution": {"order_by": "call_count DESC", "limit": 20},
    "restricted_mode_usage": {"order_by": "restricted_rate DESC", "limit": 20},
    "rag_call_limit": {"order_by": "hit_limit_count DESC", "limit": 20},
    "selected_documents_usage": {"order_by": "select_count DESC", "limit": 20},
    "chunks_count_distribution": {"order_by": "call_count DESC", "limit": 20},
    "kb_active_users": {"order_by": "total_count DESC", "limit": 20},
    "kb_rag_head_ratio": {"order_by": "stat_date", "limit": 20},
    "kb_zero_chunk_rate": {"order_by": "stat_date", "limit": 60},
    "kb_retrieval_mode_dist": {"order_by": "call_count DESC", "limit": 20},
    # user_behavior
    "kb_creator_ranking": {"order_by": "kb_count DESC", "limit": 20},
    "doc_uploader_ranking": {"order_by": "upload_count DESC", "limit": 20},
    "retrieval_active_user": {"order_by": "total_count DESC", "limit": 20},
    "user_rag_head_preference": {
        "order_by": "rag_count DESC, head_count DESC",
        "limit": 20,
    },
    "user_kb_binding": {"order_by": "task_count DESC", "limit": 20},
    "user_permission_distribution": {"order_by": "user_count DESC", "limit": 20},
    "restricted_analyst_usage": {"order_by": "analyst_count DESC", "limit": 20},
    "user_first_kb_usage": {"order_by": "days_to_first ASC", "limit": 20},
    "user_participation_summary": {"order_by": "user_id", "limit": 20},
    # collaboration
    "kb_member_scale": {"order_by": "kb_count DESC", "limit": 20},
    "invitation_chain": {"order_by": "kb_id", "limit": 20},
    "share_link_usage": {"order_by": "total_joins DESC", "limit": 20},
    "approval_efficiency": {"order_by": "approval_rate DESC", "limit": 20},
    "cross_org_access": {"order_by": "kb_id", "limit": 20},
    "permission_change_trend": {"order_by": "stat_date", "limit": 20},
    # sys_ops
    "storage_usage": {"order_by": "target_date", "limit": 10000},
    "attachment_storage": {"order_by": "total_size DESC", "limit": 20},
    "doc_index_storage_view": {"order_by": "total_file_size DESC", "limit": 20},
    # deep_analysis
    "kb_health_score": {"order_by": "stat_date", "limit": 600},
    "doc_value_ranking": {"order_by": "value_score DESC", "limit": 20},
    "doc_lifecycle_trace": {"order_by": "updated_at_doc DESC", "limit": 20},
    "user_pattern_evolution": {"order_by": "stat_month", "limit": 20},
    "kb_growth_curve": {"order_by": "stat_date", "limit": 60},
    "rag_head_verify_rate": {"order_by": "stat_date", "limit": 20},
    "user_segmentation": {"order_by": "user_count DESC", "limit": 20},
    # prometheus
    "prom_conversion_success_rate": {"order_by": "success_rate ASC", "limit": 20},
    "prom_conversion_duration": {"order_by": "p90_seconds DESC", "limit": 20},
    "prom_active_conversions": {"limit": 20},
    "prom_callback_success_rate": {"order_by": "success_rate ASC", "limit": 20},
    # quality metrics
    "kb_thin_doc_rate": {"order_by": "stat_date", "limit": 60},
    "doc_chunk_quality": {"order_by": "doc_count DESC", "limit": 20},
    "content_freshness": {"order_by": "doc_count DESC", "limit": 20},
    "kb_content_freshness": {"order_by": "fresh_rate ASC", "limit": 20},
    "duplicate_doc_suspect": {"order_by": "duplicate_rate DESC", "limit": 20},
    "kb_config_sanity": {"order_by": "kb_id", "limit": 20},
    "answer_adoption_rate": {"order_by": "stat_date", "limit": 60},
    "kb_retrieval_hit_rate": {"order_by": "stat_date", "limit": 60},
    "kb_avg_doc_length": {"order_by": "avg_doc_length ASC", "limit": 20},
    "cross_kb_query_user": {"order_by": "kb_count DESC", "limit": 20},
}


_METRIC_DOMAIN: dict[str, str] = {
    "kb_creation_trend": "kb_lifecycle",
    "kb_activity": "deep_analysis",
    "kb_topic_distribution": "kb_lifecycle",
    "kb_retrieval_config": "kb_lifecycle",
    "kb_size_distribution": "kb_lifecycle",
    "kb_abandon_rate": "kb_lifecycle",
    "kb_sharing": "collaboration",
    "global_totals": "dashboard",
    "period_totals": "dashboard",
    "daily_dashboard": "dashboard",
    "doc_upload_trend": "doc_management",
    "doc_index_status": "doc_management",
    "doc_index_failure_rate": "doc_management",
    "doc_size_distribution": "doc_management",
    "doc_update_frequency": "doc_management",
    "doc_topic_distribution": "doc_management",
    "doc_folder_depth": "doc_management",
    "doc_chunk_strategy": "doc_management",
    "doc_chunk_count_distribution": "doc_management",
    "doc_summary_status": "doc_management",
    "rag_call_frequency": "retrieval",
    "kb_head_frequency": "retrieval",
    "rag_vs_head_ratio": "retrieval",
    "doc_reference_count": "retrieval",
    "doc_read_count": "retrieval",
    "retrieval_mode_distribution": "retrieval",
    "restricted_mode_usage": "retrieval",
    "rag_call_limit": "retrieval",
    "selected_documents_usage": "retrieval",
    "chunks_count_distribution": "retrieval",
    "kb_creator_ranking": "user_behavior",
    "doc_uploader_ranking": "user_behavior",
    "retrieval_active_user": "user_behavior",
    "user_rag_head_preference": "user_behavior",
    "user_kb_binding": "user_behavior",
    "user_permission_distribution": "user_behavior",
    "restricted_analyst_usage": "user_behavior",
    "user_first_kb_usage": "user_behavior",
    "user_participation_summary": "user_behavior",
    "kb_member_scale": "collaboration",
    "invitation_chain": "collaboration",
    "share_link_usage": "collaboration",
    "approval_efficiency": "collaboration",
    "cross_org_access": "collaboration",
    "permission_change_trend": "collaboration",
    "storage_usage": "sys_ops",
    "attachment_storage": "sys_ops",
    "doc_index_storage_view": "sys_ops",
    "kb_health_score": "deep_analysis",
    "doc_value_ranking": "deep_analysis",
    "doc_lifecycle_trace": "deep_analysis",
    "user_pattern_evolution": "deep_analysis",
    "kb_growth_curve": "deep_analysis",
    "rag_head_verify_rate": "deep_analysis",
    "user_segmentation": "deep_analysis",
    "prom_conversion_success_rate": "prometheus",
    "prom_conversion_duration": "prometheus",
    "prom_active_conversions": "prometheus",
    "prom_callback_success_rate": "prometheus",
    # per-KB detail metrics
    "kb_active_users": "retrieval",
    "kb_rag_head_ratio": "retrieval",
    "kb_zero_chunk_rate": "retrieval",
    "kb_retrieval_mode_dist": "retrieval",
    # quality metrics
    "kb_thin_doc_rate": "content_quality",
    "doc_chunk_quality": "content_quality",
    "content_freshness": "content_quality",
    "kb_content_freshness": "content_quality",
    "duplicate_doc_suspect": "content_quality",
    "kb_config_sanity": "kb_lifecycle",
    "answer_adoption_rate": "retrieval",
    "kb_retrieval_hit_rate": "retrieval",
    "kb_avg_doc_length": "doc_management",
    "cross_kb_query_user": "user_behavior",
}


_METRIC_CHART_HINT: dict[str, str] = {
    "kb_creation_trend": "line",
    "kb_activity": "table",
    "kb_topic_distribution": "pie",
    "kb_retrieval_config": "table",
    "kb_size_distribution": "line",
    "kb_abandon_rate": "line",
    "kb_sharing": "table",
    "global_totals": "cards",
    "period_totals": "cards",
    "daily_dashboard": "table",
    "doc_upload_trend": "stacked_bar",
    "doc_index_status": "table",
    "doc_index_failure_rate": "line",
    "doc_size_distribution": "pie",
    "doc_update_frequency": "table",
    "doc_topic_distribution": "stacked_bar",
    "doc_folder_depth": "table",
    "doc_chunk_strategy": "table",
    "doc_chunk_count_distribution": "pie",
    "doc_summary_status": "pie",
    "rag_call_frequency": "line",
    "kb_head_frequency": "line",
    "rag_vs_head_ratio": "line",
    "doc_reference_count": "table",
    "doc_read_count": "table",
    "retrieval_mode_distribution": "pie",
    "restricted_mode_usage": "table",
    "rag_call_limit": "table",
    "selected_documents_usage": "table",
    "chunks_count_distribution": "pie",
    "kb_creator_ranking": "table",
    "doc_uploader_ranking": "table",
    "retrieval_active_user": "table",
    "user_rag_head_preference": "table",
    "user_kb_binding": "table",
    "user_permission_distribution": "pie",
    "restricted_analyst_usage": "table",
    "user_first_kb_usage": "table",
    "user_participation_summary": "table",
    "kb_member_scale": "pie",
    "invitation_chain": "table",
    "share_link_usage": "table",
    "approval_efficiency": "table",
    "cross_org_access": "table",
    "permission_change_trend": "line",
    "storage_usage": "line",
    "attachment_storage": "pie",
    "doc_index_storage_view": "table",
    "kb_health_score": "radar",
    "doc_value_ranking": "table",
    "doc_lifecycle_trace": "table",
    "user_pattern_evolution": "table",
    "kb_growth_curve": "line",
    "rag_head_verify_rate": "line",
    "user_segmentation": "pie",
    "prom_conversion_success_rate": "cards",
    "prom_conversion_duration": "cards",
    "prom_active_conversions": "cards",
    "prom_callback_success_rate": "cards",
    # per-KB detail metrics
    "kb_active_users": "table",
    "kb_rag_head_ratio": "line",
    "kb_zero_chunk_rate": "line",
    "kb_retrieval_mode_dist": "stacked_bar",
    # quality metrics
    "kb_thin_doc_rate": "line",
    "doc_chunk_quality": "pie",
    "content_freshness": "pie",
    "kb_content_freshness": "cards",
    "duplicate_doc_suspect": "table",
    "kb_config_sanity": "table",
    "answer_adoption_rate": "line",
    "kb_retrieval_hit_rate": "line",
    "kb_avg_doc_length": "cards",
    "cross_kb_query_user": "table",
}


_METRIC_DESCRIPTION: dict[str, str] = {
    "kb_creation_trend": "KB创建趋势\n统计每天新建的知识库数量及累计总量，按命名空间分组。\n计算方式: 按创建日期聚合计数，并累加计算总量。",
    "kb_activity": "KB活跃度快照\n每个知识库的文档数量、最后上传时间、最后查询时间，以及是否沉寂/不活跃。\n沉寂: 超过30天无文档上传; 不活跃: 超过90天无查询。",
    "kb_topic_distribution": "知识库主题分布 Top 20\n统计各主题标签下的知识库数量（仅展示前20）。\n计算方式: 解析知识库配置中的主题字段，按主题聚合计数。",
    "kb_retrieval_config": "KB检索配置偏好\n统计各检索模式、返回数量(top_k)、相似度阈值(score_threshold)组合的知识库数量。\n计算方式: 解析知识库配置中的检索参数，按参数组合分组计数。",
    "kb_size_distribution": "KB规模分布\n每个知识库的文档数、总文件大小、平均/最大文件大小，及规模分桶。\n分桶: 微型(<10篇), 小型(10-49篇), 中型(50-199篇), 大型(200-999篇), 超大(>=1000篇)。",
    "kb_abandon_rate": "KB废弃率\n按命名空间统计沉寂和不活跃知识库占比。\n废弃率 = 沉寂知识库数 / 总知识库数 × 100%。\n沉寂: 超过30天无文档上传; 不活跃: 超过90天无查询。",
    "kb_sharing": "KB共享程度\n每个知识库的成员数、分享链接数，及各角色(拥有者/维护者/开发者/报告者/受限分析师)人数。\n计算方式: 从成员表按知识库分组统计。",
    "global_totals": "全局总量概览\n当前所有知识库总数、文档总数、钉钉同步用户数及钉钉知识库/文档数。\n计算方式: 实时快照计数。",
    "period_and_daily": "周期汇总与每日明细\n周期内查询总量、新增知识库/文档数、RAG/Head/直注查询数；每日明细包含活跃知识库和用户数。\n计算方式: 按日期聚合统计，周期内累计求和。",
    "doc_upload_trend": "文档上传趋势\n按日期、文件类型、上传来源统计文档上传量。\n计算方式: 按文档创建日期聚合计数。",
    "doc_index_status": "文档索引状态分布\n按文件类型和索引状态(成功/失败/等待等)统计文档数。\n计算方式: 按文件类型和索引状态交叉分组计数。",
    "doc_index_failure_rate": "索引失败率\n按文件扩展名统计索引失败率。\n失败率 = 失败文档数 / 总文档数 × 100%。\n仅统计有索引记录的文档。",
    "doc_size_distribution": "文档大小分布\n按文件大小分桶统计文档数量。\n分桶: <100KB, 100KB-1MB, 1-10MB, 10-100MB, >100MB。",
    "doc_update_frequency": "文档更新频率\n按索引生成代数统计文档数，反映文档被重新索引的频次。\n代数越高说明更新越频繁。",
    "doc_topic_distribution": "文档主题分布\n按知识库统计文档主题标签分布。\n计算方式: 关联知识库配置中的主题字段与文档表。",
    "doc_folder_depth": "文档目录深度分布\n按知识库统计文档所在文件夹的目录层级深度分布。\n计算方式: 按文件路径中的分隔符计算层级深度。",
    "doc_chunk_strategy": "分块策略分布\n统计各分块器类型的文档数量分布。\n计算方式: 按分块器类型字段分组计数。",
    "doc_chunk_count_distribution": "分块数量分布\n按文档的分块数量分桶统计，反映文档被切分的粒度。\n分桶: 1块, 2-5块, 6-20块, 21-50块, 51-100块, >100块。",
    "doc_summary_status": "文档摘要状态分布\n统计文档摘要生成状态(已生成/处理中/失败等)的数量。\n计算方式: 按摘要状态字段分组计数。",
    "rag_call_frequency": "RAG调用频率\n按日期和知识库统计RAG检索调用次数。\n计算方式: 从对话上下文记录中解析RAG调用结果，按日期和知识库分组计数。",
    "kb_head_frequency": "KB Head调用频率\n按日期和知识库统计知识库头部读取调用次数。\n计算方式: 从对话上下文记录中解析Head调用结果，按日期和知识库分组计数。",
    "rag_vs_head_ratio": "RAG与Head使用比\n按日期统计RAG检索与知识库头部读取的调用比例。\n比值 = RAG调用数 / (RAG + Head) × 100%。",
    "doc_reference_count": "文档被引用排行\n前200篇文档按RAG和Head引用次数排序。\n计算方式: 从对话上下文记录中提取引用的文档ID，按文档聚合计数。",
    "doc_read_count": "文档阅读排行\n前200篇文档按Head读取次数排序。\n计算方式: 从对话上下文记录中提取Head读取的文档ID，按文档聚合计数。",
    "retrieval_mode_distribution": "检索注入模式分布\n统计各检索注入模式(RAG/Head/直注等)的调用次数占比。\n计算方式: 从对话上下文记录中按注入模式分组计数。",
    "restricted_mode_usage": "受限模式使用率\n按知识库统计受限模式调用的占比。\n使用率 = 受限调用数 / 总调用数 × 100%。",
    "rag_call_limit": "RAG调用限制命中\n按知识库统计RAG调用达到配置上限的次数。\n计算方式: 从对话上下文记录中识别结果被截断的调用。",
    "selected_documents_usage": "指定文档使用\n统计使用指定文档模式进行检索的行为次数。\n计算方式: 从对话上下文记录中识别使用了指定文档字段的调用。",
    "chunks_count_distribution": "单次检索分块数分布\n按单次RAG检索返回的分块数量分桶统计。\n分桶: 0块, 1-3块, 4-5块, 6-10块, >10块。",
    "kb_creator_ranking": "KB创建者排行\n按用户统计创建的知识库数量，降序排列。\n计算方式: 按创建者分组计数。",
    "doc_uploader_ranking": "文档上传者排行\n按用户统计上传的文档数量，降序排列。\n计算方式: 按上传者分组计数。",
    "retrieval_active_user": "检索活跃用户\n按检索调用次数对用户分级: 重度(>=50次), 中度(10-49次), 轻度(1-9次)。\n计算方式: 按用户聚合检索调用次数并分级。",
    "user_rag_head_preference": "用户RAG/Head偏好\n按用户统计RAG和Head调用次数及偏好类型。\n偏好: RAG倾向(RAG占比>70%), Head倾向(Head占比>70%), 均衡(其余)。",
    "user_kb_binding": "KB-Task绑定关系统计\n统计知识库与任务的绑定关系数量，反映知识库在任务中的使用情况。\n计算方式: 从知识库配置中解析关联的任务列表。",
    "user_permission_distribution": "用户权限分布\n按角色(拥有者/维护者/开发者/报告者/受限分析师)统计用户数。\n计算方式: 从成员表按角色分组计数。",
    "restricted_analyst_usage": "受限分析师使用\n按知识库统计受限分析师角色的用户数量。\n计算方式: 从成员表筛选受限分析师角色，按知识库分组计数。",
    "user_first_kb_usage": "首次使用KB时间\n统计用户从注册到首次使用知识库的天数分布。\n计算方式: 注册时间与首次加入知识库时间的天数差。",
    "user_participation_summary": "用户参与概览\n按参与类型(创建者/成员/查询者/未参与)统计用户数。\n同一用户可能出现在多个类型中。",
    "kb_member_scale": "KB成员规模分布\n按成员数分桶统计知识库数量。\n分桶: 单人(1), 小型(2-5人), 中型(6-15人), 大型(16-50人), 组织(>50人)。\n计算方式: 从成员表按知识库分组计数后分桶。",
    "invitation_chain": "邀请链分析\n记录知识库邀请关系: 邀请人→被邀请人及角色，最多200条。\n计算方式: 从成员表中筛选有邀请人记录的条目。",
    "share_link_usage": "分享链接使用\n按知识库统计分享链接数、总加入人数、平均每链接加入人数。\n平均加入人数 = 总加入人数 / 链接数。",
    "approval_efficiency": "审批效率\n按知识库统计审批平均耗时(分钟)、总请求数、批准数及批准率。\n批准率 = 批准数 / 总请求数 × 100%。",
    "cross_org_access": "跨组织KB访问\n查找访问多个不同组织下知识库的用户及其访问记录。\n跨组织: 同一用户出现在不同组织的知识库成员中。",
    "permission_change_trend": "权限变更趋势\n按日期统计权限变更(新增成员)的次数，按角色和状态分组。\n计算方式: 从成员表按创建日期聚合计数。",
    "storage_usage": "KB存储使用量\n按知识库估算存储使用量(活跃文档文件大小之和)。\n计算方式: 按知识库对活跃文档的文件大小求和。",
    "attachment_storage": "附件存储分布\n按存储后端(S3/本地等)统计附件数量和总大小。\n计算方式: 从附件表按存储后端分组聚合。",
    "doc_index_storage_view": "索引状态×存储交叉视图\n按文件类型和索引状态交叉统计文档数及存储量。\n计算方式: 按文件类型和索引状态二维分组聚合。",
    "kb_health_score": "KB健康评分\n加权评分: 活跃度×30% + 索引成功率×30% + 启用率×20% + 摘要率×20%。\n活跃度: 30天内有更新的文档占比; 索引成功率: 成功状态占比; 启用率: 启用文档占比; 摘要率: 有摘要文档占比。",
    "doc_value_ranking": "文档价值排行\n前200篇文档按价值评分排序。评分 = (RAG引用+Head引用) × max(独立用户数,1) × exp(-距今天数/90)。\n近期被多用户频繁引用的文档得分更高。",
    "doc_lifecycle_trace": "文档生命周期追踪\n前200篇最近更新的文档，含文件类型、索引状态、生成代数等信息。\n计算方式: 按更新时间降序排列取前200条。",
    "user_pattern_evolution": "用户行为模式演变\n按月统计每个用户的RAG/Head使用比例变化趋势。\n计算方式: 按用户和月份聚合RAG与Head调用次数，计算比例。",
    "kb_growth_curve": "KB增长曲线\n按日累计每个知识库的文档数和成员数，展示增长趋势。\n计算方式: 基于基期累计值逐日累加新增量。",
    "rag_head_verify_rate": "RAG验证率\n按日按知识库统计RAG调用中被Head验证的比例。\n验证率 = Head验证次数 / RAG调用次数 × 100%。\n即同时包含RAG和Head结果的调用占比。",
    "user_segmentation": "用户分层统计\n按活跃度分层: 创建者(创建过知识库), 活跃(查询>=10次), 普通(1-9次), 旁观(仅被添加无操作)。\n各层用户可能有重叠。",
    "prom_conversion_success_rate": "文档转换成功率\n按文件类型统计文档转换(PDF/PPTX转Markdown)的成功率。\n成功率 = 成功数 / 总数 × 100%。",
    "prom_conversion_duration": "文档转换耗时\n按文件类型统计转换耗时的P50/P90/P99估算值。\n估算方法: 基于平均耗时按经验系数推算(P50=均值×0.8, P90=均值×1.5, P99=均值×2.5)。",
    "prom_active_conversions": "当前活跃转换数\n当前处于转换中(转换中/等待转换/索引中)的文档数量。\n计算方式: 实时查询索引状态统计。",
    "prom_callback_success_rate": "7日转换回调成功率\n最近7天文档转换回调的成功率。\n成功率 = (总数-卡住数) / 总数 × 100%。\n卡住: 转换状态超过1小时未更新的文档。",
    # per-KB detail metrics
    "kb_active_users": "知识库活跃用户\n按知识库统计活跃用户及其RAG/指定文档调用次数。\n计算方式: 从对话上下文记录中按知识库和用户分组计数。",
    "kb_rag_head_ratio": "知识库RAG/指定文档使用比\n按日期和知识库统计RAG检索与指定文档读取的调用比例。\n比值 = RAG调用数 / (RAG + 指定文档) × 100%。",
    "kb_zero_chunk_rate": "知识库零分块查询率\n按知识库统计返回零分块的查询比例。\n零分块率 = 零分块查询数 / 总查询数 × 100%。\n零分块表示用户查询未匹配到任何内容。",
    "kb_retrieval_mode_dist": "知识库检索模式分布\n按知识库统计各检索注入模式(RAG/指定文档/直注等)的调用次数占比。\n计算方式: 从对话上下文记录中按知识库和注入模式分组计数。",
    # quality metrics
    "kb_thin_doc_rate": "瘦文档率\n按知识库统计瘦文档(分块数≤1)的占比。\n瘦文档率 = 瘦文档数 / 总文档数 × 100%。\n瘦文档通常表示空文件、内容过少或解析失败,占比高说明知识库存在内容债。",
    "doc_chunk_quality": "分块质量分布\n按文档的平均分块token数分桶统计。\n分桶: 过小(<100,分块太碎)、合理(100-500)、过大(>500,分块太粗)。\n过大分块说明分块器配置过粗,过小说明内容稀疏或配置过细。",
    "content_freshness": "内容新鲜度分布\n按文档距最后更新的天数分桶统计。\n分桶: ≤7天、8-30天、31-90天、91-180天、>180天。\n陈旧文档(>180天)占比高说明知识库内容长期未更新,存在信息过时风险。",
    "kb_content_freshness": "知识库内容新鲜度\n按知识库统计最近30天内有更新的文档占比。\n新鲜度 = 新鲜文档数 / 总文档数 × 100%。\n新鲜度低说明知识库内容陈旧,需要更新。",
    "duplicate_doc_suspect": "疑似重复文档\n按知识库统计疑似重复文档的占比。\n重复率 = 疑似重复文档数 / 总文档数 × 100%。\n疑似重复 = 同一知识库内文件大小和扩展名相同的文档。占比高说明存在冗余内容,建议去重。",
    "kb_config_sanity": "知识库配置合理性\n检测检索配置异常的知识库。\n检测项: score_threshold=0(不过滤)、top_k=1(几乎不检索)、top_k>10(过多)、未设置检索模式。\n配置异常会影响检索效果,建议修正。",
    "answer_adoption_rate": "回答采纳率\n按知识库统计RAG检索结果被LLM实际引用(采纳)的查询占比。\n采纳率 = 采纳查询数 / 总查询数 × 100%。\n采纳率高说明检索内容对回答有价值,低说明检索结果未被利用,需优化检索质量或内容相关性。\n注: 依赖运行时返回sources字段,数据可能稀疏。",
    "kb_retrieval_hit_rate": "知识库检索命中率\n按知识库统计RAG检索返回非零分块的查询占比。\n命中率 = 命中查询数 / 总查询数 × 100%。\n命中率 = 100 - 零分块率,是零分块率的互补指标,但方向相反(越高越好)。\n低命中率说明用户查询常常搜不到内容,需检查知识覆盖或检索配置。",
    "kb_avg_doc_length": "知识库文档平均大小\n按知识库统计文档文件大小(KB)的平均值和中位数。\n平均值过小说明存在大量空文件、解析失败或内容稀疏的文档,需要检查上传质量。\n注: 用文件大小代理内容深度,因为知识文档表未存储解析后的文本长度。",
    "cross_kb_query_user": "跨知识库查询用户\n统计在周期内查询了多个(>=2)不同知识库的用户。\n跨知识库用户多说明知识库划分可能不合理,用户需要在不同知识库之间跳转才能找到答案。\n考虑合并相关KB或优化分类。",
}


_METRIC_LABELS: dict[str, str] = {
    # kb_lifecycle
    "kb_creation_trend": "知识库创建趋势",
    "kb_activity": "知识库活跃度",
    "kb_topic_distribution": "知识库主题分布 Top 20",
    "kb_retrieval_config": "知识库检索配置",
    "kb_size_distribution": "知识库规模分布",
    "kb_abandon_rate": "知识库废弃率",
    "kb_sharing": "知识库共享程度",
    # dashboard
    "global_totals": "全局总量",
    "period_and_daily": "期间与每日明细",
    "period_totals": "期间统计",
    "daily_dashboard": "每日明细",
    # doc_management
    "doc_upload_trend": "文档上传趋势",
    "doc_index_status": "文档索引状态",
    "doc_index_failure_rate": "索引失败率",
    "doc_size_distribution": "文档大小分布",
    "doc_update_frequency": "文档更新频率",
    "doc_topic_distribution": "文档主题分布",
    "doc_folder_depth": "文档目录深度",
    "doc_chunk_strategy": "分块策略分布",
    "doc_chunk_count_distribution": "分块数量分布",
    "doc_summary_status": "文档摘要状态",
    # retrieval
    "rag_call_frequency": "RAG 调用频率",
    "kb_head_frequency": "指定文档调用频率",
    "rag_vs_head_ratio": "RAG 与指定文档使用比",
    "doc_reference_count": "文档被引用排行",
    "doc_read_count": "文档阅读排行",
    "retrieval_mode_distribution": "检索模式分布",
    "restricted_mode_usage": "受限模式使用率",
    "rag_call_limit": "RAG 调用限制命中",
    "selected_documents_usage": "指定文档使用",
    "chunks_count_distribution": "单次检索分块数分布",
    # user_behavior
    "kb_creator_ranking": "知识库创建者排行",
    "doc_uploader_ranking": "文档上传者排行",
    "retrieval_active_user": "检索活跃用户",
    "user_rag_head_preference": "用户 RAG/指定文档偏好",
    "user_kb_binding": "知识库-任务绑定",
    "user_permission_distribution": "用户权限分布",
    "restricted_analyst_usage": "受限分析师使用",
    "user_first_kb_usage": "首次使用知识库时间",
    "user_participation_summary": "用户参与概览",
    # collaboration
    "kb_member_scale": "知识库成员规模",
    "invitation_chain": "邀请链分析",
    "share_link_usage": "分享链接使用",
    "approval_efficiency": "审批效率",
    "cross_org_access": "跨组织访问",
    "permission_change_trend": "权限变更趋势",
    # sys_ops
    "storage_usage": "存储使用量",
    "attachment_storage": "附件存储分布",
    "doc_index_storage_view": "索引状态与存储视图",
    # deep_analysis
    "kb_health_score": "知识库健康评分",
    "doc_value_ranking": "文档价值排行",
    "doc_lifecycle_trace": "文档生命周期追踪",
    "user_pattern_evolution": "用户行为模式演变",
    "kb_growth_curve": "知识库增长曲线",
    "rag_head_verify_rate": "RAG 验证率",
    "user_segmentation": "用户分层统计",
    # prometheus
    "prom_conversion_success_rate": "文档转换成功率",
    "prom_conversion_duration": "文档转换耗时",
    "prom_active_conversions": "当前活跃转换数",
    "prom_callback_success_rate": "转换回调成功率",
    # per-KB detail metrics
    "kb_active_users": "知识库活跃用户",
    "kb_rag_head_ratio": "知识库RAG/指定文档使用比",
    "kb_zero_chunk_rate": "知识库零分块查询率",
    "kb_retrieval_mode_dist": "知识库检索模式分布",
    # quality metrics
    "kb_thin_doc_rate": "瘦文档率",
    "doc_chunk_quality": "分块质量分布",
    "content_freshness": "内容新鲜度分布",
    "kb_content_freshness": "知识库内容新鲜度",
    "duplicate_doc_suspect": "疑似重复文档",
    "kb_config_sanity": "知识库配置合理性",
    "answer_adoption_rate": "回答采纳率",
    "kb_retrieval_hit_rate": "知识库检索命中率",
    "kb_avg_doc_length": "知识库文档平均大小",
    "cross_kb_query_user": "跨知识库查询用户",
}


_DOMAIN_LABELS: dict[str, str] = {
    "dashboard": "总览",
    "kb_lifecycle": "知识库生命周期",
    "doc_management": "文档管理",
    "retrieval": "检索使用",
    "user_behavior": "用户行为",
    "collaboration": "协作与权限",
    "deep_analysis": "深度分析",
    "sys_ops": "系统运维",
    "prometheus": "转换监控",
    "content_quality": "内容质量",
}


_METRIC_COLLECTOR_OVERRIDES: dict[str, str] = {
    "period_totals": "period_and_daily",
    "daily_dashboard": "period_and_daily",
}


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

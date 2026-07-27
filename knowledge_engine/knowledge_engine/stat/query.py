# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Generic query service for KB statistics.

Provides read access to stat tables for both HTTP API and CLI usage.
"""

import logging
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, Sequence

from sqlalchemy import text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session, sessionmaker

from knowledge_engine.stat.filters import MetricFilter
from knowledge_engine.stat.metric_spec import (
    _DOMAIN_LABELS,
    _KB_DETAIL_DOMAINS,
    _KB_DETAIL_EXCLUDED_METRICS,
    _METRIC_SPECS,
)
from knowledge_engine.stat.registry import all_collectors

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


def build_metric_list(scope: str = "admin") -> list[dict]:
    """Build domain-grouped metric metadata list for the /metrics/list API.

    Lives here (not in metric_spec.py) because metric_spec.py is a codegen
    artifact — re-running gen_metric_specs.py overwrites it entirely.
    Keeping the metadata builder in query.py ensures date_col and any
    future runtime fields are never silently dropped by codegen.
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


# Metric name -> table mapping
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
    "knowledge_coverage": "kb_stat_knowledge_coverage",
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
    "retrieval_score_distribution": "kb_stat_retrieval_score_distribution",
    "kb_low_score_rate": "kb_stat_kb_low_score_rate",
    "kb_thin_doc_rate": "kb_stat_kb_thin_doc_rate",
    "doc_chunk_quality": "kb_stat_doc_chunk_quality",
    "content_freshness": "kb_stat_content_freshness",
    "kb_content_freshness": "kb_stat_kb_content_freshness",
    "duplicate_doc_suspect": "kb_stat_duplicate_doc_suspect",
    "kb_config_sanity": "kb_stat_kb_config_sanity",
    "answer_adoption_rate": "kb_stat_answer_adoption_rate",
    # P3 additions
    "kb_retrieval_hit_rate": "kb_stat_kb_retrieval_hit_rate",
    "query_dedup_rate": "kb_stat_query_dedup_rate",
    "kb_slow_query_rate": "kb_stat_kb_slow_query_rate",
    "kb_avg_doc_length": "kb_stat_kb_avg_doc_length",
    "cross_kb_query_user": "kb_stat_cross_kb_query_user",
}

# Metric name -> schema definition
_METRIC_SCHEMAS: dict[str, list[dict]] = {
    # kb_lifecycle
    "kb_creation_trend": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "namespace", "type": "string", "label": "命名空间"},
        {"key": "new_kb_count", "type": "int", "label": "新增数量"},
        {"key": "cumulative_kb_count", "type": "int", "label": "累计数量"},
    ],
    "kb_activity": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_namespace", "type": "string", "label": "命名空间"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "document_count", "type": "int", "label": "文档数"},
        {"key": "last_doc_uploaded_at", "type": "datetime", "label": "最后上传"},
        {"key": "last_query_at", "type": "datetime", "label": "最后查询"},
        {"key": "is_stale", "type": "int", "label": "沉寂"},
        {"key": "is_inactive", "type": "int", "label": "不活跃"},
    ],
    "kb_topic_distribution": [
        {"key": "topic", "type": "string", "label": "主题"},
        {"key": "kb_count", "type": "int", "label": "知识库数"},
    ],
    "kb_retrieval_config": [
        {"key": "retrieval_mode", "type": "string", "label": "检索模式"},
        {"key": "top_k", "type": "int", "label": "返回数量"},
        {"key": "score_threshold", "type": "float", "label": "相似度阈值"},
        {"key": "kb_count", "type": "int", "label": "知识库数"},
    ],
    "kb_size_distribution": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "namespace", "type": "string", "label": "命名空间"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
        {"key": "total_file_size", "type": "int", "label": "总大小"},
        {"key": "avg_file_size", "type": "int", "label": "平均大小"},
        {"key": "max_file_size", "type": "int", "label": "最大大小"},
        {"key": "size_bucket", "type": "string", "label": "规模区间"},
    ],
    "kb_abandon_rate": [
        {"key": "namespace", "type": "string", "label": "命名空间"},
        {"key": "total_kb_count", "type": "int", "label": "总知识库数"},
        {"key": "stale_kb_count", "type": "int", "label": "沉寂数"},
        {"key": "inactive_kb_count", "type": "int", "label": "不活跃数"},
        {"key": "abandon_rate", "type": "float", "label": "废弃率 %"},
    ],
    "kb_sharing": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "member_count", "type": "int", "label": "成员数"},
        {"key": "share_link_count", "type": "int", "label": "分享链接数"},
        {"key": "owner_count", "type": "int", "label": "拥有者"},
        {"key": "maintainer_count", "type": "int", "label": "维护者"},
        {"key": "developer_count", "type": "int", "label": "开发者"},
        {"key": "reporter_count", "type": "int", "label": "报告者"},
        {"key": "restricted_analyst_count", "type": "int", "label": "受限分析师"},
    ],
    # dashboard
    "global_totals": [
        {"key": "total_kb_count", "type": "int", "label": "总知识库数"},
        {"key": "total_doc_count", "type": "int", "label": "总文档数"},
        {"key": "dingtalk_synced_user_count", "type": "int", "label": "钉钉同步用户"},
        {"key": "dingtalk_kb_count", "type": "int", "label": "钉钉知识库数"},
        {"key": "dingtalk_doc_count", "type": "int", "label": "钉钉文档数"},
    ],
    "period_totals": [
        {"key": "start_date", "type": "date", "label": "起始日期"},
        {"key": "end_date", "type": "date", "label": "结束日期"},
        {"key": "period_total_queries", "type": "int", "label": "总查询量"},
        {"key": "period_new_kb", "type": "int", "label": "新增知识库"},
        {"key": "period_new_docs", "type": "int", "label": "新增文档"},
        {"key": "period_rag_queries", "type": "int", "label": "RAG查询"},
        {"key": "period_direct_inject", "type": "int", "label": "直接注入"},
        {"key": "period_kb_head_queries", "type": "int", "label": "指定文档查询"},
    ],
    "daily_dashboard": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "total_queries", "type": "int", "label": "总查询量"},
        {"key": "rag_queries", "type": "int", "label": "RAG查询"},
        {"key": "direct_injection", "type": "int", "label": "直接注入"},
        {"key": "kb_head_rag_queries", "type": "int", "label": "指定文档RAG"},
        {"key": "kb_head_queries", "type": "int", "label": "指定文档"},
        {"key": "active_kb_count", "type": "int", "label": "活跃知识库"},
        {"key": "active_user_count", "type": "int", "label": "活跃用户"},
        {"key": "new_kb_count", "type": "int", "label": "新增知识库"},
        {"key": "new_doc_count", "type": "int", "label": "新增文档"},
        {"key": "dingtalk_active_user_count", "type": "int", "label": "钉钉活跃用户"},
    ],
    # doc_management
    "doc_upload_trend": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "source_type", "type": "string", "label": "来源"},
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "upload_count", "type": "int", "label": "上传数量"},
    ],
    "doc_index_status": [
        {"key": "index_status", "type": "string", "label": "索引状态"},
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "doc_index_failure_rate": [
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "total_count", "type": "int", "label": "总数"},
        {"key": "failed_count", "type": "int", "label": "失败数"},
        {"key": "failure_rate", "type": "float", "label": "失败率 %"},
    ],
    "doc_size_distribution": [
        {"key": "size_bucket", "type": "string", "label": "大小区间"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
        {"key": "total_size", "type": "int", "label": "总大小"},
    ],
    "doc_update_frequency": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "index_generation", "type": "int", "label": "索引代数"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "doc_topic_distribution": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "topic", "type": "string", "label": "主题"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "doc_folder_depth": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "depth", "type": "int", "label": "深度"},
        {"key": "folder_count", "type": "int", "label": "文件夹数"},
    ],
    "doc_chunk_strategy": [
        {"key": "splitter_type", "type": "string", "label": "分块器类型"},
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "doc_chunk_count_distribution": [
        {"key": "chunk_bucket", "type": "string", "label": "分块数区间"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "doc_summary_status": [
        {"key": "summary_status", "type": "string", "label": "摘要状态"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    # retrieval
    "rag_call_frequency": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "call_count", "type": "int", "label": "调用次数"},
    ],
    "kb_head_frequency": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "call_count", "type": "int", "label": "调用次数"},
    ],
    "rag_vs_head_ratio": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "rag_count", "type": "int", "label": "RAG次数"},
        {"key": "head_count", "type": "int", "label": "指定文档次数"},
        {"key": "rag_ratio", "type": "float", "label": "RAG占比 %"},
    ],
    "doc_reference_count": [
        {"key": "document_id", "type": "int", "label": "文档ID"},
        {"key": "document_name", "type": "string", "label": "文档名称"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "rag_ref_count", "type": "int", "label": "RAG引用"},
        {"key": "head_ref_count", "type": "int", "label": "指定文档引用"},
        {"key": "total_ref_count", "type": "int", "label": "总引用"},
    ],
    "doc_read_count": [
        {"key": "document_id", "type": "int", "label": "文档ID"},
        {"key": "document_name", "type": "string", "label": "文档名称"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "read_count", "type": "int", "label": "阅读次数"},
    ],
    "retrieval_mode_distribution": [
        {"key": "injection_mode", "type": "string", "label": "注入模式"},
        {"key": "call_count", "type": "int", "label": "调用次数"},
    ],
    "restricted_mode_usage": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_calls", "type": "int", "label": "总调用"},
        {"key": "restricted_calls", "type": "int", "label": "受限调用"},
        {"key": "restricted_rate", "type": "float", "label": "受限率 %"},
    ],
    "rag_call_limit": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "max_calls_config", "type": "int", "label": "调用上限"},
        {"key": "hit_limit_count", "type": "int", "label": "命中上限次数"},
    ],
    "selected_documents_usage": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "document_id", "type": "int", "label": "文档ID"},
        {"key": "select_count", "type": "int", "label": "指定次数"},
    ],
    "chunks_count_distribution": [
        {"key": "chunk_bucket", "type": "string", "label": "分块数区间"},
        {"key": "call_count", "type": "int", "label": "调用次数"},
    ],
    # user_behavior
    "kb_creator_ranking": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "kb_count", "type": "int", "label": "创建数"},
    ],
    "doc_uploader_ranking": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "upload_count", "type": "int", "label": "上传数"},
    ],
    "retrieval_active_user": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "rag_count", "type": "int", "label": "RAG次数"},
        {"key": "head_count", "type": "int", "label": "指定文档次数"},
        {"key": "total_count", "type": "int", "label": "总次数"},
        {"key": "user_tier", "type": "string", "label": "活跃等级"},
    ],
    "user_rag_head_preference": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "rag_count", "type": "int", "label": "RAG次数"},
        {"key": "head_count", "type": "int", "label": "指定文档次数"},
        {"key": "preference", "type": "string", "label": "偏好类型"},
    ],
    "user_kb_binding": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "task_count", "type": "int", "label": "任务数"},
    ],
    "user_permission_distribution": [
        {"key": "role", "type": "string", "label": "角色"},
        {"key": "user_count", "type": "int", "label": "用户数"},
    ],
    "restricted_analyst_usage": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "analyst_count", "type": "int", "label": "分析师数"},
    ],
    "user_first_kb_usage": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "registered_at", "type": "datetime", "label": "注册时间"},
        {"key": "first_kb_usage_at", "type": "datetime", "label": "首次使用时间"},
        {"key": "days_to_first", "type": "float", "label": "间隔天数"},
    ],
    "user_participation_summary": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "is_creator", "type": "int", "label": "创建者"},
        {"key": "is_uploader", "type": "int", "label": "上传者"},
        {"key": "is_retriever", "type": "int", "label": "检索者"},
        {"key": "is_member", "type": "int", "label": "成员"},
        {"key": "participation_type", "type": "string", "label": "参与类型"},
    ],
    # collaboration
    "kb_member_scale": [
        {"key": "scale_bucket", "type": "string", "label": "规模"},
        {"key": "kb_count", "type": "int", "label": "知识库数"},
    ],
    "invitation_chain": [
        {"key": "inviter_id", "type": "int", "label": "邀请人ID"},
        {"key": "inviter_name", "type": "string", "label": "邀请人"},
        {"key": "invitee_id", "type": "int", "label": "被邀请人ID"},
        {"key": "invitee_name", "type": "string", "label": "被邀请人"},
        {"key": "role", "type": "string", "label": "角色"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
    ],
    "share_link_usage": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "link_count", "type": "int", "label": "链接数"},
        {"key": "total_joins", "type": "int", "label": "总加入数"},
        {"key": "avg_joins_per_link", "type": "float", "label": "平均加入/链接"},
    ],
    "approval_efficiency": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "avg_approval_minutes", "type": "float", "label": "平均审批时长(分)"},
        {"key": "total_requests", "type": "int", "label": "总请求数"},
        {"key": "approved_count", "type": "int", "label": "批准数"},
        {"key": "approval_rate", "type": "float", "label": "批准率 %"},
    ],
    "cross_org_access": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_namespace", "type": "string", "label": "知识库命名空间"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_namespace", "type": "string", "label": "用户命名空间"},
        {"key": "role", "type": "string", "label": "角色"},
    ],
    "permission_change_trend": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "role", "type": "string", "label": "角色"},
        {"key": "status", "type": "string", "label": "状态"},
        {"key": "change_count", "type": "int", "label": "变更次数"},
    ],
    # sys_ops
    "storage_usage": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "namespace", "type": "string", "label": "命名空间"},
        {"key": "total_file_size", "type": "int", "label": "总大小"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "attachment_storage": [
        {"key": "storage_backend", "type": "string", "label": "存储后端"},
        {"key": "file_count", "type": "int", "label": "文件数"},
        {"key": "total_size", "type": "int", "label": "总大小"},
    ],
    "doc_index_storage_view": [
        {"key": "index_status", "type": "string", "label": "索引状态"},
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
        {"key": "total_file_size", "type": "int", "label": "总大小"},
        {"key": "avg_file_size", "type": "int", "label": "平均大小"},
    ],
    # deep_analysis
    "kb_health_score": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "namespace", "type": "string", "label": "命名空间"},
        {"key": "activity_score", "type": "float", "label": "活跃度得分"},
        {"key": "index_success_score", "type": "float", "label": "索引得分"},
        {"key": "enable_score", "type": "float", "label": "启用得分"},
        {"key": "summary_score", "type": "float", "label": "摘要得分"},
        {"key": "health_score", "type": "float", "label": "健康评分"},
    ],
    "doc_value_ranking": [
        {"key": "document_id", "type": "int", "label": "文档ID"},
        {"key": "document_name", "type": "string", "label": "文档名称"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "rag_ref_count", "type": "int", "label": "RAG引用"},
        {"key": "head_ref_count", "type": "int", "label": "指定文档引用"},
        {"key": "unique_users", "type": "int", "label": "独立用户数"},
        {"key": "days_since_update", "type": "int", "label": "距更新天数"},
        {"key": "value_score", "type": "float", "label": "价值评分"},
    ],
    "doc_lifecycle_trace": [
        {"key": "document_id", "type": "int", "label": "文档ID"},
        {"key": "document_name", "type": "string", "label": "文档名称"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "index_status", "type": "string", "label": "索引状态"},
        {"key": "index_generation", "type": "int", "label": "索引代数"},
        {"key": "file_size", "type": "int", "label": "文件大小"},
        {"key": "created_at_doc", "type": "datetime", "label": "创建时间"},
        {"key": "updated_at_doc", "type": "datetime", "label": "更新时间"},
    ],
    "user_pattern_evolution": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "stat_month", "type": "string", "label": "月份"},
        {"key": "rag_count", "type": "int", "label": "RAG次数"},
        {"key": "head_count", "type": "int", "label": "指定文档次数"},
        {"key": "rag_ratio", "type": "float", "label": "RAG占比 %"},
    ],
    "kb_growth_curve": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "cumulative_docs", "type": "int", "label": "累计文档数"},
        {"key": "cumulative_members", "type": "int", "label": "累计成员数"},
    ],
    "rag_head_verify_rate": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_rag_calls", "type": "int", "label": "总RAG调用"},
        {"key": "verified_by_head", "type": "int", "label": "已验证数"},
        {"key": "verify_rate", "type": "float", "label": "验证率 %"},
    ],
    "knowledge_coverage": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "topic", "type": "string", "label": "主题"},
        {"key": "query_text", "type": "string", "label": "查询文本"},
        {"key": "match_type", "type": "string", "label": "匹配类型"},
    ],
    "user_segmentation": [
        {"key": "segment", "type": "string", "label": "用户分层"},
        {"key": "user_count", "type": "int", "label": "用户数"},
    ],
    # prometheus
    "prom_conversion_success_rate": [
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "success_rate", "type": "float", "label": "成功率 %"},
        {"key": "total_count", "type": "int", "label": "总数"},
        {"key": "success_count", "type": "int", "label": "成功数"},
    ],
    "prom_conversion_duration": [
        {"key": "file_extension", "type": "string", "label": "文件类型"},
        {"key": "p50_seconds", "type": "float", "label": "P50(秒)"},
        {"key": "p90_seconds", "type": "float", "label": "P90(秒)"},
        {"key": "p99_seconds", "type": "float", "label": "P99(秒)"},
    ],
    "prom_active_conversions": [
        {"key": "active_count", "type": "int", "label": "活跃转换数"},
    ],
    "prom_callback_success_rate": [
        {"key": "callback_type", "type": "string", "label": "回调类型"},
        {"key": "total_count", "type": "int", "label": "总数"},
        {"key": "success_count", "type": "int", "label": "成功数"},
        {"key": "success_rate", "type": "float", "label": "成功率 %"},
    ],
    # per-KB detail metrics
    "kb_active_users": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "rag_count", "type": "int", "label": "RAG次数"},
        {"key": "head_count", "type": "int", "label": "指定文档次数"},
        {"key": "total_count", "type": "int", "label": "总次数"},
    ],
    "kb_rag_head_ratio": [
        {"key": "stat_date", "type": "date", "label": "日期"},
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "rag_count", "type": "int", "label": "RAG次数"},
        {"key": "head_count", "type": "int", "label": "指定文档次数"},
        {"key": "rag_ratio", "type": "float", "label": "RAG占比 %"},
    ],
    "kb_zero_chunk_rate": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_queries", "type": "int", "label": "总查询数"},
        {"key": "zero_chunk_queries", "type": "int", "label": "零分块查询数"},
        {"key": "zero_chunk_rate", "type": "float", "label": "零分块率 %"},
    ],
    "kb_retrieval_mode_dist": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "injection_mode", "type": "string", "label": "注入模式"},
        {"key": "call_count", "type": "int", "label": "调用次数"},
    ],
    # quality metrics
    "retrieval_score_distribution": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_samples", "type": "int", "label": "样本数"},
        {"key": "avg_score", "type": "float", "label": "平均分"},
        {"key": "p50_score", "type": "float", "label": "P50"},
        {"key": "p90_score", "type": "float", "label": "P90"},
        {"key": "score_threshold", "type": "float", "label": "阈值"},
        {"key": "low_score_rate", "type": "float", "label": "低分率 %"},
    ],
    "kb_low_score_rate": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_queries", "type": "int", "label": "总查询数"},
        {"key": "low_score_queries", "type": "int", "label": "低分查询数"},
        {"key": "low_score_rate", "type": "float", "label": "低分率 %"},
    ],
    "kb_thin_doc_rate": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_docs", "type": "int", "label": "总文档数"},
        {"key": "thin_docs", "type": "int", "label": "瘦文档数"},
        {"key": "thin_doc_rate", "type": "float", "label": "瘦文档率 %"},
    ],
    "doc_chunk_quality": [
        {"key": "chunk_quality_bucket", "type": "string", "label": "分块质量区间"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "content_freshness": [
        {"key": "freshness_bucket", "type": "string", "label": "新鲜度区间"},
        {"key": "doc_count", "type": "int", "label": "文档数"},
    ],
    "kb_content_freshness": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_docs", "type": "int", "label": "总文档数"},
        {"key": "fresh_docs", "type": "int", "label": "新鲜文档数"},
        {"key": "fresh_rate", "type": "float", "label": "新鲜度 %"},
    ],
    "duplicate_doc_suspect": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_docs", "type": "int", "label": "总文档数"},
        {"key": "duplicate_docs", "type": "int", "label": "疑似重复文档数"},
        {"key": "duplicate_rate", "type": "float", "label": "重复率 %"},
    ],
    "kb_config_sanity": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "kb_name", "type": "string", "label": "知识库名称"},
        {"key": "issue_type", "type": "string", "label": "问题类型"},
        {"key": "issue_detail", "type": "string", "label": "问题描述"},
        {"key": "config_value", "type": "string", "label": "配置值"},
    ],
    "answer_adoption_rate": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_queries", "type": "int", "label": "总查询数"},
        {"key": "adopted_queries", "type": "int", "label": "采纳查询数"},
        {"key": "adoption_rate", "type": "float", "label": "采纳率 %"},
    ],
    # P3 additions
    "kb_retrieval_hit_rate": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_queries", "type": "int", "label": "总查询数"},
        {"key": "hit_queries", "type": "int", "label": "命中查询数"},
        {"key": "hit_rate", "type": "float", "label": "命中率 %"},
    ],
    "query_dedup_rate": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_queries", "type": "int", "label": "总查询数"},
        {"key": "unique_queries", "type": "int", "label": "唯一查询数"},
        {"key": "dedup_rate", "type": "float", "label": "去重率 %"},
    ],
    "kb_slow_query_rate": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_queries", "type": "int", "label": "总查询数"},
        {"key": "slow_queries", "type": "int", "label": "慢查询数"},
        {"key": "p95_latency_ms", "type": "float", "label": "P95延迟(ms)"},
        {"key": "slow_rate", "type": "float", "label": "慢查询率 %"},
    ],
    "kb_avg_doc_length": [
        {"key": "kb_id", "type": "int", "label": "知识库ID"},
        {"key": "total_docs", "type": "int", "label": "文档数"},
        {"key": "avg_doc_length", "type": "float", "label": "平均大小(KB)"},
        {"key": "median_doc_length", "type": "float", "label": "中位数大小(KB)"},
    ],
    "cross_kb_query_user": [
        {"key": "user_id", "type": "int", "label": "用户ID"},
        {"key": "user_name", "type": "string", "label": "用户名"},
        {"key": "kb_count", "type": "int", "label": "访问KB数"},
        {"key": "query_count", "type": "int", "label": "查询次数"},
    ],
}

# Date column per metric table (None = cross-section, no date filter)
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
    "knowledge_coverage": None,
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
    "retrieval_score_distribution": "stat_date",
    "kb_low_score_rate": "stat_date",
    "kb_thin_doc_rate": "stat_date",
    "doc_chunk_quality": None,
    "content_freshness": None,
    "kb_content_freshness": None,
    "duplicate_doc_suspect": None,
    "kb_config_sanity": None,
    "answer_adoption_rate": "stat_date",
    "kb_retrieval_hit_rate": "stat_date",
    "query_dedup_rate": "stat_date",
    "kb_slow_query_rate": None,
    "kb_avg_doc_length": None,
    "cross_kb_query_user": None,
}

# KB filter column per metric table
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
    "knowledge_coverage": "kb_id",
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
    "retrieval_score_distribution": "kb_id",
    "kb_low_score_rate": "kb_id",
    "kb_thin_doc_rate": "kb_id",
    "doc_chunk_quality": None,
    "content_freshness": None,
    "kb_content_freshness": "kb_id",
    "duplicate_doc_suspect": "kb_id",
    "kb_config_sanity": "kb_id",
    "answer_adoption_rate": "kb_id",
    "kb_retrieval_hit_rate": "kb_id",
    "query_dedup_rate": "kb_id",
    "kb_slow_query_rate": "kb_id",
    "kb_avg_doc_length": "kb_id",
    "cross_kb_query_user": None,
}

# Query options: order_by and limit for specific metrics
# All table-type metrics use LIMIT 20 to keep frontend tables concise.
_METRIC_QUERY_OPTIONS: dict[str, dict[str, Any]] = {
    # kb_lifecycle
    "kb_creation_trend": {"order_by": "stat_date", "limit": 20},
    "kb_activity": {"order_by": "document_count DESC", "limit": 20},
    "kb_topic_distribution": {"order_by": "kb_count DESC", "limit": 20},
    "kb_retrieval_config": {"order_by": "kb_count DESC", "limit": 20},
    "kb_size_distribution": {"order_by": "stat_date", "limit": 60},
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
    "storage_usage": {"order_by": "target_date", "limit": 60},
    "attachment_storage": {"order_by": "total_size DESC", "limit": 20},
    "doc_index_storage_view": {"order_by": "total_file_size DESC", "limit": 20},
    # deep_analysis
    "kb_health_score": {"order_by": "stat_date", "limit": 600},
    "doc_value_ranking": {"order_by": "value_score DESC", "limit": 20},
    "doc_lifecycle_trace": {"order_by": "updated_at_doc DESC", "limit": 20},
    "user_pattern_evolution": {"order_by": "stat_month", "limit": 20},
    "kb_growth_curve": {"order_by": "stat_date", "limit": 20},
    "rag_head_verify_rate": {"order_by": "stat_date", "limit": 20},
    "knowledge_coverage": {"order_by": "kb_id", "limit": 20},
    "user_segmentation": {"order_by": "user_count DESC", "limit": 20},
    # prometheus
    "prom_conversion_success_rate": {"order_by": "success_rate ASC", "limit": 20},
    "prom_conversion_duration": {"order_by": "p90_seconds DESC", "limit": 20},
    "prom_active_conversions": {"limit": 20},
    "prom_callback_success_rate": {"order_by": "success_rate ASC", "limit": 20},
    # quality metrics
    "retrieval_score_distribution": {"order_by": "stat_date", "limit": 60},
    "kb_low_score_rate": {"order_by": "stat_date", "limit": 60},
    "kb_thin_doc_rate": {"order_by": "stat_date", "limit": 60},
    "doc_chunk_quality": {"order_by": "doc_count DESC", "limit": 20},
    "content_freshness": {"order_by": "doc_count DESC", "limit": 20},
    "kb_content_freshness": {"order_by": "fresh_rate ASC", "limit": 20},
    "duplicate_doc_suspect": {"order_by": "duplicate_rate DESC", "limit": 20},
    "kb_config_sanity": {"order_by": "kb_id", "limit": 20},
    "answer_adoption_rate": {"order_by": "stat_date", "limit": 60},
    "kb_retrieval_hit_rate": {"order_by": "stat_date", "limit": 60},
    "query_dedup_rate": {"order_by": "stat_date", "limit": 60},
    "kb_slow_query_rate": {"order_by": "slow_rate DESC", "limit": 20},
    "kb_avg_doc_length": {"order_by": "avg_doc_length ASC", "limit": 20},
    "cross_kb_query_user": {"order_by": "kb_count DESC", "limit": 20},
}

# Domain grouping for metric list API
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
    "knowledge_coverage": "deep_analysis",
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
    "retrieval_score_distribution": "retrieval",
    "kb_low_score_rate": "retrieval",
    "kb_thin_doc_rate": "content_quality",
    "doc_chunk_quality": "content_quality",
    "content_freshness": "content_quality",
    "kb_content_freshness": "content_quality",
    "duplicate_doc_suspect": "content_quality",
    "kb_config_sanity": "kb_lifecycle",
    "answer_adoption_rate": "retrieval",
    "kb_retrieval_hit_rate": "retrieval",
    "query_dedup_rate": "retrieval",
    "kb_slow_query_rate": "retrieval",
    "kb_avg_doc_length": "doc_management",
    "cross_kb_query_user": "user_behavior",
}

# Chart hint for metric list API
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
    "knowledge_coverage": "table",
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
    "retrieval_score_distribution": "line",
    "kb_low_score_rate": "line",
    "kb_thin_doc_rate": "line",
    "doc_chunk_quality": "pie",
    "content_freshness": "pie",
    "kb_content_freshness": "cards",
    "duplicate_doc_suspect": "table",
    "kb_config_sanity": "table",
    "answer_adoption_rate": "line",
    "kb_retrieval_hit_rate": "line",
    "query_dedup_rate": "line",
    "kb_slow_query_rate": "cards",
    "kb_avg_doc_length": "cards",
    "cross_kb_query_user": "table",
}

# Description for metric list API
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
    "knowledge_coverage": "知识覆盖度分析\n对比知识库主题标签与用户查询文本的匹配情况(精确匹配/部分匹配/无匹配)。\n计算方式: 逐条对比主题词与查询文本的包含关系。",
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
    "retrieval_score_distribution": "检索相关性分数分布\n按知识库统计RAG检索返回分块的相关性分数分布(平均分/P50/P90)及低分率。\n低分 = 分块相关性分数低于知识库配置的score_threshold。\n计算方式: 解析subtask_contexts中rag_retrieval记录的extracted_text,提取每个分块的score。",
    "kb_low_score_rate": "知识库低相关检索率\n按知识库统计平均相关性分数低于阈值的查询占比。\n低分率 = 低分查询数 / 总查询数 × 100%。\n反映知识库内容与用户查询的匹配质量,低分率高说明检索结果大多不相关。",
    "kb_thin_doc_rate": "瘦文档率\n按知识库统计瘦文档(分块数≤1)的占比。\n瘦文档率 = 瘦文档数 / 总文档数 × 100%。\n瘦文档通常表示空文件、内容过少或解析失败,占比高说明知识库存在内容债。",
    "doc_chunk_quality": "分块质量分布\n按文档的平均分块token数分桶统计。\n分桶: 过小(<100,分块太碎)、合理(100-500)、过大(>500,分块太粗)。\n过大分块说明分块器配置过粗,过小说明内容稀疏或配置过细。",
    "content_freshness": "内容新鲜度分布\n按文档距最后更新的天数分桶统计。\n分桶: ≤7天、8-30天、31-90天、91-180天、>180天。\n陈旧文档(>180天)占比高说明知识库内容长期未更新,存在信息过时风险。",
    "kb_content_freshness": "知识库内容新鲜度\n按知识库统计最近30天内有更新的文档占比。\n新鲜度 = 新鲜文档数 / 总文档数 × 100%。\n新鲜度低说明知识库内容陈旧,需要更新。",
    "duplicate_doc_suspect": "疑似重复文档\n按知识库统计疑似重复文档的占比。\n重复率 = 疑似重复文档数 / 总文档数 × 100%。\n疑似重复 = 同一知识库内文件大小和扩展名相同的文档。占比高说明存在冗余内容,建议去重。",
    "kb_config_sanity": "知识库配置合理性\n检测检索配置异常的知识库。\n检测项: score_threshold=0(不过滤)、top_k=1(几乎不检索)、top_k>10(过多)、未设置检索模式。\n配置异常会影响检索效果,建议修正。",
    "answer_adoption_rate": "回答采纳率\n按知识库统计RAG检索结果被LLM实际引用(采纳)的查询占比。\n采纳率 = 采纳查询数 / 总查询数 × 100%。\n采纳率高说明检索内容对回答有价值,低说明检索结果未被利用,需优化检索质量或内容相关性。\n注: 依赖运行时返回sources字段,数据可能稀疏。",
    "kb_retrieval_hit_rate": "知识库检索命中率\n按知识库统计RAG检索返回非零分块的查询占比。\n命中率 = 命中查询数 / 总查询数 × 100%。\n命中率 = 100 - 零分块率,是零分块率的互补指标,但方向相反(越高越好)。\n低命中率说明用户查询常常搜不到内容,需检查知识覆盖或检索配置。",
    "query_dedup_rate": "查询去重率\n按知识库统计用户查询的去重比例。\n去重率 = 唯一查询数 / 总查询数 × 100%。\n低去重率意味着用户大量重复相似查询,说明知识库未能首次就给出满意答案,用户在反复尝试。可能是检索质量或内容覆盖问题。",
    "kb_slow_query_rate": "知识库慢查询率\n按知识库统计RAG检索延迟超过该KBP95的查询占比。\n慢查询率 = 慢查询数 / 总查询数 × 100%。\nP95延迟从rag_result.latency_ms聚合计算。\n慢查询率高(或P95绝对值大)说明索引性能或向量库规模需要优化。",
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
    "knowledge_coverage": "知识覆盖度分析",
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
    "retrieval_score_distribution": "检索相关性分数分布",
    "kb_low_score_rate": "知识库低相关检索率",
    "kb_thin_doc_rate": "瘦文档率",
    "doc_chunk_quality": "分块质量分布",
    "content_freshness": "内容新鲜度分布",
    "kb_content_freshness": "知识库内容新鲜度",
    "duplicate_doc_suspect": "疑似重复文档",
    "kb_config_sanity": "知识库配置合理性",
    "answer_adoption_rate": "回答采纳率",
    "kb_retrieval_hit_rate": "知识库检索命中率",
    "query_dedup_rate": "查询去重率",
    "kb_slow_query_rate": "知识库慢查询率",
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
}

_METRIC_IMPORTS_DONE = False


_METRIC_COLLECTOR_OVERRIDES: dict[str, str] = {
    "period_totals": "period_and_daily",
    "daily_dashboard": "period_and_daily",
    "kb_low_score_rate": "retrieval_score_distribution",
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


def _ensure_imports() -> None:
    """Lazily import collector modules to ensure registry is populated."""
    global _METRIC_IMPORTS_DONE
    if _METRIC_IMPORTS_DONE:
        return
    import knowledge_engine.stat.collectors  # noqa: F401

    _METRIC_IMPORTS_DONE = True


class KbStatQueryService:
    """Generic read service for KB stat data."""

    def __init__(self, *, stat_session_factory: sessionmaker):
        self._stat_session_factory = stat_session_factory

    def _get_session(self) -> Session:
        return self._stat_session_factory()

    def _latest_run(
        self,
        session: Session,
        *,
        collector_name: Optional[str] = None,
        kb_ids: Optional[Sequence[int]] = None,
    ) -> Optional[dict]:
        """Return the latest successful run applicable to the requested scope."""
        conditions = ["r.status IN ('completed', 'partial')"]
        params: dict[str, Any] = {}
        join = ""
        if collector_name:
            join = (
                "JOIN kb_stat_collector_runs c ON c.run_id = r.id "
                "AND c.collector_name = :collector_name AND c.status = 'success' "
            )
            params["collector_name"] = collector_name
        if kb_ids:
            placeholders = []
            for index, kb_id in enumerate(kb_ids):
                key = f"scope_kb_{index}"
                placeholders.append(f":{key}")
                params[key] = kb_id
            requested_scope = ", ".join(placeholders)
            conditions.append(
                "(r.kb_filter IS NULL OR "
                f"JSON_CONTAINS(r.kb_filter, JSON_ARRAY({requested_scope})))"
            )
        else:
            # Platform-wide queries must never use a single-KB collection.
            conditions.append("r.kb_filter IS NULL")

        row = session.execute(
            text(
                "SELECT r.id, r.completed_at, r.status FROM kb_stat_runs r "
                f"{join}WHERE {' AND '.join(conditions)} "
                "ORDER BY r.id DESC LIMIT 1"
            ),
            params,
        ).fetchone()
        if not row:
            return None
        return {"id": row.id, "completed_at": row.completed_at, "status": row.status}

    def fetch_metric(self, name: str, filter: MetricFilter) -> dict:
        """Fetch a single metric by name with filter."""
        spec = _METRIC_SPECS.get(name)
        if spec is None:
            raise KeyError(f"unknown metric: {name}")

        session = self._get_session()
        try:
            run_id, run_completed_at = self._resolve_run(
                session, filter, metric_name=name
            )
            return self._fetch_one(
                session, name, spec, filter, run_id, run_completed_at
            )
        except (ProgrammingError, OperationalError) as e:
            logger.warning(
                "Stat table query failed (table/column may not exist yet): %s", e
            )
            return {
                "metric_name": name,
                "run_id": None,
                "run_completed_at": None,
                "schema": [asdict(c) for c in spec.schema],
                "rows": [],
            }
        finally:
            session.close()

    def fetch_metrics_batch(self, names: Sequence[str], filter: MetricFilter) -> dict:
        """Fetch multiple metrics in one session.

        Resolves the latest run once and reuses it for every metric, so a
        batch of N metrics costs one run-resolution + one session instead of
        N. Unknown metric names are returned as empty results rather than
        raising, so one bad name does not poison the whole batch.
        """
        results: dict[str, dict] = {}
        session = self._get_session()
        try:
            run_cache: dict[
                tuple[Optional[str], tuple[int, ...]],
                tuple[Optional[int], Optional[datetime]],
            ] = {}
            for name in names:
                spec = _METRIC_SPECS.get(name)
                if spec is None:
                    logger.warning("unknown metric in batch: %s", name)
                    results[name] = {
                        "metric_name": name,
                        "run_id": None,
                        "run_completed_at": None,
                        "schema": [],
                        "rows": [],
                    }
                    continue
                try:
                    cache_key = (
                        _collector_for_metric(name),
                        tuple(sorted(filter.kb_ids or [])),
                    )
                    if cache_key not in run_cache:
                        run_cache[cache_key] = self._resolve_run(
                            session, filter, metric_name=name
                        )
                    run_id, run_completed_at = run_cache[cache_key]
                    results[name] = self._fetch_one(
                        session, name, spec, filter, run_id, run_completed_at
                    )
                except (ProgrammingError, OperationalError) as e:
                    # Per-metric failure: log and emit an empty result so the
                    # rest of the batch still returns.
                    logger.warning("Stat table query failed for %s: %s", name, e)
                    results[name] = {
                        "metric_name": name,
                        "run_id": None,
                        "run_completed_at": None,
                        "schema": [asdict(c) for c in spec.schema],
                        "rows": [],
                    }
        finally:
            session.close()
        return {"results": results}

    def _resolve_run(
        self,
        session: Session,
        filter: MetricFilter,
        *,
        metric_name: Optional[str] = None,
    ) -> tuple[Optional[int], Optional[datetime]]:
        """Resolve a run that successfully produced the requested metric."""
        if filter.run_id is not None:
            collector_name = _collector_for_metric(metric_name)
            params: dict[str, Any] = {"id": filter.run_id}
            scope_condition = "r.kb_filter IS NULL"
            if filter.kb_ids:
                placeholders = []
                for index, kb_id in enumerate(filter.kb_ids):
                    key = f"explicit_kb_{index}"
                    placeholders.append(f":{key}")
                    params[key] = kb_id
                scope_condition = (
                    "(r.kb_filter IS NULL OR JSON_CONTAINS("
                    f"r.kb_filter, JSON_ARRAY({', '.join(placeholders)})))"
                )
            collector_join = ""
            if collector_name:
                collector_join = (
                    "JOIN kb_stat_collector_runs c ON c.run_id = r.id "
                    "AND c.collector_name = :collector_name "
                    "AND c.status = 'success' "
                )
                params["collector_name"] = collector_name
            run_row = session.execute(
                text(
                    "SELECT r.completed_at FROM kb_stat_runs r "
                    f"{collector_join}"
                    "WHERE r.id = :id "
                    "AND r.status IN ('completed', 'partial') "
                    f"AND {scope_condition}"
                ),
                params,
            ).fetchone()
            if run_row is None:
                return None, None
            return filter.run_id, run_row.completed_at
        latest = self._latest_run(
            session,
            collector_name=_collector_for_metric(metric_name) if metric_name else None,
            kb_ids=filter.kb_ids,
        )
        if latest:
            return latest["id"], latest["completed_at"]
        return None, None

    def _fetch_one(
        self,
        session: Session,
        name: str,
        spec,
        filter: MetricFilter,
        run_id: Optional[int],
        run_completed_at: Optional[datetime],
        *,
        ignore_limit: bool = False,
    ) -> dict:
        """Query one metric using an already-open session and resolved run.

        Two query paths depending on the metric's date_col semantics:

        - ``date_col == "target_date"``: each run writes only the current
          day's snapshot. To build a trend we must span ALL completed runs
          and pick the latest run per target_date (same pattern as
          ``_fetch_aggregated_daily_rows`` for the global dashboard).

        - ``date_col == "stat_date"`` or ``date_col is None``: a single run
          already contains the full lookback window (the collector writes
          one row per day). Querying the latest run_id is sufficient.
        """
        table = spec.table
        schema = [asdict(c) for c in spec.schema]

        if run_id is None:
            return {
                "metric_name": name,
                "run_id": None,
                "run_completed_at": None,
                "schema": schema,
                "rows": [],
            }

        qopts = spec.query_options

        # --- Path A: target_date metrics — cross-run aggregation ---
        if spec.date_col == "target_date":
            run_condition, params = _successful_run_condition(name, filter)
            date_conds = [run_condition]
            if filter.effective_period_start:
                date_conds.append("target_date >= :start_date")
                params["start_date"] = filter.effective_period_start
            if filter.period_end_date:
                date_conds.append("target_date <= :end_date")
                params["end_date"] = filter.period_end_date
            if spec.kb_col and filter.kb_ids:
                placeholders = ", ".join(f":kid_{i}" for i in range(len(filter.kb_ids)))
                date_conds.append(f"{spec.kb_col} IN ({placeholders})")
                for i, kid in enumerate(filter.kb_ids):
                    params[f"kid_{i}"] = kid

            date_where = " AND ".join(date_conds)

            # Sub-query: latest run_id per (target_date, kb_id) if the table
            # has a kb_col — otherwise per target_date only. Deduping by
            # kb_id is critical for per-KB tables: without it, the JOIN
            # returns every KB's row for that day's MAX(run_id), not just
            # the latest row per KB. For tables without kb_col (global
            # metrics like doc_index_failure_rate), target_date alone is
            # the correct dedup key.
            dedup_cols = "target_date"
            if spec.kb_col:
                dedup_cols = f"target_date, {spec.kb_col}"

            order_by = qopts.order_by if qopts and qopts.order_by else "target_date"
            limit = (
                None if ignore_limit else (qopts.limit if qopts and qopts.limit else 60)
            )
            sql = (
                f"SELECT t.* FROM {table} t "
                f"INNER JOIN ("
                f"  SELECT {dedup_cols}, MAX(run_id) AS max_run "
                f"  FROM {table} WHERE {date_where} "
                f"  GROUP BY {dedup_cols}"
                f") latest ON t.target_date = latest.target_date "
                f"AND t.run_id = latest.max_run"
            )
            if spec.kb_col:
                sql += f" AND t.{spec.kb_col} = latest.{spec.kb_col}"
            sql += f" ORDER BY t.{order_by}"
            if limit is not None:
                sql += f" LIMIT {int(limit)}"

            rows = session.execute(text(sql), params).fetchall()
            return self._rows_to_metric_dict(
                rows, name, schema, run_id, run_completed_at
            )

        # --- Path B: stat_date / snapshot metrics — single latest run ---
        conditions = ["run_id = :run_id"]
        params = {"run_id": run_id}

        if spec.date_col and filter.effective_period_start:
            conditions.append(f"{spec.date_col} >= :start_date")
            params["start_date"] = filter.effective_period_start
        if spec.date_col and filter.period_end_date:
            conditions.append(f"{spec.date_col} <= :end_date")
            params["end_date"] = filter.period_end_date

        if spec.kb_col and filter.kb_ids:
            placeholders = ", ".join(f":kid_{i}" for i in range(len(filter.kb_ids)))
            conditions.append(f"{spec.kb_col} IN ({placeholders})")
            for i, kid in enumerate(filter.kb_ids):
                params[f"kid_{i}"] = kid

        where = " AND ".join(conditions)
        sql = f"SELECT * FROM {table} WHERE {where}"

        if qopts:
            if qopts.order_by:
                sql += f" ORDER BY {qopts.order_by}"
            if qopts.limit and not ignore_limit:
                sql += f" LIMIT {int(qopts.limit)}"

        rows = session.execute(text(sql), params).fetchall()
        return self._rows_to_metric_dict(rows, name, schema, run_id, run_completed_at)

    @staticmethod
    def _rows_to_metric_dict(
        rows: list,
        name: str,
        schema: list[dict],
        run_id: Optional[int],
        run_completed_at: Optional[datetime],
    ) -> dict:
        """Convert SQLAlchemy row proxies to a metric response dict."""
        result_rows = []
        for r in rows:
            row_dict = {}
            for col in r._fields:
                val = getattr(r, col)
                if isinstance(val, datetime):
                    val = _iso(val)
                elif isinstance(val, date):
                    val = _iso(val)
                row_dict[col] = val
            result_rows.append(row_dict)

        return {
            "metric_name": name,
            "run_id": run_id,
            "run_completed_at": _iso(run_completed_at),
            "schema": schema,
            "rows": result_rows,
        }

    def fetch_dashboard(self, filter: MetricFilter) -> dict:
        """Fetch all dashboard data in one call.

        Daily rows are aggregated across completed runs — for each stat_date
        the latest completed run's data is used. This supports incremental
        collection where each run covers only 1 day.
        """
        session = self._get_session()
        try:
            latest = self._latest_run(
                session,
                collector_name=(
                    "kb_daily_stats" if filter.kb_ids else "period_and_daily"
                ),
                kb_ids=filter.kb_ids,
            )
            if not latest:
                return {
                    "report_period": {
                        "start": _iso(filter.effective_period_start),
                        "end": _iso(filter.period_end_date),
                        "days": filter.period_days,
                    },
                    "generated_at": None,
                    "global_totals": None,
                    "period_totals": None,
                    "daily_rows": [],
                }

            # When a specific run_id is requested, use single-run mode
            if filter.run_id:
                return self._fetch_single_run_dashboard(session, filter.run_id, filter)

            # KB-scoped dashboard: aggregate from metric tables
            if filter.kb_ids:
                return self._fetch_kb_dashboard(session, latest["id"], filter)

            # Snapshot sections resolve their own successful collector runs.
            # A precise retry of period_and_daily must not make global totals
            # or storage disappear merely because the retry run did not
            # execute those collectors.
            global_run_id, _ = self._resolve_run(
                session, filter, metric_name="global_totals"
            )
            gt_row = (
                session.execute(
                    text(
                        "SELECT * FROM kb_stat_global_totals WHERE run_id = :run_id LIMIT 1"
                    ),
                    {"run_id": global_run_id},
                ).fetchone()
                if global_run_id is not None
                else None
            )

            global_totals = None
            if gt_row:
                storage_run_id, _ = self._resolve_run(
                    session, filter, metric_name="storage_usage"
                )
                try:
                    storage_row = (
                        session.execute(
                            text(
                                "SELECT COALESCE(SUM(total_file_size), 0) "
                                "AS total_storage "
                                "FROM kb_stat_storage_usage WHERE run_id = :run_id"
                            ),
                            {"run_id": storage_run_id},
                        ).fetchone()
                        if storage_run_id is not None
                        else None
                    )
                    total_storage = int(storage_row.total_storage) if storage_row else 0
                except (ProgrammingError, OperationalError):
                    total_storage = 0

                global_totals = {
                    "total_kb_count": gt_row.total_kb_count,
                    "total_doc_count": gt_row.total_doc_count,
                    "total_storage": total_storage,
                    "dingtalk_synced_user_count": gt_row.dingtalk_synced_user_count,
                    "dingtalk_kb_count": gt_row.dingtalk_kb_count,
                    "dingtalk_doc_count": gt_row.dingtalk_doc_count,
                }

            # Daily rows — latest run per stat_date across all completed runs
            daily_rows_raw = self._fetch_aggregated_daily_rows(session, filter)

            # Period totals — derived from aggregated daily data
            period_totals = None
            if daily_rows_raw:
                period_total_queries = sum(r.total_queries for r in daily_rows_raw)
                period_new_kb = sum(r.new_kb_count for r in daily_rows_raw)
                period_new_docs = sum(r.new_doc_count for r in daily_rows_raw)
                period_rag_queries = sum(r.rag_queries for r in daily_rows_raw)
                period_direct_inject = sum(r.direct_injection for r in daily_rows_raw)
                period_kb_head_queries = sum(r.kb_head_queries for r in daily_rows_raw)

                active_kb_count = max(
                    (r.active_kb_count for r in daily_rows_raw), default=0
                )
                total_kb = gt_row.total_kb_count if gt_row else 0
                active_kb_ratio = (
                    round(active_kb_count / total_kb * 100, 2) if total_kb > 0 else None
                )

                period_totals = {
                    "period_total_queries": period_total_queries,
                    "period_new_kb": period_new_kb,
                    "period_new_docs": period_new_docs,
                    "period_rag_queries": period_rag_queries,
                    "period_direct_inject": period_direct_inject,
                    "period_kb_head_queries": period_kb_head_queries,
                    "active_kb_ratio": active_kb_ratio,
                }

            daily_rows = [
                {
                    "stat_date": _iso(r.stat_date),
                    "total_queries": r.total_queries,
                    "rag_queries": r.rag_queries,
                    "direct_injection": r.direct_injection,
                    "kb_head_rag_queries": r.kb_head_rag_queries,
                    "kb_head_queries": r.kb_head_queries,
                    "active_kb_count": r.active_kb_count,
                    "active_user_count": r.active_user_count,
                    "new_kb_count": r.new_kb_count,
                    "new_doc_count": r.new_doc_count,
                    "dingtalk_active_user_count": r.dingtalk_active_user_count,
                }
                for r in daily_rows_raw
            ]

            # --- Platform-level aggregate views (v1.3 time-series plan) ---
            # 1. Health distribution per day (for stacked area chart).
            #    Aggregated from per-KB health_score by target_date, grouped
            #    into tiers. This counters the Simpson's paradox risk where
            #    a single weighted-mean line hides a deteriorating tail.
            platform_health_dist = self._fetch_platform_health_distribution(
                session, filter
            )

            # 2. Platform retrieval quality (weighted-mean zero-chunk rate).
            #    Computed as SUM(zero_chunk_events)/SUM(total_events) per
            #    day — a true event-weighted mean, not a mean-of-means.
            platform_retrieval_quality = self._fetch_platform_retrieval_quality(
                session, filter
            )

            # 3-5. Platform-weighted hit / adoption / dedup rates. Same
            #      event-weighted pattern as retrieval quality
            #      (SUM(numerator)/SUM(denominator) per day) so the KPI
            #      top bar shows true platform means, not mean-of-means.
            platform_hit_rate = self._fetch_platform_hit_rate(session, filter)
            platform_adoption_rate = self._fetch_platform_adoption_rate(session, filter)
            platform_dedup_rate = self._fetch_platform_dedup_rate(session, filter)

            return {
                "report_period": {
                    "start": _iso(filter.effective_period_start),
                    "end": _iso(filter.period_end_date),
                    "days": filter.period_days,
                },
                "generated_at": (
                    _iso(latest["completed_at"]) if latest["completed_at"] else None
                ),
                "global_totals": global_totals,
                "period_totals": period_totals,
                "daily_rows": daily_rows,
                "platform_health_distribution": platform_health_dist,
                "platform_retrieval_quality": platform_retrieval_quality,
                "platform_hit_rate": platform_hit_rate,
                "platform_adoption_rate": platform_adoption_rate,
                "platform_dedup_rate": platform_dedup_rate,
            }
        except (ProgrammingError, OperationalError) as e:
            logger.warning(
                "Dashboard query failed (table/column may not exist yet): %s", e
            )
            return {
                "report_period": {
                    "start": _iso(filter.effective_period_start),
                    "end": _iso(filter.period_end_date),
                    "days": filter.period_days,
                },
                "generated_at": None,
                "global_totals": None,
                "period_totals": None,
                "daily_rows": [],
            }
        finally:
            session.close()

    def _fetch_aggregated_daily_rows(
        self, session: Session, filter: MetricFilter
    ) -> list:
        """Return the latest successfully collected platform row per date."""
        return session.execute(
            text(
                """
                SELECT d.*
                FROM kb_stat_daily_dashboard d
                JOIN (
                    SELECT dd.stat_date, MAX(dd.run_id) AS max_run
                    FROM kb_stat_daily_dashboard dd
                    JOIN kb_stat_runs r ON r.id = dd.run_id
                    JOIN kb_stat_collector_runs c
                      ON c.run_id = r.id
                     AND c.collector_name = 'period_and_daily'
                     AND c.status = 'success'
                    WHERE r.status IN ('completed', 'partial')
                      AND r.kb_filter IS NULL
                      AND dd.stat_date >= :start_date
                      AND dd.stat_date <= :end_date
                    GROUP BY dd.stat_date
                ) latest
                  ON latest.stat_date = d.stat_date
                 AND latest.max_run = d.run_id
                ORDER BY d.stat_date
                """
            ),
            {
                "start_date": filter.effective_period_start,
                "end_date": filter.period_end_date,
            },
        ).fetchall()

    def _fetch_kb_dashboard(
        self,
        session: Session,
        run_id: int,
        filter: MetricFilter,
    ) -> dict:
        """Build the KB overview from per-KB daily and storage snapshots."""
        kb_id = int(filter.kb_ids[0])
        daily_rows = session.execute(
            text(
                """
                SELECT d.*
                FROM kb_stat_kb_daily_stats d
                JOIN (
                    SELECT ds.stat_date, ds.kb_id, MAX(ds.run_id) AS max_run
                    FROM kb_stat_kb_daily_stats ds
                    JOIN kb_stat_runs r ON r.id = ds.run_id
                    JOIN kb_stat_collector_runs c
                      ON c.run_id = r.id
                     AND c.collector_name = 'kb_daily_stats'
                     AND c.status = 'success'
                    WHERE r.status IN ('completed', 'partial')
                      AND (r.kb_filter IS NULL
                           OR JSON_CONTAINS(r.kb_filter, JSON_ARRAY(:kb_id)))
                      AND ds.kb_id = :kb_id
                      AND ds.stat_date >= :start_date
                      AND ds.stat_date <= :end_date
                    GROUP BY ds.stat_date, ds.kb_id
                ) latest
                  ON latest.stat_date = d.stat_date
                 AND latest.kb_id = d.kb_id
                 AND latest.max_run = d.run_id
                ORDER BY d.stat_date
                """
            ),
            {
                "kb_id": kb_id,
                "start_date": filter.effective_period_start,
                "end_date": filter.period_end_date,
            },
        ).fetchall()

        storage_run, _ = self._resolve_run(session, filter, metric_name="storage_usage")
        storage = None
        if storage_run is not None:
            storage = session.execute(
                text(
                    """
                    SELECT doc_count, total_file_size
                    FROM kb_stat_storage_usage
                    WHERE run_id = :run_id AND kb_id = :kb_id
                    LIMIT 1
                    """
                ),
                {"run_id": storage_run, "kb_id": kb_id},
            ).fetchone()

        rows = [
            {
                "stat_date": _iso(row.stat_date),
                "total_queries": int(row.total_queries or 0),
                "rag_queries": int(row.rag_queries or 0),
                "direct_injection": int(row.direct_injection or 0),
                "kb_head_rag_queries": 0,
                "kb_head_queries": int(row.head_queries or 0),
                "active_kb_count": 1 if int(row.total_queries or 0) > 0 else 0,
                "active_user_count": int(row.active_user_count or 0),
                "new_kb_count": 0,
                "new_doc_count": int(row.new_doc_count or 0),
                "dingtalk_active_user_count": 0,
            }
            for row in daily_rows
        ]
        period_totals = {
            "period_total_queries": sum(row["total_queries"] for row in rows),
            "period_new_kb": 0,
            "period_new_docs": sum(row["new_doc_count"] for row in rows),
            "period_rag_queries": sum(row["rag_queries"] for row in rows),
            "period_direct_inject": sum(row["direct_injection"] for row in rows),
            "period_kb_head_queries": sum(row["kb_head_queries"] for row in rows),
            "active_kb_ratio": 100.0 if rows else 0.0,
        }
        latest = self._latest_run(
            session,
            collector_name="kb_daily_stats",
            kb_ids=filter.kb_ids,
        )
        return {
            "report_period": {
                "start": _iso(filter.effective_period_start),
                "end": _iso(filter.period_end_date),
                "days": filter.period_days,
            },
            "generated_at": (
                _iso(latest["completed_at"])
                if latest and latest["completed_at"]
                else None
            ),
            "global_totals": {
                "total_kb_count": 1,
                "total_doc_count": int(storage.doc_count or 0) if storage else 0,
                "total_storage": (int(storage.total_file_size or 0) if storage else 0),
                "dingtalk_synced_user_count": 0,
                "dingtalk_kb_count": 0,
                "dingtalk_doc_count": 0,
            },
            "period_totals": period_totals,
            "daily_rows": rows,
        }

    def _fetch_platform_health_distribution(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Per-day KB count by health-score tier.

        Powers the stacked-area chart on the admin dashboard. Grouping
        per-KB health scores into tiers (excellent/good/fair/poor/no-data)
        per day reveals distribution shifts that a single weighted mean
        would mask (Simpson's paradox defense, v1.3 §8.2).

        **Dedup**: the same (target_date, kb_id) can appear in multiple
        runs (manual re-trigger, backfill). We pick only the latest run
        per target_date via an INNER JOIN on MAX(run_id), otherwise SUM
        double-counts KBs and the stacked area shows inflated totals.
        """
        run_condition, params = _successful_run_condition(
            "kb_health_score",
            filter,
            run_column="h.run_id",
            param_prefix="health_run",
        )
        conditions = [run_condition]
        if filter.effective_period_start:
            conditions.append("h.target_date >= :start_date")
            params["start_date"] = filter.effective_period_start
        if filter.period_end_date:
            conditions.append("h.target_date <= :end_date")
            params["end_date"] = filter.period_end_date
        where = " AND ".join(conditions)
        try:
            rows = session.execute(
                text(
                    f"""
                    SELECT
                        h.target_date,
                        SUM(CASE WHEN h.health_score >= 85 THEN 1 ELSE 0 END)
                            AS excellent,
                        SUM(CASE WHEN h.health_score >= 70
                                 AND h.health_score < 85 THEN 1 ELSE 0 END)
                            AS good,
                        SUM(CASE WHEN h.health_score >= 50
                                 AND h.health_score < 70 THEN 1 ELSE 0 END)
                            AS fair,
                        SUM(CASE WHEN h.health_score < 50
                                 AND h.health_score IS NOT NULL THEN 1 ELSE 0 END)
                            AS poor,
                        SUM(CASE WHEN h.health_score IS NULL THEN 1 ELSE 0 END)
                            AS no_data
                    FROM kb_stat_kb_health_score h
                    INNER JOIN (
                        SELECT hs.target_date, MAX(hs.run_id) AS max_run
                        FROM kb_stat_kb_health_score hs
                        JOIN kb_stat_runs sr ON sr.id = hs.run_id
                        JOIN kb_stat_collector_runs sc
                          ON sc.run_id = sr.id
                         AND sc.collector_name = 'kb_health_score'
                         AND sc.status = 'success'
                        WHERE sr.status IN ('completed', 'partial')
                          AND sr.kb_filter IS NULL
                        GROUP BY hs.target_date
                    ) latest
                        ON h.target_date = latest.target_date
                        AND h.run_id = latest.max_run
                    WHERE {where}
                    GROUP BY h.target_date
                    ORDER BY h.target_date
                    """
                ),
                params,
            ).fetchall()
        except (ProgrammingError, OperationalError):
            logger.warning("Platform health distribution query failed")
            return []
        return [
            {
                "stat_date": _iso(r.target_date),
                "excellent": int(r.excellent or 0),
                "good": int(r.good or 0),
                "fair": int(r.fair or 0),
                "poor": int(r.poor or 0),
                "no_data": int(r.no_data or 0),
            }
            for r in rows
        ]

    def _fetch_platform_retrieval_quality(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Daily event-weighted platform zero-chunk rate.

        Computed as SUM(zero_chunk_queries) / SUM(total_queries) per day
        across ALL KBs — a true weighted mean, not a mean-of-means (v1.3
        §9.2). This is the companion line to the stacked-area chart so
        the two views always appear together (Simpson's paradox defense).

        **Dedup**: same cross-run dedup as health distribution — pick
        the latest run_id per target_date before aggregating.
        """
        run_condition, params = _successful_run_condition(
            "kb_zero_chunk_rate",
            filter,
            run_column="z.run_id",
            param_prefix="quality_run",
        )
        conditions = [run_condition]
        if filter.effective_period_start:
            conditions.append("z.target_date >= :start_date")
            params["start_date"] = filter.effective_period_start
        if filter.period_end_date:
            conditions.append("z.target_date <= :end_date")
            params["end_date"] = filter.period_end_date
        where = " AND ".join(conditions)
        try:
            rows = session.execute(
                text(
                    f"""
                    SELECT
                        z.target_date,
                        SUM(z.zero_chunk_queries) AS zero_events,
                        SUM(z.total_queries) AS total_events
                    FROM kb_stat_kb_zero_chunk_rate z
                    INNER JOIN (
                        SELECT zs.target_date, MAX(zs.run_id) AS max_run
                        FROM kb_stat_kb_zero_chunk_rate zs
                        JOIN kb_stat_runs sr ON sr.id = zs.run_id
                        JOIN kb_stat_collector_runs sc
                          ON sc.run_id = sr.id
                         AND sc.collector_name = 'kb_zero_chunk_rate'
                         AND sc.status = 'success'
                        WHERE sr.status IN ('completed', 'partial')
                          AND sr.kb_filter IS NULL
                        GROUP BY zs.target_date
                    ) latest
                        ON z.target_date = latest.target_date
                        AND z.run_id = latest.max_run
                    WHERE {where}
                    GROUP BY z.target_date
                    ORDER BY z.target_date
                    """
                ),
                params,
            ).fetchall()
        except (ProgrammingError, OperationalError):
            logger.warning("Platform retrieval quality query failed")
            return []
        return [
            {
                "stat_date": _iso(r.target_date),
                # Event-weighted rate: avoids the mean-of-means trap by
                # aggregating raw event counts, not per-KB rates.
                "zero_chunk_rate": (
                    round(int(r.zero_events or 0) / int(r.total_events or 1) * 100, 2)
                    if r.total_events and int(r.total_events) > 0
                    else None
                ),
                "total_queries": int(r.total_events or 0),
            }
            for r in rows
        ]

    def _fetch_platform_rate(
        self,
        session: Session,
        filter: MetricFilter,
        table: str,
        numerator_col: str,
    ) -> list[dict]:
        """Daily event-weighted platform rate (shared implementation).

        ``SUM(numerator_col) / SUM(total_queries)`` per day across all KBs,
        with the same latest-run-per-target_date dedup as
        ``_fetch_platform_retrieval_quality``. Used for hit / adoption /
        dedup rates so the admin KPI top bar shows true weighted means.
        """
        metric_name_by_table = {
            "kb_stat_kb_retrieval_hit_rate": "kb_retrieval_hit_rate",
            "kb_stat_answer_adoption_rate": "answer_adoption_rate",
            "kb_stat_query_dedup_rate": "query_dedup_rate",
        }
        metric_name = metric_name_by_table[table]
        run_condition, params = _successful_run_condition(
            metric_name,
            filter,
            run_column="t.run_id",
            param_prefix=f"{metric_name}_run",
        )
        params["rate_collector"] = _collector_for_metric(metric_name)
        conditions = [run_condition]
        if filter.effective_period_start:
            conditions.append("t.target_date >= :start_date")
            params["start_date"] = filter.effective_period_start
        if filter.period_end_date:
            conditions.append("t.target_date <= :end_date")
            params["end_date"] = filter.period_end_date
        where = " AND ".join(conditions)
        try:
            rows = session.execute(
                text(
                    f"""
                    SELECT
                        t.target_date,
                        SUM(t.{numerator_col}) AS num_events,
                        SUM(t.total_queries) AS total_events
                    FROM {table} t
                    INNER JOIN (
                        SELECT rs.target_date, MAX(rs.run_id) AS max_run
                        FROM {table} rs
                        JOIN kb_stat_runs sr ON sr.id = rs.run_id
                        JOIN kb_stat_collector_runs sc
                          ON sc.run_id = sr.id
                         AND sc.collector_name = :rate_collector
                         AND sc.status = 'success'
                        WHERE sr.status IN ('completed', 'partial')
                          AND sr.kb_filter IS NULL
                        GROUP BY rs.target_date
                    ) latest
                        ON t.target_date = latest.target_date
                        AND t.run_id = latest.max_run
                    WHERE {where}
                    GROUP BY t.target_date
                    ORDER BY t.target_date
                    """
                ),
                params,
            ).fetchall()
        except (ProgrammingError, OperationalError):
            logger.warning("Platform rate query failed for %s", table)
            return []
        return [
            {
                "stat_date": _iso(r.target_date),
                "rate": (
                    round(int(r.num_events or 0) / int(r.total_events or 1) * 100, 2)
                    if r.total_events and int(r.total_events) > 0
                    else None
                ),
                "total_queries": int(r.total_events or 0),
            }
            for r in rows
        ]

    def _fetch_platform_hit_rate(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Daily event-weighted platform retrieval hit rate."""
        return self._fetch_platform_rate(
            session, filter, "kb_stat_kb_retrieval_hit_rate", "hit_queries"
        )

    def _fetch_platform_adoption_rate(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Daily event-weighted platform answer adoption rate."""
        return self._fetch_platform_rate(
            session, filter, "kb_stat_answer_adoption_rate", "adopted_queries"
        )

    def _fetch_platform_dedup_rate(
        self, session: Session, filter: MetricFilter
    ) -> list[dict]:
        """Daily event-weighted platform query dedup rate."""
        return self._fetch_platform_rate(
            session, filter, "kb_stat_query_dedup_rate", "unique_queries"
        )

    def list_metrics(self, scope: str = "admin") -> list[dict]:
        """Return metric metadata based on queryable metric definitions."""
        return build_metric_list(scope=scope)

    def list_runs(
        self,
        limit: int = 20,
        offset: int = 0,
        status: Optional[str] = None,
        target_date_start: Optional[str] = None,
        target_date_end: Optional[str] = None,
    ) -> dict:
        session = self._get_session()
        try:
            conditions = []
            params: dict = {}

            if status:
                conditions.append("status = :status")
                params["status"] = status
            if target_date_start:
                conditions.append("target_date >= :date_start")
                params["date_start"] = target_date_start
            if target_date_end:
                conditions.append("target_date <= :date_end")
                params["date_end"] = target_date_end

            where = ""
            if conditions:
                where = "WHERE " + " AND ".join(conditions)

            total_row = session.execute(
                text(f"SELECT COUNT(*) FROM kb_stat_runs {where}"), params
            ).fetchone()
            total = total_row[0] if total_row else 0

            rows = session.execute(
                text(
                    f"SELECT id, started_at, completed_at, status, target_date, "
                    f"kb_filter, triggered_by, triggered_user_id, "
                    f"metrics_count, error_message, stat_start, stat_end "
                    f"FROM kb_stat_runs {where} "
                    f"ORDER BY id DESC LIMIT :limit OFFSET :offset"
                ),
                {**params, "limit": limit, "offset": offset},
            ).fetchall()

            return {
                "total": total,
                "runs": [
                    {
                        "id": r.id,
                        "started_at": (_iso(r.started_at)),
                        "completed_at": (_iso(r.completed_at)),
                        "status": r.status,
                        "target_date": (_iso(r.target_date)),
                        "kb_filter": r.kb_filter,
                        "triggered_by": r.triggered_by,
                        "triggered_user_id": r.triggered_user_id,
                        "metrics_count": r.metrics_count,
                        "error_message": r.error_message,
                        "stat_start": _iso(r.stat_start),
                        "stat_end": _iso(r.stat_end),
                    }
                    for r in rows
                ],
            }
        finally:
            session.close()

    def get_collector_runs(self, run_id: int) -> list[dict]:
        session = self._get_session()
        try:
            rows = session.execute(
                text(
                    "SELECT id, domain, collector_name, status, started_at, "
                    "completed_at, rows_written, duration_ms, error_message "
                    "FROM kb_stat_collector_runs WHERE run_id = :run_id "
                    "ORDER BY id"
                ),
                {"run_id": run_id},
            ).fetchall()
            return [
                {
                    "id": r.id,
                    "domain": r.domain,
                    "collector_name": r.collector_name,
                    "status": r.status,
                    "started_at": _iso(r.started_at),
                    "completed_at": (_iso(r.completed_at)),
                    "rows_written": r.rows_written,
                    "duration_ms": r.duration_ms,
                    "error_message": r.error_message,
                }
                for r in rows
            ]
        finally:
            session.close()

    def get_run(self, run_id: int) -> Optional[dict]:
        session = self._get_session()
        try:
            row = session.execute(
                text(
                    "SELECT id, started_at, completed_at, status, target_date, "
                    "kb_filter, triggered_by, triggered_user_id, metrics_count, "
                    "error_message, stat_start, stat_end "
                    "FROM kb_stat_runs WHERE id = :run_id"
                ),
                {"run_id": run_id},
            ).fetchone()
            if row is None:
                return None
            return {
                "id": row.id,
                "started_at": _iso(row.started_at),
                "completed_at": _iso(row.completed_at),
                "status": row.status,
                "target_date": _iso(row.target_date),
                "kb_filter": row.kb_filter,
                "triggered_by": row.triggered_by,
                "triggered_user_id": row.triggered_user_id,
                "metrics_count": row.metrics_count,
                "error_message": row.error_message,
                "stat_start": _iso(row.stat_start),
                "stat_end": _iso(row.stat_end),
            }
        finally:
            session.close()

    def health(self) -> dict:
        """Check stat DB connectivity and latest run status."""
        # The switches live on the runtime Settings (which is the layer
        # that owns deployment config). Lazy import keeps the engine
        # importable without the runtime installed (used by CLI scripts).
        try:
            from knowledge_runtime.config import get_settings

            runtime_settings = get_settings()
            enabled = runtime_settings.kb_stat_enabled
            prune_enabled = runtime_settings.kb_stat_prune_enabled
        except Exception:  # noqa: BLE001 - engine may run without runtime
            logger.debug("runtime settings unavailable; defaulting switches to True")
            enabled = True
            prune_enabled = True

        session = self._get_session()
        try:
            session.execute(text("SELECT 1"))
            latest = self._latest_run(session)
            return {
                "stat_db_ok": True,
                "worker_ok": latest is not None
                and latest["status"] in ("completed", "partial"),
                "enabled": enabled,
                "prune_enabled": prune_enabled,
                "latest_run_id": latest["id"] if latest else None,
                "latest_run_completed_at": (
                    _iso(latest["completed_at"])
                    if latest and latest["completed_at"]
                    else None
                ),
                "latest_run_status": latest["status"] if latest else None,
                "metrics_registered": len(all_collectors()),
            }
        except Exception:
            logger.exception("stat health check failed")
            return {
                "stat_db_ok": False,
                "worker_ok": False,
                "enabled": enabled,
                "prune_enabled": prune_enabled,
                "latest_run_id": None,
                "latest_run_completed_at": None,
                "latest_run_status": None,
                "metrics_registered": len(all_collectors()),
            }
        finally:
            session.close()

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pydantic request/response models for KB stat API (shared by backend & runtime)."""

from datetime import date, datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator


class KbStatFilter(BaseModel):
    """Query filter body shared by all stat query endpoints."""

    start_date: Optional[date] = None
    end_date: Optional[date] = None
    # Cap list sizes: each kb_id becomes a bind param or JSON_CONTAINS
    # argument, so an unbounded list can produce a huge SQL statement and pin
    # a DB connection while it parses. 500 comfortably covers any real tenant.
    kb_ids: Optional[list[int]] = Field(default=None, max_length=500)
    run_id: Optional[int] = None

    @model_validator(mode="after")
    def validate_date_range(self):
        if self.start_date and self.end_date:
            if self.start_date > self.end_date:
                raise ValueError("start_date must be on or before end_date")
            if (self.end_date - self.start_date).days > 366:
                raise ValueError("date range cannot exceed 367 days")
        return self


class FieldSchema(BaseModel):
    key: str
    type: str  # date / int / float / string / datetime
    label: str


class MetricResponse(BaseModel):
    metric_name: str
    run_id: Optional[int] = None
    run_completed_at: Optional[str] = None
    schema_: list[FieldSchema] = Field(alias="schema")
    rows: list[dict[str, Any]]

    model_config = {"populate_by_name": True}


class MetricBatchRequest(KbStatFilter):
    """Batch query body: a metric filter plus the metric names to fetch.

    Extends ``KbStatFilter`` so callers reuse the existing filter shape
    (start_date/end_date/kb_ids/run_id) and just add ``names``.
    """

    # Cap the batch size: each name triggers an independent stat-DB SELECT,
    # so an unbounded list can exhaust the connection pool. 100 comfortably
    # covers the full metric catalog (~78) while bounding worst-case load.
    names: list[str] = Field(default_factory=list, max_length=100)


class MetricBatchResponse(BaseModel):
    """Batch query result: a metric-name keyed map of ``MetricResponse``."""

    results: dict[str, MetricResponse] = {}


class PeriodInfo(BaseModel):
    start: str
    end: str
    days: int


class GlobalTotalsData(BaseModel):
    total_kb_count: int = 0
    total_doc_count: int = 0
    total_storage: int = 0
    dingtalk_synced_user_count: int = 0
    dingtalk_kb_count: int = 0
    dingtalk_doc_count: int = 0


class PeriodTotalsData(BaseModel):
    period_total_queries: int = 0
    period_new_kb: int = 0
    period_new_docs: int = 0
    period_rag_queries: int = 0
    period_direct_inject: int = 0
    period_kb_head_queries: int = 0
    active_kb_ratio: Optional[float] = None


class DailyDashboardRow(BaseModel):
    stat_date: Optional[str] = None
    total_queries: int = 0
    rag_queries: int = 0
    direct_injection: int = 0
    kb_head_rag_queries: int = 0
    kb_head_queries: int = 0
    active_kb_count: int = 0
    active_user_count: int = 0
    new_kb_count: int = 0
    new_doc_count: int = 0
    dingtalk_active_user_count: int = 0


class PlatformHealthDistributionRow(BaseModel):
    """One day of KB counts by health-score tier (stacked area chart)."""

    stat_date: Optional[str] = None
    excellent: int = 0
    good: int = 0
    fair: int = 0
    poor: int = 0
    no_data: int = 0


class PlatformQualityRow(BaseModel):
    """One day of event-weighted platform retrieval quality (companion
    line to the health-distribution stacked area)."""

    stat_date: Optional[str] = None
    zero_chunk_rate: Optional[float] = None
    total_queries: int = 0


class PlatformRateRow(BaseModel):
    """One day of an event-weighted platform ratio (hit / adoption / dedup).

    Feeds the admin KPI top-bar sparklines. ``rate`` is a 0-100 percentage
    computed as SUM(numerator) / SUM(total_queries) across all KBs.
    """

    stat_date: Optional[str] = None
    rate: Optional[float] = None
    total_queries: int = 0


class DashboardResponse(BaseModel):
    report_period: PeriodInfo
    generated_at: Optional[str] = None
    global_totals: Optional[GlobalTotalsData] = None
    period_totals: Optional[PeriodTotalsData] = None
    daily_rows: list[DailyDashboardRow] = []
    # Platform-level aggregate time-series (admin dashboard only).
    # Optional so KB-scoped dashboards and older clients are unaffected.
    platform_health_distribution: Optional[list[PlatformHealthDistributionRow]] = None
    platform_retrieval_quality: Optional[list[PlatformQualityRow]] = None
    platform_hit_rate: Optional[list[PlatformRateRow]] = None
    platform_adoption_rate: Optional[list[PlatformRateRow]] = None


class TriggerRunRequest(BaseModel):
    target_date: Optional[date] = None
    # Bounded for the same DoS reason as KbStatFilter; also prevents a single
    # Celery task from fanning out an unbounded collector/KB selection.
    kb_ids: Optional[list[int]] = Field(default=None, max_length=500)
    domains: Optional[list[str]] = Field(default=None, max_length=50)
    collector_names: Optional[list[str]] = Field(default=None, max_length=200)
    triggered_by: str = "manual_api"
    triggered_user_id: Optional[int] = None


class TriggerRunResponse(BaseModel):
    celery_task_id: str


class MetricListResponse(BaseModel):
    domains: list[dict[str, Any]]


class RunInfo(BaseModel):
    id: int
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    status: str
    target_date: Optional[str] = None
    kb_filter: Optional[str] = None
    triggered_by: str
    triggered_user_id: Optional[int] = None
    metrics_count: int = 0
    error_message: Optional[str] = None
    stat_start: Optional[str] = None
    stat_end: Optional[str] = None


class RunListResponse(BaseModel):
    runs: list[RunInfo]
    total: int = 0


class CollectorRunInfo(BaseModel):
    id: int
    domain: str
    collector_name: str
    status: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    rows_written: int = 0
    duration_ms: int = 0
    error_message: Optional[str] = None


class CollectorRunListResponse(BaseModel):
    run_id: int
    collectors: list[CollectorRunInfo]


class HealthResponse(BaseModel):
    stat_db_ok: bool = False
    worker_ok: bool = False
    # Master switch (KB_STAT_ENABLED) and prune switch
    # (KB_STAT_PRUNE_ENABLED). Defaults keep the response backward
    # compatible when the runtime hasn't been upgraded yet.
    enabled: bool = True
    prune_enabled: bool = True
    # Advanced-metrics switch (KB_STAT_ADVANCED_ENABLED). false (default)
    # means only the basic 18-metric tier is collected/exposed. Default True
    # keeps older clients that never set the field backward compatible.
    advanced_enabled: bool = True
    latest_run_id: Optional[int] = None
    latest_run_completed_at: Optional[str] = None
    latest_run_status: Optional[str] = None
    metrics_registered: int = 0

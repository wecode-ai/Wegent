# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""RemoteKbStatGateway: forwards KB stat queries to knowledge_runtime."""

from __future__ import annotations

import logging
from typing import Any

from app.services.runtime_client import RemoteRuntimeError, RuntimeHttpClient
from shared.models.kb_stat import (
    CollectorRunListResponse,
    DashboardResponse,
    KbStatFilter,
    MetricBatchRequest,
    MetricListResponse,
    MetricResponse,
    RunListResponse,
    TriggerRunRequest,
    TriggerRunResponse,
)

logger = logging.getLogger(__name__)


class RemoteKbStatGateway:
    """Client for KB stat endpoints on knowledge_runtime."""

    def __init__(self, *, client: RuntimeHttpClient | None = None) -> None:
        self._client = client or RuntimeHttpClient()

    async def dashboard(self, payload: KbStatFilter) -> dict[str, Any]:
        return await self._client.post("/internal/kb-stat/dashboard", payload)

    async def metric(self, name: str, payload: KbStatFilter) -> dict[str, Any]:
        return await self._client.post(f"/internal/kb-stat/metrics/{name}", payload)

    async def metric_batch(self, payload: MetricBatchRequest) -> dict[str, Any]:
        return await self._client.post("/internal/kb-stat/metrics/batch", payload)

    async def quality_alert_metrics(self, payload: KbStatFilter) -> dict[str, Any]:
        return await self._client.post(
            "/internal/kb-stat/quality-alert-metrics", payload
        )

    async def list_metrics(self, scope: str = "admin") -> dict[str, Any]:
        return await self._client.get(f"/internal/kb-stat/metrics/list?scope={scope}")

    async def list_runs(
        self,
        limit: int = 20,
        offset: int = 0,
        status: str | None = None,
        target_date_start: str | None = None,
        target_date_end: str | None = None,
    ) -> dict[str, Any]:
        params = [f"limit={limit}", f"offset={offset}"]
        if status:
            params.append(f"status={status}")
        if target_date_start:
            params.append(f"target_date_start={target_date_start}")
        if target_date_end:
            params.append(f"target_date_end={target_date_end}")
        return await self._client.get(f"/internal/kb-stat/runs?{'&'.join(params)}")

    async def list_collector_runs(self, run_id: int) -> dict[str, Any]:
        return await self._client.get(f"/internal/kb-stat/runs/{run_id}/collectors")

    async def get_run(self, run_id: int) -> dict[str, Any]:
        return await self._client.get(f"/internal/kb-stat/runs/{run_id}")

    async def trigger_run(self, payload: TriggerRunRequest) -> dict[str, Any]:
        return await self._client.post("/internal/kb-stat/runs/trigger", payload)

    async def health(self, *, timeout: float = 5.0) -> dict[str, Any]:
        try:
            return await self._client.get("/internal/kb-stat/health", timeout=timeout)
        except Exception:
            return {"stat_db_ok": False, "worker_ok": False}

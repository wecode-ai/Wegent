# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Client for the asynchronous external web crawler HTTP API."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_RUN_JOB_URL = "http://iam.erp.sina.com.cn/interface/index.php/c_cms_helper/run_job"
_QUEUE_BASE_URL = "http://queue.spider.pub.sina.com.cn:9050"
_POLL_INTERVAL_SECONDS = 5.0
_JOB_TIMEOUT_SECONDS = 300.0
_MAX_CONSECUTIVE_STATUS_FAILURES = 3
_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=10.0)


class SpiderJobError(Exception):
    """Raised when the spider job API cannot produce a successful result."""


class SpiderJobClient:
    """Submit a spider job, poll it, and return its result rows."""

    async def run_job(self, params: dict[str, str]) -> list[dict[str, Any]]:
        """Run one spider job and return its result rows."""
        try:
            async with asyncio.timeout(_JOB_TIMEOUT_SECONDS):
                async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                    run_id = await self._submit(client, params)
                    await self._wait_for_success(client, run_id)
                    return await self._get_result(client, run_id)
        except TimeoutError as exc:
            raise SpiderJobError("External web crawl job timed out") from exc
        except httpx.HTTPError as exc:
            raise SpiderJobError(f"Spider API request failed: {exc}") from exc

    async def _submit(
        self,
        client: httpx.AsyncClient,
        params: dict[str, str],
    ) -> str:
        payload = await self._get_json(
            client,
            _RUN_JOB_URL,
            params=params,
        )
        if payload.get("code") != 0:
            raise SpiderJobError(
                self._error_message(payload, "External web crawl submission failed")
            )
        result = payload.get("result")
        run_id = result.get("run_id") if isinstance(result, dict) else None
        if not isinstance(run_id, str) or not run_id.strip():
            raise SpiderJobError("External web crawl run id is missing")
        logger.info("[WEB_CONTENT_SPIDER] submitted run_id=%s", run_id)
        return run_id.strip()

    async def _wait_for_success(
        self,
        client: httpx.AsyncClient,
        run_id: str,
    ) -> None:
        consecutive_failures = 0
        while True:
            try:
                status = await self._get_status(client, run_id)
            except (httpx.HTTPError, SpiderJobError) as exc:
                consecutive_failures += 1
                logger.warning(
                    "[WEB_CONTENT_SPIDER] status query failed run_id=%s attempt=%s error=%s",
                    run_id,
                    consecutive_failures,
                    exc,
                )
                if consecutive_failures >= _MAX_CONSECUTIVE_STATUS_FAILURES:
                    raise SpiderJobError(
                        "Spider status query failed three consecutive times"
                    ) from exc
                await asyncio.sleep(_POLL_INTERVAL_SECONDS)
                continue

            consecutive_failures = 0
            logger.info(
                "[WEB_CONTENT_SPIDER] status run_id=%s status=%s", run_id, status
            )
            if status == 1:
                return
            if status == 2:
                raise SpiderJobError("External web crawl job failed")
            if status == 3:
                raise SpiderJobError("External web crawl job timed out")
            await asyncio.sleep(_POLL_INTERVAL_SECONDS)

    async def _get_status(self, client: httpx.AsyncClient, run_id: str) -> int:
        payload = await self._get_json(
            client,
            f"{_QUEUE_BASE_URL}/get_run",
            params={"run_id": run_id},
        )
        if payload.get("code") != 0:
            raise SpiderJobError(
                self._error_message(payload, "Spider status query failed")
            )
        result = payload.get("result")
        row = result.get("row") if isinstance(result, dict) else None
        if not isinstance(row, dict):
            raise SpiderJobError("Spider status row is missing")
        status = row.get("result")
        if not isinstance(status, int) or isinstance(status, bool):
            raise SpiderJobError(f"Invalid spider job status: {status}")
        if status not in {0, 1, 2, 3}:
            raise SpiderJobError(f"Unknown spider job status: {status}")
        return status

    async def _get_result(
        self,
        client: httpx.AsyncClient,
        run_id: str,
    ) -> list[dict[str, Any]]:
        payload = await self._get_json(
            client,
            f"{_QUEUE_BASE_URL}/get_result",
            params={"run_id": run_id},
        )
        if payload.get("code") != 0:
            raise SpiderJobError(
                self._error_message(payload, "External web crawl result query failed")
            )
        result = payload.get("result")
        rows = result.get("rows") if isinstance(result, dict) else None
        if not isinstance(rows, list):
            raise SpiderJobError("External web crawl result rows are missing")
        if not all(isinstance(row, dict) for row in rows):
            raise SpiderJobError("External web crawl result rows are invalid")
        logger.info(
            "[WEB_CONTENT_SPIDER] result received run_id=%s row_count=%s",
            run_id,
            len(rows),
        )
        return rows

    async def _get_json(
        self,
        client: httpx.AsyncClient,
        url: str,
        *,
        params: dict[str, str],
    ) -> dict[str, Any]:
        response = await client.get(url, params=params)
        response.raise_for_status()
        try:
            payload = response.json()
        except ValueError as exc:
            raise SpiderJobError("Spider API returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise SpiderJobError("Spider API returned an invalid response")
        return payload

    def _error_message(self, payload: dict[str, Any], fallback: str) -> str:
        description = payload.get("desc")
        return str(description).strip() if description else fallback


spider_job_client = SpiderJobClient()

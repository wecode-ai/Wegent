# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Low-cardinality metrics and structured logs for Skill downloads."""

import logging
import re
import threading
import time
from dataclasses import dataclass
from urllib.parse import quote

from fastapi import Request, Response
from prometheus_client import Counter, Gauge, Histogram

logger = logging.getLogger(__name__)

_SKILL_DOWNLOAD_PATH = re.compile(
    r"^/api/v1/kinds/skills/(?:public/)?(?P<skill_id>\d+)/download$"
)
_INFLIGHT_LOCK = threading.Lock()
_inflight = 0

SKILL_DOWNLOADS_TOTAL = Counter(
    "backend_skill_downloads_total",
    "Backend Skill download responses",
    ["cache_source", "result", "status"],
)
SKILL_DOWNLOAD_DURATION_SECONDS = Histogram(
    "backend_skill_download_duration_seconds",
    "Time spent resolving a Skill archive and preparing its response",
    ["cache_source", "result"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
)
SKILL_DOWNLOAD_BYTES_TOTAL = Counter(
    "backend_skill_download_bytes_total",
    "Bytes returned by Backend Skill download responses",
    ["cache_source", "result"],
)
SKILL_DOWNLOAD_INFLIGHT = Gauge(
    "backend_skill_download_inflight",
    "Skill download requests currently executing in this Backend process",
)


@dataclass(frozen=True)
class SkillDownloadMetadata:
    """Response metadata populated by a Skill download endpoint."""

    skill_name: str = "unknown"
    cache_source: str = "none"
    bytes_count: int = 0


class SkillDownloadObservation:
    """One Backend Skill download request observed by the HTTP middleware."""

    def __init__(self, skill_id: str) -> None:
        global _inflight

        self.skill_id = skill_id
        self.started_at = time.perf_counter()
        self._finished = False
        with _INFLIGHT_LOCK:
            _inflight += 1
            self.inflight = _inflight
            SKILL_DOWNLOAD_INFLIGHT.set(_inflight)

    def finish(
        self,
        *,
        metadata: SkillDownloadMetadata,
        status_code: int,
        request_id: str,
        result: str | None = None,
    ) -> float:
        """Record exactly one completion and return elapsed milliseconds."""
        global _inflight

        if self._finished:
            return (time.perf_counter() - self.started_at) * 1000
        self._finished = True
        duration_seconds = max(0.0, time.perf_counter() - self.started_at)
        observed_result = result or _result_for_status(status_code)
        status = str(status_code)
        bytes_count = max(0, metadata.bytes_count)

        duration_ms = duration_seconds * 1000
        try:
            SKILL_DOWNLOADS_TOTAL.labels(
                cache_source=metadata.cache_source,
                result=observed_result,
                status=status,
            ).inc()
            SKILL_DOWNLOAD_DURATION_SECONDS.labels(
                cache_source=metadata.cache_source,
                result=observed_result,
            ).observe(duration_seconds)
            SKILL_DOWNLOAD_BYTES_TOTAL.labels(
                cache_source=metadata.cache_source,
                result=observed_result,
            ).inc(bytes_count)

            logger.info(
                "skill download observed component=backend skill_id=%s skill_name=%s "
                "cache_source=%s bytes=%s duration_ms=%.2f result=%s inflight=%s "
                "status=%s request_id=%s",
                self.skill_id,
                metadata.skill_name,
                metadata.cache_source,
                bytes_count,
                duration_ms,
                observed_result,
                self.inflight,
                status,
                request_id,
            )
        except Exception:
            logger.exception(
                "Failed to record Skill download observation: skill_id=%s",
                self.skill_id,
            )
        finally:
            with _INFLIGHT_LOCK:
                _inflight = max(0, _inflight - 1)
                SKILL_DOWNLOAD_INFLIGHT.set(_inflight)
        return duration_ms


def begin_skill_download(path: str) -> SkillDownloadObservation | None:
    """Start observation when *path* is a Skill archive download route."""
    match = _SKILL_DOWNLOAD_PATH.fullmatch(path)
    if match is None:
        return None
    return SkillDownloadObservation(match.group("skill_id"))


def set_skill_download_metadata(
    request: Request,
    *,
    skill_name: str,
    cache_source: str,
    bytes_count: int,
) -> None:
    """Attach non-sensitive endpoint metadata for the request middleware."""
    request.state.skill_download_metadata = SkillDownloadMetadata(
        skill_name=skill_name,
        cache_source=cache_source,
        bytes_count=max(0, bytes_count),
    )


def get_skill_download_metadata(request: Request) -> SkillDownloadMetadata:
    metadata = getattr(request.state, "skill_download_metadata", None)
    return (
        metadata
        if isinstance(metadata, SkillDownloadMetadata)
        else SkillDownloadMetadata()
    )


def add_skill_download_headers(
    response: Response,
    *,
    observation: SkillDownloadObservation,
    metadata: SkillDownloadMetadata,
    backend_time_ms: float,
) -> None:
    """Expose safe correlation data to an API gateway and Executor."""
    response.headers["X-Wegent-Skill-Id"] = observation.skill_id
    response.headers["X-Wegent-Skill-Name"] = quote(metadata.skill_name, safe="")
    response.headers["X-Wegent-Skill-Cache-Source"] = metadata.cache_source
    response.headers["X-Wegent-Skill-Bytes"] = str(max(0, metadata.bytes_count))
    response.headers["X-Wegent-Backend-Time-Ms"] = f"{max(0.0, backend_time_ms):.2f}"


def _result_for_status(status_code: int) -> str:
    if status_code == 304:
        return "not_modified"
    if 200 <= status_code < 300:
        return "success"
    return "http_error"

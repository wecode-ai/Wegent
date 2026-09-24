# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for /api/v1/responses request metrics instrumentation."""

from functools import wraps

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from app.api.endpoints.openapi_responses import (
    _CREATE_RESPONSE_METRICS,
    _RESPONSE_DETAIL_METRICS,
)
from shared.metrics import get_registry, track_api
from shared.metrics.metric import MetricType


def _snapshot(name: str):
    return get_registry().register(name, MetricType.API).snapshot()


class TestTrackApi:
    @pytest.mark.asyncio
    async def test_records_success_status_class(self):
        @track_api(_CREATE_RESPONSE_METRICS)
        async def handler():
            return {"ok": True}

        before = _snapshot("/api/v1/responses_2xx").total
        await handler()
        assert _snapshot("/api/v1/responses_2xx").total == before + 1

    @pytest.mark.asyncio
    async def test_records_http_exception_status_class(self):
        @track_api(_RESPONSE_DETAIL_METRICS)
        async def handler():
            raise HTTPException(status_code=404, detail="not found")

        before = _snapshot("/api/v1/responses/:response_id_4xx").total
        with pytest.raises(HTTPException):
            await handler()
        snapshot = _snapshot("/api/v1/responses/:response_id_4xx")
        assert snapshot.total == before + 1
        assert snapshot.failure >= 1

    @pytest.mark.asyncio
    async def test_records_unexpected_error_as_5xx(self):
        @track_api(_RESPONSE_DETAIL_METRICS)
        async def handler():
            raise RuntimeError("boom")

        before = _snapshot("/api/v1/responses/:response_id_5xx").total
        with pytest.raises(RuntimeError):
            await handler()
        assert _snapshot("/api/v1/responses/:response_id_5xx").total == before + 1

    @pytest.mark.asyncio
    async def test_streaming_response_counts_as_2xx(self):
        @track_api(_CREATE_RESPONSE_METRICS)
        async def handler():
            return StreamingResponse(iter([b"data"]), media_type="text/event-stream")

        before = _snapshot("/api/v1/responses_2xx").total
        await handler()
        assert _snapshot("/api/v1/responses_2xx").total == before + 1

    @pytest.mark.asyncio
    async def test_rate_limit_429_is_recorded_when_track_api_wraps_limiter(self):
        """The metrics decorator must sit outside the rate limiter.

        slowapi raises before the handler runs, so the 429 is only recorded
        when ``track_api`` wraps the limiter, not the other way around.
        """

        def fake_limiter(func):
            @wraps(func)
            async def wrapper(*args, **kwargs):
                raise HTTPException(status_code=429, detail="rate limited")

            return wrapper

        @track_api(_CREATE_RESPONSE_METRICS)
        @fake_limiter
        async def handler():
            return {"ok": True}

        before = _snapshot("/api/v1/responses_4xx").total
        with pytest.raises(HTTPException):
            await handler()
        assert _snapshot("/api/v1/responses_4xx").total == before + 1


class TestFastApiIntegration:
    def test_decorated_route_keeps_query_params_and_dependencies(self):
        """The decorator must stay transparent to FastAPI's signature binding."""
        from fastapi import APIRouter, Depends, FastAPI
        from fastapi.testclient import TestClient

        def dependency() -> str:
            return "injected"

        app = FastAPI()
        router = APIRouter()

        @router.get("/test/{item_id}")
        @track_api(_RESPONSE_DETAIL_METRICS)
        async def read_item(
            item_id: str, limit: int = 5, value: str = Depends(dependency)
        ):
            return {"item_id": item_id, "limit": limit, "value": value}

        app.include_router(router)
        response = TestClient(app).get("/test/abc?limit=7")

        assert response.status_code == 200
        assert response.json() == {"item_id": "abc", "limit": 7, "value": "injected"}
        assert _snapshot("/api/v1/responses/:response_id_2xx").total > 0

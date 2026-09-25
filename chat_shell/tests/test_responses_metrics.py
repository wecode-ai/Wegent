# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Focused tests for chat_shell /v1/responses metrics instrumentation."""

import pytest
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from chat_shell.api.v1.response import (
    _RESPONSES_CANCEL_METRICS,
    _RESPONSES_CREATE_METRICS,
)
from shared.metrics import get_registry, track_api
from shared.metrics.metric import MetricType


def _total(name: str) -> int:
    return get_registry().register(name, MetricType.API).snapshot().total


class TestResponsesMetrics:
    async def test_create_records_2xx(self):
        @track_api(_RESPONSES_CREATE_METRICS)
        async def handler():
            return StreamingResponse(iter([b"data"]), media_type="text/event-stream")

        before = _total("/v1/responses_2xx")
        await handler()
        assert _total("/v1/responses_2xx") == before + 1

    async def test_cancel_records_404(self):
        @track_api(_RESPONSES_CANCEL_METRICS)
        async def handler():
            raise HTTPException(status_code=404, detail="not found")

        before = _total("/v1/responses/cancel_4xx")
        with pytest.raises(HTTPException):
            await handler()
        assert _total("/v1/responses/cancel_4xx") == before + 1

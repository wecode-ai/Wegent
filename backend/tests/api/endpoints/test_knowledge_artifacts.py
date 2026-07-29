# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import logging

import pytest
from fastapi import HTTPException

from app.api.endpoints.knowledge_artifacts import _execute


@pytest.mark.asyncio
async def test_execute_logs_unexpected_runtime_failure(caplog):
    async def fail():
        raise RuntimeError("executor unavailable")

    with (
        caplog.at_level(
            logging.ERROR,
            logger="app.api.endpoints.knowledge_artifacts",
        ),
        pytest.raises(HTTPException) as exc_info,
    ):
        await _execute(fail)

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == "Artifact generation is unavailable"
    assert "Unexpected runtime failure" in caplog.text
    assert "executor unavailable" in caplog.text

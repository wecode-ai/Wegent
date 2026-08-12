# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""E2B sandbox creation error propagation tests."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from executor_manager.routers import e2b


@pytest.mark.asyncio
async def test_create_sandbox_surfaces_skill_readiness_failure(sample_sandbox, mocker):
    """The SDK must receive an explicit error when required Skills are missing."""
    manager = SimpleNamespace(
        create_sandbox=AsyncMock(
            return_value=(
                sample_sandbox,
                "required Skill deployment failed: abtest-file-analyzer",
            )
        )
    )
    mocker.patch.object(e2b, "get_sandbox_manager", return_value=manager)
    http_request = SimpleNamespace(
        client=SimpleNamespace(host="127.0.0.1"),
        url=SimpleNamespace(scheme="http"),
        headers={"host": "localhost"},
    )
    request = e2b.CreateSandboxRequest(
        templateId="ClaudeCode",
        metadata={"task_id": "12345"},
    )

    with pytest.raises(HTTPException) as exc_info:
        await e2b.create_sandbox(request, http_request)

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == {
        "code": "sandbox_not_ready",
        "message": "required Skill deployment failed: abtest-file-analyzer",
    }

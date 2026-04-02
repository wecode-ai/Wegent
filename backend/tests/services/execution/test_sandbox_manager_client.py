# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the sandbox manager HTTP client."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.execution import get_sandbox_manager


@pytest.mark.asyncio
async def test_create_sandbox_uses_plural_sandboxes_endpoint():
    """Sandbox creation should call the plural sandboxes endpoint."""
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "sandbox_id": "1385",
        "container_name": "wegent-task-test",
        "base_url": "http://127.0.0.1:10001",
    }

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post.return_value = response

    with (
        patch(
            "app.core.config.settings",
            SimpleNamespace(EXECUTOR_MANAGER_URL="http://localhost:8001"),
        ),
        patch("httpx.AsyncClient", return_value=client),
    ):
        sandbox, error = await get_sandbox_manager().create_sandbox(
            shell_type="ClaudeCode",
            user_id=2,
            user_name="yunpeng7",
        )

    assert error is None
    assert sandbox.sandbox_id == "1385"
    client.post.assert_awaited_once()
    assert (
        client.post.await_args.args[0]
        == "http://localhost:8001/executor-manager/sandboxes"
    )

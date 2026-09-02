# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

import pytest

from app.services.execution import runtime_projection


@pytest.mark.asyncio
async def test_projected_workflow_uses_scalar_nonblocking_entry(monkeypatch) -> None:
    continue_stages = AsyncMock(return_value=2)
    monkeypatch.setattr(
        runtime_projection.issue_workflow_start_service,
        "continue_ready_stages_nonblocking",
        continue_stages,
    )

    await runtime_projection.continue_projected_workflow(
        {
            "item_id": "issue-1",
            "user_id": 7,
            "stage_ids": ["verify", "build"],
        }
    )

    continue_stages.assert_awaited_once_with(
        item_id="issue-1",
        user_id=7,
        stage_ids={"build", "verify"},
    )


@pytest.mark.asyncio
async def test_projected_workflow_skips_empty_continuation(monkeypatch) -> None:
    continue_stages = AsyncMock()
    monkeypatch.setattr(
        runtime_projection.issue_workflow_start_service,
        "continue_ready_stages_nonblocking",
        continue_stages,
    )

    await runtime_projection.continue_projected_workflow(
        {"item_id": "issue-1", "user_id": 7, "stage_ids": []}
    )

    continue_stages.assert_not_awaited()

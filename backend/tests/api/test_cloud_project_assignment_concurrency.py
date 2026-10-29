# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Blocking assignment work must leave the API event loop available."""

import asyncio
from threading import Event
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from httpx import ASGITransport, AsyncClient

from app.api.endpoints import cloud_projects
from app.models.user import User


@pytest.mark.asyncio
@pytest.mark.parametrize("external", [False, True])
async def test_assignment_lock_wait_does_not_block_other_requests(
    external: bool, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = FastAPI()
    app.include_router(cloud_projects.router, prefix="/api/v1/cloud-projects")
    app.dependency_overrides[cloud_projects.get_db] = lambda: Mock()
    app.dependency_overrides[cloud_projects.get_current_user] = lambda: User(id=1)
    started = Event()
    released = Event()

    def waiting_assignment(*_args: object, **_kwargs: object) -> None:
        started.set()
        # Model a synchronous database wait. Only another HTTP request can release it.
        if not released.wait(timeout=2):
            raise HTTPException(503, "Assignment blocked the API event loop")
        raise HTTPException(422, "Assignee is not a member of this project")

    monkeypatch.setattr(
        cloud_projects.external_loop_item_provider,
        "is_external_item",
        lambda *_args: external,
    )
    service = (
        cloud_projects.external_loop_item_provider
        if external
        else cloud_projects.loop_item_service
    )
    monkeypatch.setattr(service, "assign", waiting_assignment)

    @app.post("/release-database-lock")
    async def release_database_lock() -> dict[str, bool]:
        released.set()
        return {"released": True}

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        assignment = asyncio.create_task(
            client.post(
                "/api/v1/cloud-projects/11/loop-items/ISSUE-1/assign",
                json={"version": 1, "assignee_type": "user", "assignee_id": "2"},
            )
        )
        try:
            assert await asyncio.to_thread(started.wait, 2)
            response = await client.post("/release-database-lock")
            assert response.status_code == 200
            result = await assignment
            assert result.status_code == 422
            assert result.json() == {
                "detail": "Assignee is not a member of this project"
            }
        finally:
            released.set()
            await assignment

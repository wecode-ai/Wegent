# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Slow resource discovery must not stall unrelated collaboration requests."""

import asyncio
import threading
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import event
from sqlalchemy.orm import Session

from app.api.endpoints import cloud_projects, workspaces
from app.models.delivery import CloudProject
from app.models.user import User
from app.services.execution import team_readiness
from tests.utils.agent_resources import create_runnable_wegent_team
from tests.utils.collaboration import authorize_project


@dataclass(frozen=True)
class ResourceApp:
    app: FastAPI
    project_id: int
    team_id: int
    session_closed: threading.Event


@pytest.fixture
def resource_app(test_db: Session, test_user: User) -> ResourceApp:
    team = create_runnable_wegent_team(
        test_db, user_id=test_user.id, name_prefix="slow-resource"
    )
    key = uuid.uuid4().hex
    project = CloudProject(
        public_id=key,
        project_key=key[:12],
        name="Concurrent board",
        created_by_user_id=test_user.id,
        storage_prefix=key,
    )
    authorize_project(test_db, project)
    test_db.commit()
    app = FastAPI()
    app.include_router(workspaces.resources_router, prefix="/api/v1/resources")
    app.include_router(cloud_projects.router, prefix="/api/v1/cloud-projects")

    session_closed = threading.Event()

    def database() -> Iterator[Session]:
        try:
            with Session(bind=test_db.get_bind()) as db:
                yield db
        finally:
            session_closed.set()

    app.dependency_overrides[workspaces.get_db] = database
    app.dependency_overrides[workspaces.get_current_user_jwt_apikey_tasktoken] = (
        lambda: test_user
    )
    app.dependency_overrides[cloud_projects.get_current_user] = lambda: test_user
    return ResourceApp(app, project.id, team.id, session_closed)


def _block_readiness(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[asyncio.Event, threading.Event, threading.Event]:
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    started = asyncio.Event()
    release = threading.Event()
    finished = threading.Event()
    original_validate = team_readiness.validate_team_execution_readiness

    def slow_validate(*args, **kwargs) -> None:
        assert threading.get_ident() != loop_thread
        loop.call_soon_threadsafe(started.set)
        assert release.wait(timeout=5), "Test did not release readiness validation"
        try:
            original_validate(*args, **kwargs)
        finally:
            finished.set()

    async def online_statuses(keys):
        assert threading.get_ident() == loop_thread
        return {}

    monkeypatch.setattr(
        team_readiness, "validate_team_execution_readiness", slow_validate
    )
    monkeypatch.setattr(
        "app.core.cache.cache_manager.mget_or_raise",
        AsyncMock(side_effect=online_statuses),
    )
    return started, release, finished


async def _wait_for_readiness(
    resources: asyncio.Task[httpx.Response], started: asyncio.Event
) -> None:
    waiting = asyncio.create_task(started.wait())
    try:
        done, _ = await asyncio.wait(
            [resources, waiting], timeout=5, return_when=asyncio.FIRST_COMPLETED
        )
        if resources in done:
            await resources
            pytest.fail("Resource discovery finished before readiness was released")
        assert waiting in done
    finally:
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)


async def test_slow_personal_agent_readiness_does_not_block_board(
    resource_app: ResourceApp, test_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    started, release, _ = _block_readiness(monkeypatch)
    loop_thread = threading.get_ident()
    sql_threads: list[int] = []

    def record_sql(*args) -> None:
        sql_threads.append(threading.get_ident())

    connection = test_db.get_bind()
    event.listen(connection, "before_cursor_execute", record_sql)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=resource_app.app), base_url="http://test"
    ) as client:
        resources = asyncio.create_task(client.get("/api/v1/resources"))
        try:
            await _wait_for_readiness(resources, started)
            assert sql_threads and loop_thread not in sql_threads
            board = await asyncio.wait_for(
                client.get(
                    f"/api/v1/cloud-projects/{resource_app.project_id}/board-snapshot"
                ),
                timeout=5,
            )
            assert board.status_code == 200, board.text
            assert board.json()["items"] == []
            assert not resources.done()
        finally:
            release.set()
            try:
                response = await asyncio.wait_for(resources, timeout=5)
            finally:
                event.remove(connection, "before_cursor_execute", record_sql)

    assert response.status_code == 200
    assert (
        next(
            agent
            for agent in response.json()["agents"]
            if agent["team_id"] == resource_app.team_id
        )["status"]
        == "available"
    )


async def test_cancelled_resource_request_waits_before_session_cleanup(
    resource_app: ResourceApp, monkeypatch: pytest.MonkeyPatch
) -> None:
    started, release, finished = _block_readiness(monkeypatch)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=resource_app.app), base_url="http://test"
    ) as client:
        resources = asyncio.create_task(client.get("/api/v1/resources"))
        try:
            await _wait_for_readiness(resources, started)
            resources.cancel()
            await asyncio.sleep(0)
            assert not resources.done()
            assert not resource_app.session_closed.is_set()
        finally:
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(resources, timeout=5)

    assert finished.is_set()
    assert resource_app.session_closed.is_set()

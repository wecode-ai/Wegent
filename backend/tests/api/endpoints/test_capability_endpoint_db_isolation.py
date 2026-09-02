# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import pytest
from sqlalchemy.orm import sessionmaker

from app.api.endpoints import installed_mcps
from app.core.bounded_executor import BoundedExecutorOverloaded
from app.db import session as db_session
from app.models.kind import Kind
from app.schemas.installed_mcp import (
    InstalledMCPCustomCreateRequest,
    InstalledMCPListResponse,
    InstalledMCPServerConfig,
)
from app.services.device.capability_sync_service import DeviceCapabilitySyncService


@pytest.fixture(autouse=True)
def worker_session_factory(test_db, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        db_session,
        "SessionLocal",
        sessionmaker(
            bind=test_db.get_bind(),
            expire_on_commit=False,
            join_transaction_mode="create_savepoint",
        ),
    )


async def _wait_for_thread(event: threading.Event) -> None:
    for _ in range(200):
        if event.is_set():
            return
        await asyncio.sleep(0.005)
    raise TimeoutError("database worker did not start")


@pytest.mark.asyncio
async def test_blocked_capability_db_phase_does_not_block_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()

    def blocked_list(_user_id: int) -> InstalledMCPListResponse:
        started.set()
        release.wait(timeout=5)
        return InstalledMCPListResponse(items=[])

    monkeypatch.setattr(
        installed_mcps.installed_mcp_service,
        "list_installed_mcps_for_user",
        blocked_list,
    )
    task = asyncio.create_task(
        installed_mcps.list_installed_mcps(current_user=SimpleNamespace(id=7))
    )
    await _wait_for_thread(started)

    loop_progressed = asyncio.Event()
    asyncio.get_running_loop().call_soon(loop_progressed.set)
    await asyncio.wait_for(loop_progressed.wait(), timeout=0.2)
    assert not task.done()

    release.set()
    response = await task
    assert response.items == []


@pytest.mark.asyncio
async def test_device_transport_starts_after_worker_session_closes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_closed = threading.Event()

    class TrackingSession:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, traceback) -> None:
            session_closed.set()

    service = DeviceCapabilitySyncService(session_factory=TrackingSession)
    monkeypatch.setattr(
        service,
        "resolve_payload",
        lambda *_args, **_kwargs: {"mode": "merge", "skills": []},
    )

    async def dispatch(**_kwargs):
        assert session_closed.is_set()
        return SimpleNamespace(success=True)

    monkeypatch.setattr(service, "_dispatch_payload_or_raise", dispatch)
    monkeypatch.setattr(
        service,
        "_aggregate_response",
        lambda *_args, **_kwargs: "detached-response",
    )

    result = await service.sync_device_capabilities(
        user_id=9,
        device_id="device-a",
        skill_ids=[],
    )

    assert result == "detached-response"


@pytest.mark.asyncio
async def test_mcp_commit_survives_device_sync_fault(
    test_db,
    test_user,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def failed_sync(**_kwargs):
        raise RuntimeError("injected transport failure")

    monkeypatch.setattr(
        installed_mcps.device_capability_sync_service,
        "sync_user_global_capabilities",
        failed_sync,
    )

    created = await installed_mcps.create_custom_mcp(
        request=InstalledMCPCustomCreateRequest(
            name="fault-injected-mcp",
            displayName="Fault Injected",
            server=InstalledMCPServerConfig(
                type="streamable-http",
                url="https://mcp.example.com/fault",
            ),
        ),
        current_user=test_user,
    )

    installed_id = int(created.metadata["labels"]["id"])
    test_db.expire_all()
    row = test_db.query(Kind).filter(Kind.id == installed_id).one()
    assert row.name == "fault-injected-mcp"
    assert row.is_active is True


@pytest.mark.asyncio
async def test_db_capacity_rejection_prevents_mcp_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mutation_called = False

    async def reject(*_args, **_kwargs):
        raise BoundedExecutorOverloaded("injected capacity exhaustion")

    def mutation(*_args, **_kwargs):
        nonlocal mutation_called
        mutation_called = True

    monkeypatch.setattr(installed_mcps, "run_sync_in_executor", reject)
    monkeypatch.setattr(
        installed_mcps.installed_mcp_service,
        "create_custom_mcp_for_user",
        mutation,
    )

    with pytest.raises(BoundedExecutorOverloaded):
        await installed_mcps.create_custom_mcp(
            request=InstalledMCPCustomCreateRequest(
                name="capacity-rejected",
                displayName="Capacity Rejected",
                server=InstalledMCPServerConfig(
                    type="streamable-http",
                    url="https://mcp.example.com/capacity",
                ),
            ),
            current_user=SimpleNamespace(id=10),
        )

    assert mutation_called is False

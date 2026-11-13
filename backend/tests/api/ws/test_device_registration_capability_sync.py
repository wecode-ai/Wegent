# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Registration keeps Skills/MCP sync independent of plugin write failures."""

import asyncio
import threading
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.api.ws import device_namespace
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from app.services.plugin_write_errors import PluginWriteError

PLUGIN_WRITE_ERRORS = (
    "plugin_write_busy",
    "plugin_write_unavailable",
    "plugin_write_lease_lost",
    "plugin_write_conflict",
)


@pytest.fixture
def registration_sync(monkeypatch):
    """Use the real desired-state builder and session rollback/close boundary."""
    events = []
    session_threads = []
    failure = {"stage": None, "error": None}

    def fail_once(stage):
        events.append(stage)
        if failure["stage"] == stage:
            failure["stage"] = None
            raise failure["error"]

    class RegistrationSession:
        def __init__(self):
            self.threads = [threading.get_ident()]
            session_threads.append(self.threads)

        def commit(self):
            self.threads.append(threading.get_ident())
            fail_once("commit")

        def rollback(self):
            self.threads.append(threading.get_ident())
            events.append("rollback")

        def close(self):
            self.threads.append(threading.get_ident())
            events.append("close")

    monkeypatch.setattr(device_namespace, "SessionLocal", RegistrationSession)
    monkeypatch.setattr(device_namespace, "configure_plugin_session", Mock())
    catalog = Mock(side_effect=lambda *args, **kwargs: fail_once("catalog"))
    pending = Mock(side_effect=lambda *args, **kwargs: fail_once("pending"))
    record = Mock(side_effect=lambda *args, **kwargs: events.append("record"))
    monkeypatch.setattr(
        device_namespace.plugin_marketplace_service,
        "reconcile_stale_installed_catalog_refs",
        catalog,
    )
    monkeypatch.setattr(
        device_namespace.plugin_device_installation_service,
        "ensure_pending_for_device",
        pending,
    )
    monkeypatch.setattr(
        device_namespace.plugin_device_installation_service,
        "record_device_sync_result",
        record,
    )

    service = DeviceCapabilitySyncService(session_factory=lambda: nullcontext(object()))
    monkeypatch.setattr(service, "supports_plugin_delta", AsyncMock(return_value=False))
    skills = [{"name": "registered-skill", "installed_skill_id": 11}]
    mcps = [{"name": "registered-mcp", "installed_mcp_id": 12}]
    plugins = [{"name": "registered-plugin", "installed_plugin_id": 13}]
    skill_loader = Mock(return_value=skills)
    mcp_loader = Mock(return_value=mcps)
    plugin_loader = Mock(return_value=plugins)
    monkeypatch.setattr(service, "_load_enabled_installed_skills", skill_loader)
    monkeypatch.setattr(service, "_load_enabled_installed_mcps", mcp_loader)
    monkeypatch.setattr(service, "_load_installed_plugins", plugin_loader)

    async def dispatch(**kwargs):
        # Neither an open prep transaction nor its plugin lease reaches dispatch.
        assert events[-1] == "close"
        events.append("dispatch")
        return DeviceCapabilitySyncResult(
            device_id=kwargs["device_id"], success=True, acknowledged=True
        )

    dispatch_mock = AsyncMock(side_effect=dispatch)
    monkeypatch.setattr(service, "sync_device_payload", dispatch_mock)
    monkeypatch.setattr(device_namespace, "device_capability_sync_service", service)
    return SimpleNamespace(
        namespace=device_namespace.DeviceNamespace(),
        events=events,
        session_threads=session_threads,
        failure=failure,
        catalog=catalog,
        pending=pending,
        record=record,
        dispatch=dispatch_mock,
        plugin_loader=plugin_loader,
        skill_loader=skill_loader,
        mcp_loader=mcp_loader,
        skills=skills,
        mcps=mcps,
        plugins=plugins,
    )


async def _sync(rig):
    await rig.namespace._sync_global_capabilities_to_registered_device(
        user_id=7, device_id="registered-device"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ("catalog", "record"))
async def test_plugin_registration_waits_do_not_block_event_loop(
    registration_sync, stage
):
    rig = registration_sync
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    started = asyncio.Event()
    release = threading.Event()

    def wait_for_release(*args, **kwargs):
        rig.events.append(stage)
        loop.call_soon_threadsafe(started.set)
        assert threading.get_ident() != loop_thread
        assert release.wait(timeout=5), "Test did not release the database operation"

    getattr(rig, stage).side_effect = wait_for_release
    sync_task = asyncio.create_task(_sync(rig))
    try:
        await asyncio.wait_for(started.wait(), timeout=5)
        # The event loop observed the worker while its database call is blocked.
        assert not release.is_set()
        assert not sync_task.done()
    finally:
        release.set()
        await asyncio.wait_for(sync_task, timeout=5)

    rig.dispatch.assert_awaited_once()
    rig.record.assert_called_once()
    assert len(rig.session_threads) == 2
    assert all(
        len(set(threads)) == 1 and threads[0] != loop_thread
        for threads in rig.session_threads
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ("catalog", "pending", "commit"))
@pytest.mark.parametrize("code", PLUGIN_WRITE_ERRORS)
async def test_plugin_prep_failure_syncs_skills_mcps_only(
    registration_sync, stage, code
):
    rig = registration_sync
    rig.failure.update(stage=stage, error=PluginWriteError(code))

    await _sync(rig)

    rig.dispatch.assert_awaited_once()
    assert rig.dispatch.call_args.kwargs["payload"] == {
        "mode": "merge",
        "skills": rig.skills,
        "mcps": rig.mcps,
    }
    assert rig.events[-3:] == ["rollback", "close", "dispatch"]
    rig.plugin_loader.assert_not_called()
    rig.record.assert_not_called()
    assert rig.skill_loader.call_count == 2
    assert rig.mcp_loader.call_count == 2
    if stage == "catalog":
        rig.pending.assert_not_called()


@pytest.mark.asyncio
async def test_next_successful_registration_restores_full_replace(registration_sync):
    rig = registration_sync
    rig.failure.update(stage="commit", error=PluginWriteError("plugin_write_conflict"))
    await _sync(rig)

    await _sync(rig)

    assert rig.dispatch.await_count == 2
    assert rig.dispatch.call_args_list[0].kwargs["payload"]["mode"] == "merge"
    assert "plugins" not in rig.dispatch.call_args_list[0].kwargs["payload"]
    assert rig.dispatch.call_args_list[1].kwargs["payload"] == {
        "mode": "replace",
        "skills": rig.skills,
        "mcps": rig.mcps,
        "plugins": rig.plugins,
    }
    rig.record.assert_called_once()
    assert rig.plugin_loader.call_count == 2


@pytest.mark.asyncio
async def test_successful_registration_keeps_full_sync_and_records_ack(
    registration_sync,
):
    rig = registration_sync

    await _sync(rig)

    rig.dispatch.assert_awaited_once()
    payload = rig.dispatch.call_args.kwargs["payload"]
    assert payload == {
        "mode": "replace",
        "skills": rig.skills,
        "mcps": rig.mcps,
        "plugins": rig.plugins,
    }
    rig.record.assert_called_once()
    assert rig.events == [
        "catalog",
        "pending",
        "commit",
        "close",
        "dispatch",
        "record",
        "commit",
        "close",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("code", PLUGIN_WRITE_ERRORS)
async def test_plugin_ack_persistence_failure_never_resends_sync(
    registration_sync, code
):
    rig = registration_sync
    rig.record.side_effect = PluginWriteError(code)

    await _sync(rig)

    rig.dispatch.assert_awaited_once()
    assert rig.dispatch.call_args.kwargs["payload"]["mode"] == "replace"
    rig.record.assert_called_once()
    assert rig.events[-2:] == ["rollback", "close"]


@pytest.mark.asyncio
async def test_unrelated_prep_error_is_not_treated_as_plugin_contention(
    registration_sync,
):
    rig = registration_sync
    rig.failure.update(
        stage="catalog", error=RuntimeError("unrelated database failure")
    )

    await _sync(rig)

    rig.dispatch.assert_not_awaited()
    rig.record.assert_not_called()
    assert rig.events[-2:] == ["rollback", "close"]

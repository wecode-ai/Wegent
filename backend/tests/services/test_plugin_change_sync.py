# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import asyncio
from contextlib import nullcontext
from copy import deepcopy
from unittest.mock import AsyncMock, Mock

import pytest

from app.models.kind import Kind
from app.schemas.device import DeviceCapabilitySyncResult
from app.services.device.capability_sync_service import DeviceCapabilitySyncService
from app.services.device.plugin_change_sync import (
    build_plugin_delta,
    dispatch_snapshot,
    sync_changed_plugin_to_devices,
    sync_plugin_change,
    sync_selected_capabilities,
    validate_ack,
)


def _payload(generation=7, *, removed=False, complete=False):
    plugin = {
        "installed_plugin_id": 123,
        "name": "example",
        "marketplace": "test-marketplace",
    }
    if not removed:
        plugin.update(
            version="1.0.0", checksum="sha256:" + "a" * 64, download_path="signed-1"
        )
    return {
        "mode": "merge",
        "scope": "plugins" if complete else "plugin_delta",
        "plugins": [] if removed else [plugin],
        "removed_plugins": [plugin] if removed else [],
        "plugin_sync": {"version": 2, "generation": generation, "complete": complete},
    }


def _ack(payload):
    generation = payload["plugin_sync"]["generation"]
    items = [
        {
            "id": item["installed_plugin_id"],
            "generation": generation,
            "operation": "upsert",
            "status": "synced",
            "version": item.get("version"),
            "checksum": item.get("checksum"),
        }
        for item in payload.get("plugins", [])
    ] + [
        {
            "id": item["installed_plugin_id"],
            "generation": generation,
            "operation": "remove",
            "status": "removed",
        }
        for item in payload.get("removed_plugins", [])
    ]
    return {
        "success": True,
        "scope": payload.get("scope") or "all",
        "plugin_sync": deepcopy(payload["plugin_sync"]),
        "plugins": items,
    }


def _result(payload, *, success=True):
    return DeviceCapabilitySyncResult(
        device_id="device",
        acknowledged=True,
        desired_plugin_snapshot=payload,
        **{**_ack(payload), "success": success},
    )


@pytest.mark.parametrize("removed", [False, True])
def test_ack_accepts_exact_upsert_and_removal(removed):
    payload = _payload(removed=removed)
    assert validate_ack(payload, _ack(payload)) is None


@pytest.mark.parametrize(
    "field,value,message",
    [
        ("generation", 6, "obsolete"),
        ("version", "0.9.0", "package"),
        ("checksum", "sha256:other", "package"),
        ("operation", "remove", "operation"),
        ("status", "ok", "status"),
    ],
)
def test_ack_rejects_wrong_item_generation_package_or_operation(field, value, message):
    payload = _payload()
    ack = _ack(payload)
    ack["plugins"][0][field] = value
    assert message in validate_ack(payload, ack)


def test_ack_rejects_wrong_envelope_missing_and_duplicate_items():
    payload = _payload()
    wrong_envelope = _ack(payload)
    wrong_envelope["plugin_sync"]["generation"] += 1
    assert "snapshot" in validate_ack(payload, wrong_envelope)
    missing = _ack(payload)
    missing["plugins"] = []
    assert "every requested" in validate_ack(payload, missing)
    duplicated = _ack(payload)
    duplicated["plugins"] *= 2
    assert "unexpected" in validate_ack(payload, duplicated)


@pytest.mark.parametrize("items", [None, {}, [None], ["invalid"]])
def test_ack_rejects_malformed_item_collections(items):
    payload = _payload()
    ack = _ack(payload)
    ack["plugins"] = items
    assert "invalid" in validate_ack(payload, ack)


@pytest.mark.parametrize(
    "field,value", [("version", 2.0), ("generation", 7.0), ("complete", 0)]
)
def test_ack_requires_exact_envelope_field_types(field, value):
    payload = _payload()
    ack = _ack(payload)
    ack["plugin_sync"][field] = value
    assert "snapshot" in validate_ack(payload, ack)


@pytest.mark.parametrize("complete", [False, True])
def test_ack_only_accepts_inferred_removals_for_complete_snapshots(complete):
    payload = _payload(complete=complete)
    ack = _ack(payload)
    ack["plugins"].append(
        {"id": 456, "generation": 7, "operation": "remove", "status": "removed"}
    )
    error = validate_ack(payload, ack)
    assert (error is None) is complete


@pytest.mark.asyncio
async def test_identical_snapshot_waiters_share_rpc_despite_new_signed_urls():
    started = asyncio.Event()
    release = asyncio.Event()

    async def rpc(**kwargs):
        started.set()
        await release.wait()
        return _result(kwargs["payload"])

    service = Mock(sync_device_payload=AsyncMock(side_effect=rpc))
    payload = _payload()
    first = asyncio.create_task(
        dispatch_snapshot(
            service, user_id=1, device_id="device", payload=payload, timeout_seconds=10
        )
    )
    await started.wait()
    renewed = deepcopy(payload)
    renewed["plugins"][0]["download_path"] = "signed-2"
    renewed["plugins"][0]["download_url_expires_at"] = "later"
    second = asyncio.create_task(
        dispatch_snapshot(
            service, user_id=1, device_id="device", payload=renewed, timeout_seconds=10
        )
    )
    await asyncio.sleep(0)
    release.set()
    results = await asyncio.gather(first, second)
    assert service.sync_device_payload.await_count == 1
    assert results[0] is results[1]


@pytest.mark.parametrize("checksum", [None, "sha256:invalid"])
@pytest.mark.asyncio
async def test_different_urls_without_trusted_checksum_never_share_rpc(checksum):
    all_started = asyncio.Event()
    release = asyncio.Event()
    dispatched = []

    async def rpc(**kwargs):
        dispatched.append(kwargs["payload"])
        if len(dispatched) == 2:
            all_started.set()
        await release.wait()
        return _result(kwargs["payload"])

    service = Mock(sync_device_payload=AsyncMock(side_effect=rpc))
    original = _payload()
    original["plugins"][0]["checksum"] = checksum
    changed_url = deepcopy(original)
    changed_url["plugins"][0]["download_path"] = "different-package-url"
    tasks = [
        asyncio.create_task(
            dispatch_snapshot(
                service,
                user_id=1,
                device_id="device",
                payload=payload,
                timeout_seconds=10,
            )
        )
        for payload in (original, changed_url)
    ]
    try:
        await asyncio.wait_for(all_started.wait(), timeout=2)
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert len(dispatched) == 2


@pytest.mark.asyncio
async def test_install_uninstall_reinstall_never_reuses_pre_uninstall_ack():
    all_started = asyncio.Event()
    release = asyncio.Event()
    dispatched = []

    async def rpc(**kwargs):
        payload = kwargs["payload"]
        dispatched.append(payload)
        if len(dispatched) == 3:
            all_started.set()
        await release.wait()
        return _result(payload)

    service = Mock(sync_device_payload=AsyncMock(side_effect=rpc))
    operations = [_payload(1), _payload(2, removed=True), _payload(3)]
    tasks = [
        asyncio.create_task(
            dispatch_snapshot(
                service,
                user_id=1,
                device_id="device",
                payload=payload,
                timeout_seconds=10,
            )
        )
        for payload in operations
    ]
    try:
        await asyncio.wait_for(all_started.wait(), timeout=2)
    finally:
        release.set()
        results = await asyncio.gather(*tasks)
    assert [item["plugin_sync"]["generation"] for item in dispatched] == [1, 2, 3]
    assert [item.plugin_sync.generation for item in results] == [1, 2, 3]


@pytest.mark.asyncio
async def test_failed_dispatch_is_not_cached_and_allows_retry():
    service = Mock(
        sync_device_payload=AsyncMock(
            side_effect=[RuntimeError("transport failed"), _result(_payload())]
        )
    )
    with pytest.raises(RuntimeError, match="transport failed"):
        await dispatch_snapshot(
            service,
            user_id=1,
            device_id="device",
            payload=_payload(),
            timeout_seconds=10,
        )
    recovered = await dispatch_snapshot(
        service, user_id=1, device_id="device", payload=_payload(), timeout_seconds=10
    )
    assert recovered.success is True
    assert service.sync_device_payload.await_count == 2


def test_plugin_delta_only_reads_target_and_emits_fresh_uninstall_intent(
    test_db, test_user
):
    def installed(name):
        row = Kind(
            user_id=test_user.id,
            kind="InstalledPlugin",
            namespace="default",
            name=name,
            json={
                "spec": {
                    "version": "1.0.0",
                    "marketplace": "test",
                    "installState": "installed",
                }
            },
            is_active=True,
        )
        test_db.add(row)
        test_db.commit()
        return row

    target, other = installed("target"), installed("other")
    service = DeviceCapabilitySyncService()
    initial = build_plugin_delta(
        service,
        test_db,
        user_id=test_user.id,
        device_id="device",
        installed_plugin_ids=[target.id],
    )
    target.json = {
        "spec": {"version": "2.0.0", "marketplace": "test", "installState": "installed"}
    }
    test_db.commit()
    updated = build_plugin_delta(
        service,
        test_db,
        user_id=test_user.id,
        device_id="device",
        installed_plugin_ids=[target.id],
    )
    target.is_active = False
    test_db.commit()
    removed = build_plugin_delta(
        service,
        test_db,
        user_id=test_user.id,
        device_id="device",
        installed_plugin_ids=[target.id],
    )
    assert [item["installed_plugin_id"] for item in initial["plugins"]] == [target.id]
    assert initial["plugins"][0]["version"] == "1.0.0"
    assert updated["plugins"][0]["version"] == "2.0.0"
    assert removed["plugins"] == []
    assert [item["installed_plugin_id"] for item in removed["removed_plugins"]] == [
        target.id
    ]
    assert other.is_active is True


@pytest.mark.asyncio
async def test_state_changes_during_rpc_reconcile_only_target_plugin():
    desired = _payload(1)
    service = DeviceCapabilitySyncService()
    sent = []

    async def rpc(**kwargs):
        nonlocal desired
        payload = kwargs["payload"]
        sent.append(payload)
        if len(sent) == 1:
            desired = _payload(2, removed=True)
        return _result(payload)

    service.sync_device_payload = AsyncMock(side_effect=rpc)
    result = await service.sync_latest_device_capabilities(
        user_id=1, device_id="device", load_payload=lambda: deepcopy(desired)
    )
    assert result.success is True
    assert len(sent) == 2
    assert sent[0]["plugins"][0]["installed_plugin_id"] == 123
    assert sent[1]["plugins"] == []
    assert sent[1]["removed_plugins"][0]["installed_plugin_id"] == 123


@pytest.mark.asyncio
async def test_legacy_device_change_retains_existing_full_sync_protocol():
    legacy_result = DeviceCapabilitySyncResult(device_id="legacy", success=True)
    service = Mock(
        supports_plugin_delta=AsyncMock(return_value=False),
        sync_current_device_capabilities=AsyncMock(return_value=legacy_result),
    )
    result = await sync_plugin_change(
        service, user_id=1, device_id="legacy", installed_plugin_ids=[123]
    )
    assert result is legacy_result
    service.sync_current_device_capabilities.assert_awaited_once_with(
        user_id=1, device_id="legacy"
    )


@pytest.mark.asyncio
async def test_new_current_device_does_not_wait_for_old_background_device(monkeypatch):
    from app.services.device import plugin_change_sync as module

    old_started = asyncio.Event()
    release_old = asyncio.Event()

    async def sync_change(**kwargs):
        if kwargs["device_id"] == "legacy":
            old_started.set()
            await release_old.wait()
        return DeviceCapabilitySyncResult(device_id=kwargs["device_id"], success=True)

    service = DeviceCapabilitySyncService()
    service.supports_plugin_delta = AsyncMock(return_value=True)
    service.sync_plugin_change = AsyncMock(side_effect=sync_change)
    request_db, record_db = Mock(), Mock()
    monkeypatch.setattr(
        "app.services.device_service.device_service.get_online_devices",
        AsyncMock(return_value=[{"device_id": "current"}, {"device_id": "legacy"}]),
    )
    monkeypatch.setattr(
        "app.services.plugin_device_identity.plugin_device_id",
        lambda _db, _user, device: device,
    )
    monkeypatch.setattr(module, "get_db_session", lambda: nullcontext(record_db))
    record = Mock()
    monkeypatch.setattr(
        "app.services.plugin_device_installation_service.plugin_device_installation_service.record_device_sync_result",
        record,
    )
    try:
        response = await asyncio.wait_for(
            sync_changed_plugin_to_devices(
                service,
                request_db,
                user_id=1,
                installed_plugin_id=123,
                current_device_id="current",
            ),
            timeout=2,
        )
        await asyncio.wait_for(old_started.wait(), timeout=2)
        assert response.success is True
        assert [result.device_id for result in response.results] == ["current"]
        assert release_old.is_set() is False
        request_db.close.assert_called_once()
    finally:
        pending = list(module._background)
        release_old.set()
        await asyncio.gather(*pending)
    record.assert_called_once()
    assert record.call_args.kwargs["result"].device_id == "legacy"


@pytest.mark.parametrize("select_plugin", [False, True])
@pytest.mark.asyncio
async def test_selected_replace_always_uses_fresh_complete_plugin_snapshot(
    test_db, test_user, select_plugin
):
    selected = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="selected",
        is_active=True,
        json={"spec": {"marketplace": "test", "version": "2.0.0"}},
    )
    unrelated = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="unrelated",
        is_active=True,
        json={"spec": {"marketplace": "test", "version": "1.0.0"}},
    )
    test_db.add_all([selected, unrelated])
    test_db.commit()
    service = DeviceCapabilitySyncService(session_factory=lambda: nullcontext(test_db))
    service.supports_plugin_delta = AsyncMock(return_value=True)
    service.sync_device_payload = AsyncMock(
        side_effect=lambda **kwargs: _result(kwargs["payload"])
    )

    result = await service.sync_device_capabilities(
        test_db,
        user=test_user,
        device_id="device",
        skill_ids=[],
        mode="replace",
        installed_plugin_ids=[selected.id] if select_plugin else [],
    )

    assert result.success is True
    sent = service.sync_device_payload.call_args.kwargs["payload"]
    assert sent["mode"] == "replace"
    assert sent["plugin_sync"]["complete"] is True
    assert [item["installed_plugin_id"] for item in sent["plugins"]] == (
        [selected.id] if select_plugin else []
    )
    assert sent["plugins"] == result.results[0].desired_plugin_snapshot["plugins"]


@pytest.mark.asyncio
async def test_selected_replace_preserves_generator_ids_in_fresh_snapshot(
    test_db, test_user
):
    from tests.services.test_device_capability_sync_service import (
        _create_installed_mcp,
        _create_installed_plugin,
        _create_installed_skill,
        _create_skill,
    )

    skill = _create_skill(test_db, test_user.id)
    installed_skill = _create_installed_skill(test_db, test_user.id, skill)
    installed_plugin = _create_installed_plugin(test_db, test_user.id)
    installed_mcp = _create_installed_mcp(test_db, test_user.id)
    service = DeviceCapabilitySyncService(session_factory=lambda: nullcontext(test_db))
    service.supports_plugin_delta = AsyncMock(return_value=True)
    service.sync_device_payload = AsyncMock(
        side_effect=lambda **kwargs: _result(kwargs["payload"])
    )

    response = await service.sync_device_capabilities(
        test_db,
        user=test_user,
        device_id="device",
        skill_ids=[],
        installed_skill_ids=(identity for identity in [installed_skill.id]),
        installed_plugin_ids=(identity for identity in [installed_plugin.id]),
        installed_mcp_ids=(identity for identity in [installed_mcp.id]),
        mode="replace",
    )

    assert response.success is True
    sent = service.sync_device_payload.call_args.kwargs["payload"]
    assert [item["installed_skill_id"] for item in sent["skills"]] == [
        installed_skill.id
    ]
    assert [item["installed_plugin_id"] for item in sent["plugins"]] == [
        installed_plugin.id
    ]
    assert [item["installed_mcp_id"] for item in sent["mcps"]] == [installed_mcp.id]


@pytest.mark.parametrize("independent_succeeded", [False, True])
@pytest.mark.asyncio
async def test_mixed_merge_keeps_plugin_delta_and_independent_capabilities_separate(
    independent_succeeded,
):
    plugin_result = _result(_payload())
    independent = DeviceCapabilitySyncResult(
        device_id="device",
        success=independent_succeeded,
        acknowledged=independent_succeeded,
        skills=[{"id": 12, "status": "synced"}],
        mcps=[{"id": 34, "status": "synced"}],
        error=None if independent_succeeded else "MCP failed",
    )
    service = DeviceCapabilitySyncService()
    service.sync_plugin_change = AsyncMock(return_value=plugin_result)
    service.sync_device_payload = AsyncMock(return_value=independent)
    selected_payload = {
        "mode": "merge",
        "plugins": _payload()["plugins"],
        "skills": [{"skill_id": 12}],
        "mcps": [{"installed_mcp_id": 34}],
    }

    response = await sync_selected_capabilities(
        service,
        user_id=1,
        device_id="device",
        payload=selected_payload,
        skill_ids=[12],
        installed_skill_ids=[],
        installed_plugin_ids=[123],
        installed_mcp_ids=[34],
        mode="merge",
    )

    service.sync_plugin_change.assert_awaited_once_with(
        user_id=1, device_id="device", installed_plugin_ids=[123]
    )
    service.sync_device_payload.assert_awaited_once_with(
        user_id=1,
        device_id="device",
        payload={
            "mode": "merge",
            "skills": [{"skill_id": 12}],
            "mcps": [{"installed_mcp_id": 34}],
        },
    )
    recorded = response.results[0]
    assert recorded.plugin_sync == plugin_result.plugin_sync
    assert recorded.desired_plugin_snapshot == plugin_result.desired_plugin_snapshot
    assert recorded.skills == independent.skills
    assert recorded.mcps == independent.mcps
    assert response.success is independent_succeeded


@pytest.mark.asyncio
async def test_legacy_current_device_still_retries_when_other_device_uses_v2(
    test_db, test_user, monkeypatch
):
    from app.services.device import plugin_change_result as module

    installed = Kind(
        user_id=test_user.id,
        kind="InstalledPlugin",
        namespace="default",
        name="target",
        json={"spec": {"releaseId": 17}},
        is_active=True,
    )
    test_db.add(installed)
    test_db.commit()
    service = DeviceCapabilitySyncService()
    legacy = DeviceCapabilitySyncResult(device_id="legacy-current", success=False)
    new_other = _result(_payload()).model_copy(update={"device_id": "new-other"})
    previous = service._aggregate_response(
        [legacy, new_other], skipped=0, mode="replace"
    )
    recovered = service._aggregate_response(
        [DeviceCapabilitySyncResult(device_id="legacy-current", success=True)],
        skipped=0,
        mode="merge",
    )
    sync = AsyncMock(return_value=recovered)
    record = Mock()
    monkeypatch.setattr(
        module.device_capability_sync_service, "sync_installed_plugin_to_device", sync
    )
    monkeypatch.setattr(
        module.plugin_device_installation_service, "record_plugin_sync_response", record
    )

    result = await module._ensure_installed_plugin_on_device(
        test_db,
        user_id=test_user.id,
        device_id="legacy-current",
        installed_id=installed.id,
        previous=previous,
    )

    assert result is recovered
    sync.assert_awaited_once_with(
        test_db,
        user_id=test_user.id,
        device_id="legacy-current",
        installed_plugin_id=installed.id,
    )
    record.assert_called_once_with(
        test_db,
        user_id=test_user.id,
        installed_kind_id=installed.id,
        response=recovered,
    )

"""Authenticated device events persist and revoke personal assistant consent."""

from contextlib import contextmanager
from unittest.mock import Mock

import pytest

from app.api.ws import device_namespace
from app.api.ws.device_namespace import DeviceNamespace
from app.schemas.device import DeviceType
from tests.api.ws.test_device_runtime_features_flow import (
    _device,
    _patch_device_cache,
    _patch_namespace,
    _wait_for_registration_followups,
)
from tests.schemas.test_personal_assistant_dispatch_features import declaration


@pytest.mark.asyncio
async def test_registered_owner_declaration_survives_offline_and_heartbeat_revokes(
    test_db, test_user, monkeypatch
):
    from app.services import human_assistant_dispatch

    device = _device(test_user.id, "assistant-endpoint", DeviceType.LOCAL)
    test_db.add(device)
    test_db.commit()
    cache = _patch_device_cache(monkeypatch)
    namespace = DeviceNamespace()
    session = {"user_id": test_user.id}
    _patch_namespace(monkeypatch, namespace, session)
    refresh = Mock()
    monkeypatch.setattr(human_assistant_dispatch, "refresh_owner_dispatches", refresh)

    @contextmanager
    def database_session():
        yield test_db
        test_db.commit()

    async def sync_call(function, *args):
        if (
            getattr(function, "func", None)
            is device_namespace._store_personal_assistant_declaration
        ):
            return function()
        return True, "Test device", None, None

    monkeypatch.setattr(device_namespace, "_db_session", database_session)
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", sync_call)
    declaration_data = declaration(test_user.id)
    declaration_data["roles"].extend(declaration(test_user.id + 1)["roles"])
    result = await namespace.on_device_register(
        "assistant-socket",
        {
            "device_id": device.name,
            "name": "Test device",
            "executor_version": "test",
            "runtime_features": {
                "schemaVersion": 4,
                "personalAssistantDispatch": declaration_data,
            },
        },
    )
    await _wait_for_registration_followups(namespace)

    assert result["success"] is True
    roles = device.json["spec"]["personalAssistantDispatch"]["roles"]
    assert [role["userId"] for role in roles] == [test_user.id]
    refresh.assert_called_once_with(test_db, user_id=test_user.id)

    cache.values.clear()
    test_db.expire(device)
    assert device.json["spec"]["personalAssistantDispatch"]["roles"] == roles

    result = await namespace.on_device_heartbeat(
        "assistant-socket",
        {
            "device_id": device.name,
            "executor_version": "test",
            "runtime_features": {
                "schemaVersion": 4,
                "personalAssistantDispatch": {"version": 1, "roles": []},
            },
        },
    )

    assert "error" not in result
    assert device.json["spec"]["personalAssistantDispatch"]["roles"] == []
    assert refresh.call_count == 2

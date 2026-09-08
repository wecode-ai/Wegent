"""Verify the native socket authorization boundary with synthetic data only."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.api.ws import plugin_auth_broker as broker


@pytest.fixture
def identity():
    return {
        "user_id": 12,
        "execution_target_id": "logical",
        "device_id": "runtime",
        "runtime_instance_id": "instance",
    }


@pytest.fixture
def route(monkeypatch):
    result = SimpleNamespace(
        socket_id="socket", runtime_device_id="runtime", runtime_instance_id="instance"
    )
    resolve = AsyncMock(return_value=result)
    monkeypatch.setattr(broker.runtime_route_resolver, "resolve", resolve)
    return result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field", ["user_id", "execution_target_id", "device_id", "runtime_instance_id"]
)
async def test_unregistered_socket_never_reads_credentials(
    identity, field, monkeypatch
):
    identity.pop(field)
    exchange = Mock()
    monkeypatch.setattr(broker, "_exchange_sync", exchange)
    result = await broker.exchange(
        sid="socket", session=identity, operation="read", data={}
    )
    assert result == {"success": False, "error": "plugin_auth_device_not_registered"}
    exchange.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field", ["socket_id", "runtime_device_id", "runtime_instance_id"]
)
async def test_replaced_route_never_reads_credentials(
    identity, route, field, monkeypatch
):
    setattr(route, field, "replacement")
    exchange = Mock()
    monkeypatch.setattr(broker, "_exchange_sync", exchange)
    result = await broker.exchange(
        sid="socket", session=identity, operation="read", data={}
    )
    assert result == {"success": False, "error": "plugin_auth_stale_device_socket"}
    exchange.assert_not_called()


@pytest.mark.asyncio
async def test_identity_comes_from_session_and_errors_do_not_leak(
    identity, route, monkeypatch
):
    exchange = Mock(side_effect=RuntimeError("synthetic-secret"))
    monkeypatch.setattr(broker, "_exchange_sync", exchange)
    data = {"user_id": 999, "device_id": "other"}
    result = await broker.exchange(
        sid="socket", session=identity, operation="enroll", data=data
    )
    assert result == {"success": False, "error": "plugin_auth_exchange_failed"}
    exchange.assert_called_once_with(
        12, "logical", "runtime", "instance", "enroll", data
    )


def test_native_requests_reject_identity_override_and_redact_validation():
    from pydantic import ValidationError

    from app.schemas.plugin_account_auth import PluginNativeEnrollment, PluginNativeRead

    with pytest.raises(ValidationError):
        PluginNativeRead.model_validate(
            {
                "connection_id": "a" * 64,
                "installed_plugin_id": 1,
                "expected_revision": 1,
                "user_id": 999,
            }
        )
    with pytest.raises(ValidationError) as error:
        PluginNativeEnrollment.model_validate(
            {
                "migration_id": "a" * 64,
                "account_id": "alice",
                "credential": "synthetic-secret" * 10000,
            }
        )
    assert "synthetic-secret" not in str(error.value)


@pytest.mark.asyncio
async def test_credential_events_bypass_payload_tracing(monkeypatch):
    from unittest.mock import MagicMock

    from app.api.ws import decorators
    from app.api.ws.device_namespace import DeviceNamespace

    namespace = DeviceNamespace()
    namespace.get_session = AsyncMock(return_value={"user_id": 12})
    namespace._execute_handler = AsyncMock(return_value={"success": True})
    monkeypatch.setattr(decorators.settings, "OTEL_ENABLED", True)
    monkeypatch.setattr(decorators, "is_telemetry_enabled", lambda: True)
    monkeypatch.setattr(decorators.trace, "get_tracer", MagicMock())
    extract = Mock()
    monkeypatch.setattr(decorators, "_set_event_data_attributes", extract)
    for event in (
        "plugin.auth.automatic",
        "plugin.auth.prepare",
        "plugin.auth.transfer.stage",
        "plugin.auth.transfer.prepare",
        "plugin.auth.transfer.finish",
        "plugin.auth.transfer.abort",
        "plugin.auth.execute",
        "plugin.auth.enroll",
        "plugin.auth.read",
        "plugin.auth.oauth.begin",
        "plugin.auth.oauth.finish",
        "plugin.auth.oauth.revocations",
        "plugin.auth.oauth.revoke_begin",
        "plugin.auth.oauth.revoke_finish",
    ):
        await namespace.trigger_event(
            event, "socket", {"credential": "synthetic-secret"}
        )
    extract.assert_not_called()
    await namespace.trigger_event(
        "device:heartbeat", "socket", {"device_id": "runtime"}
    )
    extract.assert_called_once()

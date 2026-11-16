"""Verify the native socket authorization boundary with synthetic data only."""

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy.engine import make_url
from sqlalchemy.exc import OperationalError

from app.api.ws import plugin_auth_broker as broker
from app.services.plugin_write_coordination import PluginWriteError


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
@pytest.mark.parametrize("field", ["user_id", "device_id", "runtime_instance_id"])
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
    identity, route, monkeypatch, caplog
):
    exchange = Mock(side_effect=RuntimeError("synthetic-secret"))
    monkeypatch.setattr(broker, "_exchange_sync", exchange)
    data = {"user_id": 999, "device_id": "other"}
    result = await broker.exchange(
        sid="socket", session=identity, operation="enroll", data=data
    )
    assert result == {"success": False, "error": "plugin_auth_exchange_failed"}
    assert "stage=exchange error_type=RuntimeError" in caplog.text
    assert "synthetic-secret" not in caplog.text
    exchange.assert_called_once_with(
        12, "runtime", "runtime", "instance", "enroll", data
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code", ["plugin_write_busy", "plugin_write_unavailable", "plugin_write_lease_lost"]
)
async def test_coordination_failure_returns_stable_retryable_code(
    identity, route, monkeypatch, caplog, code
):
    monkeypatch.setattr(
        broker, "_exchange_sync", Mock(side_effect=PluginWriteError(code))
    )

    result = await broker.exchange(
        sid="socket",
        session=identity,
        operation="local_lifecycle",
        data={"action": "logout", "credential": "payload-secret"},
    )

    assert result == {"success": False, "error": code}
    assert f"stage=exchange code={code}" in caplog.text
    assert "payload-secret" not in caplog.text


@pytest.mark.asyncio
async def test_database_failure_logs_safe_metadata_and_lifecycle_timing(
    identity, route, monkeypatch, caplog
):
    clock = Mock(return_value=100.0)
    monkeypatch.setattr(broker, "monotonic", clock)
    monkeypatch.setattr(
        broker,
        "engine",
        SimpleNamespace(
            url=make_url(
                "mysql+pymysql://username-secret:password-secret@db.internal:3307/"
                "auth_db?ssl_key=query-secret"
            )
        ),
    )

    def fail(*args):
        clock.return_value = 116.125
        raise OperationalError(
            "SELECT sql-secret",
            {"credential": "parameter-secret"},
            Exception(1205, "driver-message-secret"),
        )

    monkeypatch.setattr(broker, "_exchange_sync", fail)
    with caplog.at_level("INFO", logger=broker.__name__):
        result = await broker.exchange(
            sid="socket",
            session=identity,
            operation="local_lifecycle",
            data={"action": "logout", "credential": "payload-secret"},
        )

    assert result == {"success": False, "error": "plugin_auth_exchange_failed"}
    assert "stage=exchange error_type=OperationalError" in caplog.text
    assert "operation=local_lifecycle action=logout" in caplog.text
    assert "db_host=db.internal db_port=3307 db_name=auth_db" in caplog.text
    assert "db_error_code=1205" in caplog.text
    assert "elapsed_ms=16125 success=False" in caplog.text
    records = [record for record in caplog.records if record.name == broker.__name__]
    assert len(records) == 3
    assert "Plugin auth exchange started" in records[0].message
    assert "Plugin auth exchange failed" in records[1].message
    assert "Plugin auth exchange finished" in records[2].message
    exchange_ids = {
        field
        for record in records
        for field in record.message.split()
        if field.startswith("exchange_id=")
    }
    assert len(exchange_ids) == 1
    assert all(record.exc_info is None for record in records)
    for secret in (
        "username-secret",
        "password-secret",
        "query-secret",
        "sql-secret",
        "parameter-secret",
        "driver-message-secret",
        "payload-secret",
    ):
        assert secret not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("driver_args", [(), ("code-secret",), (True,)])
async def test_failure_diagnostics_never_log_non_numeric_driver_arguments(
    identity, route, monkeypatch, caplog, driver_args
):
    monkeypatch.setattr(
        broker,
        "_exchange_sync",
        Mock(side_effect=OperationalError(None, None, Exception(*driver_args))),
    )

    result = await broker.exchange(
        sid="socket", session=identity, operation="automatic", data={}
    )

    assert result["error"] == "plugin_auth_exchange_failed"
    assert "operation=automatic action=unknown" in caplog.text
    assert "db_error_code=None" in caplog.text
    assert "code-secret" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operation,data",
    [
        ("local_lifecycle", {"action": "action-secret\ninjected-log-line"}),
        ("local_lifecycle", {"action": ["action-secret"]}),
        ("local_lifecycle", {"action": {"secret": "action-secret"}}),
        ("local_lifecycle", "payload-secret"),
        ("enroll", {"action": "logout"}),
    ],
)
async def test_failure_diagnostics_only_log_valid_lifecycle_actions(
    identity, route, monkeypatch, caplog, operation, data
):
    monkeypatch.setattr(
        broker, "_exchange_sync", Mock(side_effect=RuntimeError("exception-secret"))
    )

    result = await broker.exchange(
        sid="socket", session=identity, operation=operation, data=data
    )

    assert result["error"] == "plugin_auth_exchange_failed"
    assert "action=unknown" in caplog.text
    assert "db_error_code=None" in caplog.text
    for secret in (
        "action-secret",
        "injected-log-line",
        "payload-secret",
        "exception-secret",
    ):
        assert secret not in caplog.text


@pytest.mark.asyncio
async def test_route_database_failure_logs_route_stage(identity, route, caplog):
    broker.runtime_route_resolver.resolve.side_effect = OperationalError(
        None, None, Exception(2003, "connection-secret")
    )

    result = await broker.exchange(
        sid="socket",
        session=identity,
        operation="local_lifecycle",
        data={"action": "logout"},
    )

    assert result["error"] == "plugin_auth_exchange_failed"
    assert "stage=route error_type=OperationalError" in caplog.text
    assert "db_error_code=2003" in caplog.text
    assert "connection-secret" not in caplog.text


@pytest.mark.asyncio
async def test_successful_lifecycle_logs_completion_without_response_data(
    identity, route, monkeypatch, caplog
):
    response = {"success": True, "status": "ok", "credential": "response-secret"}
    monkeypatch.setattr(broker, "_exchange_sync", Mock(return_value=response))
    with caplog.at_level("INFO", logger=broker.__name__):
        result = await broker.exchange(
            sid="socket",
            session=identity,
            operation="local_lifecycle",
            data={"action": "logout"},
        )

    assert result == response
    assert "Plugin auth exchange started" in caplog.text
    assert "Plugin auth exchange finished" in caplog.text
    assert "success=True" in caplog.text
    assert "response-secret" not in caplog.text


@pytest.mark.asyncio
async def test_shared_app_alias_uses_registered_record_route(
    identity, route, monkeypatch
):
    identity["execution_target_id"] = "shared-desktop-alias"
    identity["device_id"] = "app-record-78"
    route.runtime_device_id = "app-record-78"
    exchange = Mock(return_value={"success": True, "migrations": []})
    monkeypatch.setattr(broker, "_exchange_sync", exchange)

    result = await broker.exchange(
        sid="socket",
        session=identity,
        operation="automatic",
        data={"installed_plugin_ids": [64]},
    )

    assert result["success"] is True
    broker.runtime_route_resolver.resolve.assert_awaited_once_with(
        user_id=12, submitted_device_id="app-record-78"
    )
    exchange.assert_called_once_with(
        12,
        "app-record-78",
        "app-record-78",
        "instance",
        "automatic",
        {"installed_plugin_ids": [64]},
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


@pytest.fixture
def sync_exchange_db(monkeypatch):
    db = Mock(info={})
    monkeypatch.setattr(broker, "SessionLocal", lambda: nullcontext(db))
    monkeypatch.setattr(broker, "configure_plugin_session", Mock())
    monkeypatch.setattr(
        broker,
        "resolve_runtime_route_identity",
        Mock(
            return_value=SimpleNamespace(
                runtime_device_id="runtime", runtime_instance_id="instance"
            )
        ),
    )
    return db


def test_automatic_exchange_forwards_metadata_phase_and_exact_targets(
    sync_exchange_db, monkeypatch
):
    reconcile = Mock(return_value={"packages": []})
    monkeypatch.setattr(broker.plugin_auth_automation, "reconcile", reconcile)
    target = {"installed_plugin_id": 42, "connector_slug": "native"}

    result = broker._exchange_sync(
        12,
        "runtime",
        "runtime",
        "instance",
        "automatic",
        {"installed_plugin_ids": [42], "prepare_only": True, "targets": [target]},
    )

    assert result == {"success": True, "packages": []}
    parameters = reconcile.call_args.kwargs
    assert parameters["user_id"] == 12
    assert parameters["device_id"] == "runtime"
    assert parameters["installed_ids"] == [42]
    assert parameters["prepare_only"] is True
    assert [item.model_dump() for item in parameters["targets"]] == [target]


@pytest.mark.parametrize("after_id", [0, 64])
def test_revocations_exchange_keeps_identity_list_and_adds_matching_metadata(
    sync_exchange_db, monkeypatch, after_id
):
    targets = [{"connection_id": "a" * 64, "package": None}]
    pending = Mock(return_value={"revocations": targets, "next_cursor": None})
    monkeypatch.setattr(broker.plugin_oauth_revocations, "pending", pending)

    result = broker._exchange_sync(
        12,
        "runtime",
        "runtime",
        "instance",
        "oauth_revocations",
        {} if after_id == 0 else {"after_id": after_id},
    )

    assert result == {
        "success": True,
        "connection_ids": ["a" * 64],
        "revocations": targets,
        "next_cursor": None,
    }
    pending.assert_called_once_with(
        sync_exchange_db, user_id=12, device_id="runtime", after_id=after_id
    )
    sync_exchange_db.commit.assert_not_called()


@pytest.mark.parametrize(
    "payload",
    [
        {"after_id": -1},
        {"after_id": True},
        {"after_id": "10"},
        {"after_id": 2**63},
        {"after_id": 0, "user_id": 999},
    ],
)
def test_revocation_query_rejects_invalid_cursors_and_identity_override(payload):
    from pydantic import ValidationError

    from app.schemas.plugin_account_auth import PluginRevocationQuery

    with pytest.raises(ValidationError):
        PluginRevocationQuery.model_validate(payload)


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
        "plugin.auth.local_lifecycle",
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

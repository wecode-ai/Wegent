# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for owned logical device to Runtime socket resolution."""

from unittest.mock import AsyncMock

import pytest

from app.models.kind import Kind
from app.schemas.device import DeviceType
from app.services.device import runtime_route as module
from app.services.device.runtime_route import (
    RuntimeRouteError,
    RuntimeRouteIdentity,
    RuntimeRouteResolver,
    resolve_runtime_route_identity,
)


def _device(
    *,
    user_id: int = 7,
    logical_id: str = "cloud-logical",
    runtime_id: str = "runtime-cloud",
    runtime_instance_id: str = "runtime-instance-1",
    app_device_id: str | None = None,
    device_type: DeviceType = DeviceType.CLOUD,
) -> Kind:
    return Kind(
        user_id=user_id,
        kind="Device",
        name=logical_id,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": logical_id, "namespace": "default"},
            "spec": {
                "deviceId": runtime_id,
                "deviceType": device_type.value,
                "runtimeInstanceId": runtime_instance_id,
                "appDeviceId": app_device_id,
                "cloudConfig": {
                    "sandboxId": logical_id,
                    "deviceId": runtime_id,
                },
            },
        },
    )


def test_resolve_runtime_route_identity_accepts_app_device_id(test_db):
    test_db.add(
        _device(
            app_device_id="electron-app",
            device_type=DeviceType.REMOTE,
        )
    )
    test_db.commit()

    identity = resolve_runtime_route_identity(
        test_db,
        user_id=7,
        submitted_device_id="electron-app",
    )

    assert identity == RuntimeRouteIdentity(
        logical_device_id="cloud-logical",
        runtime_device_id="runtime-cloud",
        runtime_instance_id="runtime-instance-1",
        device_type=DeviceType.REMOTE,
        app_device_id="electron-app",
    )


def test_resolve_runtime_route_identity_ignores_legacy_local_app_alias(test_db):
    test_db.add(
        _device(
            logical_id="legacy-local",
            runtime_id="legacy-runtime",
            runtime_instance_id="legacy-instance",
            app_device_id="electron-app",
            device_type=DeviceType.LOCAL,
        )
    )
    test_db.add(
        _device(
            logical_id="local-device",
            runtime_id="local-device",
            runtime_instance_id="current-instance",
            app_device_id="electron-app",
            device_type=DeviceType.REMOTE,
        )
    )
    test_db.commit()

    identity = resolve_runtime_route_identity(
        test_db,
        user_id=7,
        submitted_device_id="electron-app",
    )

    assert identity == RuntimeRouteIdentity(
        logical_device_id="local-device",
        runtime_device_id="local-device",
        runtime_instance_id="current-instance",
        device_type=DeviceType.REMOTE,
        app_device_id="electron-app",
    )


def test_resolve_runtime_route_identity_rejects_ambiguous_app_exposure(test_db):
    test_db.add(
        _device(
            logical_id="app-device",
            runtime_id="app-runtime",
            app_device_id="electron-app",
            device_type=DeviceType.APP,
        )
    )
    test_db.add(
        _device(
            logical_id="remote-device",
            runtime_id="remote-runtime",
            app_device_id="electron-app",
            device_type=DeviceType.REMOTE,
        )
    )
    test_db.commit()

    assert (
        resolve_runtime_route_identity(
            test_db,
            user_id=7,
            submitted_device_id="electron-app",
        )
        is None
    )


def test_resolve_runtime_route_identity_accepts_logical_and_runtime_ids(test_db):
    test_db.add(_device())
    test_db.commit()

    logical = resolve_runtime_route_identity(
        test_db,
        user_id=7,
        submitted_device_id="cloud-logical",
    )
    runtime = resolve_runtime_route_identity(
        test_db,
        user_id=7,
        submitted_device_id="runtime-cloud",
    )

    assert (
        logical
        == runtime
        == RuntimeRouteIdentity(
            logical_device_id="cloud-logical",
            runtime_device_id="runtime-cloud",
            runtime_instance_id="runtime-instance-1",
            device_type=DeviceType.CLOUD,
        )
    )


def test_resolve_runtime_route_identity_does_not_cross_user_boundary(test_db):
    test_db.add(_device(user_id=8))
    test_db.commit()

    assert (
        resolve_runtime_route_identity(
            test_db,
            user_id=7,
            submitted_device_id="runtime-cloud",
        )
        is None
    )


def test_resolve_runtime_route_identity_rejects_ambiguous_runtime_id(test_db):
    test_db.add(
        _device(
            logical_id="cloud-logical-a",
            runtime_id="shared-runtime",
        )
    )
    test_db.add(
        _device(
            logical_id="cloud-logical-b",
            runtime_id="shared-runtime",
        )
    )
    test_db.commit()

    assert (
        resolve_runtime_route_identity(
            test_db,
            user_id=7,
            submitted_device_id="shared-runtime",
        )
        is None
    )


@pytest.mark.asyncio
async def test_runtime_route_resolver_returns_current_socket(monkeypatch):
    identity = RuntimeRouteIdentity(
        logical_device_id="cloud-logical",
        runtime_device_id="runtime-cloud",
        runtime_instance_id="runtime-instance-1",
        device_type=DeviceType.CLOUD,
    )
    resolver = RuntimeRouteResolver()
    monkeypatch.setattr(resolver, "_resolve_identity", lambda *_args: identity)
    get_device_online_info = AsyncMock(
        return_value={
            "socket_id": "socket-1",
            "runtime_instance_id": "runtime-instance-1",
        }
    )
    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        get_device_online_info,
    )

    route = await resolver.resolve(
        user_id=7,
        submitted_device_id="cloud-logical",
    )

    assert route.logical_device_id == "cloud-logical"
    assert route.runtime_device_id == "runtime-cloud"
    assert route.socket_id == "socket-1"
    get_device_online_info.assert_awaited_once_with(7, "runtime-cloud")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("identity", "online_info", "expected_code"),
    [
        (None, None, "device_not_found"),
        (
            RuntimeRouteIdentity(
                logical_device_id="cloud-logical",
                runtime_device_id="runtime-cloud",
                runtime_instance_id=None,
                device_type=DeviceType.CLOUD,
            ),
            None,
            "device_offline",
        ),
        (
            RuntimeRouteIdentity(
                logical_device_id="cloud-logical",
                runtime_device_id="runtime-cloud",
                runtime_instance_id=None,
                device_type=DeviceType.CLOUD,
            ),
            {},
            "runtime_route_missing",
        ),
        (
            RuntimeRouteIdentity(
                logical_device_id="cloud-logical",
                runtime_device_id="runtime-cloud",
                runtime_instance_id="runtime-instance-1",
                device_type=DeviceType.CLOUD,
            ),
            {
                "socket_id": "socket-1",
                "runtime_instance_id": "stale-instance",
            },
            "runtime_route_missing",
        ),
        (
            RuntimeRouteIdentity(
                logical_device_id="cloud-logical",
                runtime_device_id="runtime-cloud",
                runtime_instance_id="runtime-instance-1",
                device_type=DeviceType.CLOUD,
            ),
            {
                "socket_id": "socket-1",
                "runtime_instance_id": None,
            },
            "runtime_route_missing",
        ),
    ],
)
async def test_runtime_route_resolver_returns_stable_failures(
    monkeypatch,
    identity,
    online_info,
    expected_code,
):
    resolver = RuntimeRouteResolver()
    monkeypatch.setattr(resolver, "_resolve_identity", lambda *_args: identity)
    monkeypatch.setattr(
        module.device_service,
        "get_device_online_info",
        AsyncMock(return_value=online_info),
    )

    with pytest.raises(RuntimeRouteError) as exc_info:
        await resolver.resolve(
            user_id=7,
            submitted_device_id="cloud-logical",
        )

    assert exc_info.value.code == expected_code

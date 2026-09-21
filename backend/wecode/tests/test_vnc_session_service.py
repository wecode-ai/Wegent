# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.schemas.device import DeviceType
from app.services.device.session_service import DeviceSessionError
from wecode.service.vnc_session_service import (
    VncSessionProviderRegistry,
    VncSessionRecord,
    VncSessionService,
    VncSessionStore,
    VncUpstream,
    _ticket_key,
    vnc_session_provider_registry,
)


class PreparedProvider:
    async def prepare(self, **_kwargs):
        return VncUpstream(
            url="wss://runtime.example.test/session?token=runtime-secret",
            headers={"X-Signature": "backend-only-signature"},
            provider="test",
            provider_instance_id="instance-1",
        )

    async def authorize(self, **_kwargs):
        return await self.prepare()


@pytest.mark.asyncio
async def test_vnc_session_service_returns_only_a_one_time_proxy_ticket(monkeypatch):
    registry = VncSessionProviderRegistry()
    registry.register(DeviceType.CLOUD, PreparedProvider())
    store = AsyncMock(spec=VncSessionStore)
    service = VncSessionService(registry, store)
    identity = type(
        "Identity",
        (),
        {
            "device_type": DeviceType.CLOUD,
            "logical_device_id": "cloud-device-1",
        },
    )()
    monkeypatch.setattr(
        "wecode.service.vnc_session_service.resolve_runtime_route_identity",
        lambda *_args, **_kwargs: identity,
    )
    monkeypatch.setattr(
        "wecode.service.vnc_session_service.settings.WEGENT_SOCKET_URL",
        "https://backend.example.test",
    )

    result = await service.start_session(
        db=object(),
        actor_user_id=7,
        owner_user_id=9,
        device_id="cloud-device-1",
    )

    assert result["url"].startswith(
        "wss://backend.example.test/vnc-proxy/sessions/vnc-"
    )
    assert "?ticket=" in result["url"]
    assert "runtime-secret" not in result["url"]
    assert "backend-only-signature" not in str(result)
    assert result["expires_at"].tzinfo == timezone.utc
    record, ticket = store.register.await_args.args[:2]
    assert record.actor_user_id == 7
    assert record.owner_user_id == 9
    assert record.device_type is DeviceType.CLOUD
    assert record.to_dict()["provider_instance_id"] == "instance-1"
    assert "sandbox_id" not in record.to_dict()
    assert VncSessionRecord.from_dict(record.to_dict()) == record
    assert "upstream_headers" not in record.to_dict()
    assert "backend-only-signature" not in str(record.to_dict())
    assert ticket in result["url"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "device_type", [DeviceType.LOCAL, DeviceType.REMOTE, DeviceType.APP]
)
async def test_vnc_session_service_fails_closed_for_non_cloud_devices(
    monkeypatch,
    device_type,
):
    service = VncSessionService(VncSessionProviderRegistry(), AsyncMock())
    identity = type(
        "Identity",
        (),
        {
            "device_type": device_type,
            "logical_device_id": "non-cloud-device-1",
        },
    )()
    monkeypatch.setattr(
        "wecode.service.vnc_session_service.resolve_runtime_route_identity",
        lambda *_args, **_kwargs: identity,
    )

    with pytest.raises(DeviceSessionError, match="unavailable"):
        await service.start_session(
            db=object(),
            actor_user_id=7,
            owner_user_id=7,
            device_id="non-cloud-device-1",
        )


def test_vnc_provider_registry_rejects_duplicate_device_type():
    registry = VncSessionProviderRegistry()
    provider = PreparedProvider()
    registry.register(DeviceType.CLOUD, provider)

    with pytest.raises(RuntimeError, match="already registered"):
        registry.register(DeviceType.CLOUD, provider)


def test_default_vnc_provider_registry_does_not_support_remote_devices():
    assert vnc_session_provider_registry.get(DeviceType.REMOTE) is None


def test_vnc_ticket_redis_key_never_contains_the_bearer_value():
    ticket = "one-time-ticket-value"

    key = _ticket_key(ticket)

    assert ticket not in key
    assert key.startswith("vnc_connect_ticket:")
    assert len(key.removeprefix("vnc_connect_ticket:")) == 64


@pytest.mark.asyncio
async def test_vnc_connection_rechecks_actor_device_and_provider(monkeypatch):
    registry = VncSessionProviderRegistry()
    registry.register(DeviceType.CLOUD, PreparedProvider())
    service = VncSessionService(registry, AsyncMock())
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=7,
        is_active=True,
        role="admin",
    )
    identity = SimpleNamespace(
        device_type=DeviceType.CLOUD,
        logical_device_id="cloud-device-1",
    )
    monkeypatch.setattr(
        "wecode.service.vnc_session_service.resolve_runtime_route_identity",
        lambda *_args, **_kwargs: identity,
    )
    record = VncSessionRecord(
        session_id="vnc-session-1",
        actor_user_id=7,
        owner_user_id=9,
        device_id="cloud-device-1",
        device_type=DeviceType.CLOUD,
        provider="test",
        upstream_url="wss://runtime.example.test/session",
        provider_instance_id="instance-1",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    upstream = await service.authorize_connection(db=db, record=record)

    assert upstream is not None
    assert upstream.headers == {"X-Signature": "backend-only-signature"}


@pytest.mark.asyncio
async def test_vnc_connection_rejects_revoked_admin_delegation():
    registry = VncSessionProviderRegistry()
    registry.register(DeviceType.CLOUD, PreparedProvider())
    service = VncSessionService(registry, AsyncMock())
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = SimpleNamespace(
        id=7,
        is_active=True,
        role="user",
    )
    record = VncSessionRecord(
        session_id="vnc-session-1",
        actor_user_id=7,
        owner_user_id=9,
        device_id="cloud-device-1",
        device_type=DeviceType.CLOUD,
        provider="test",
        upstream_url="wss://runtime.example.test/session",
        provider_instance_id="instance-1",
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=5),
    )

    assert await service.authorize_connection(db=db, record=record) is None

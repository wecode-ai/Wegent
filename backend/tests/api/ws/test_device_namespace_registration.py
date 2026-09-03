# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import sessionmaker

from app.api.ws import device_namespace
from app.api.ws.device_namespace import DeviceNamespace, DeviceRegistrationFingerprint
from app.models.kind import Kind
from app.schemas.device import DeviceType


def test_register_device_reads_display_name_before_session_closes(
    test_engine,
    worker_id,
    monkeypatch,
):
    """Device registration should not access expired Kind attributes after close."""
    expiring_session_local = sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=test_engine,
        expire_on_commit=True,
    )
    monkeypatch.setattr(device_namespace, "SessionLocal", expiring_session_local)

    user_id = 990001 if worker_id == "master" else 990001 + int(worker_id[2:])
    device_id = "device-detached-registration"

    try:
        success, persisted_display_name, error = device_namespace._register_device(
            user_id=user_id,
            device_id=device_id,
            name="Windows-Device-detached",
            client_ip="127.0.0.1",
            device_type=DeviceType.LOCAL.value,
            bind_shell="claudecode",
        )
    finally:
        cleanup_db = expiring_session_local()
        try:
            cleanup_db.query(Kind).filter(
                Kind.user_id == user_id,
                Kind.kind == "Device",
                Kind.namespace == "default",
                Kind.name == device_id,
            ).delete(synchronize_session=False)
            cleanup_db.commit()
        finally:
            cleanup_db.close()

    assert error is None
    assert success is True
    assert persisted_display_name == "Windows-Device-detached"


@pytest.mark.asyncio
async def test_cloud_runtime_mismatch_returns_registration_failed_without_side_device(
    test_db,
    test_user,
    monkeypatch,
):
    logical_device_id = "cloud-logical-device"
    runtime_device_id = "cloud-runtime-route"
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name=logical_device_id,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {
                "name": logical_device_id,
                "namespace": "default",
            },
            "spec": {
                "deviceId": runtime_device_id,
                "deviceType": DeviceType.CLOUD.value,
                "runtimeInstanceId": "runtime-instance-before-rebuild",
                "cloudConfig": {
                    "sandboxId": logical_device_id,
                    "deviceId": runtime_device_id,
                },
            },
        },
    )
    test_db.add(device)
    test_db.commit()

    @contextmanager
    def test_db_session():
        yield test_db

    monkeypatch.setattr(device_namespace, "get_db_session", test_db_session)

    async def run_inline(func, *args):
        return func(*args)

    namespace = DeviceNamespace()
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={
                "user_id": test_user.id,
                "client_ip": "198.51.100.30",
            }
        ),
    )
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", run_inline)

    result = await namespace.on_device_register(
        "cloud-runtime-mismatch",
        {
            "device_id": runtime_device_id,
            "name": "Cloud Runtime",
            "device_type": DeviceType.CLOUD.value,
            "runtime_instance_id": "runtime-instance-after-rebuild",
        },
    )

    test_db.expire_all()
    persisted_devices = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Device",
            Kind.namespace == "default",
        )
        .all()
    )
    assert result == {
        "error": (
            "Registration failed: Runtime instance ID mismatch for persistent "
            f"cloud device {logical_device_id}"
        )
    }
    assert len(persisted_devices) == 1
    assert persisted_devices[0].name == logical_device_id
    assert persisted_devices[0].json["metadata"]["name"] == logical_device_id
    assert persisted_devices[0].json["spec"]["deviceId"] == runtime_device_id
    assert (
        persisted_devices[0].json["spec"]["runtimeInstanceId"]
        == "runtime-instance-before-rebuild"
    )


def test_cloud_runtime_matching_pins_first_runtime_instance(
    test_db,
    test_user,
    monkeypatch,
):
    logical_device_id = "cloud-unpinned-device"
    runtime_device_id = "cloud-unpinned-route"
    sandbox_id = "sandbox-unpinned-runtime"
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name=logical_device_id,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {
                "name": logical_device_id,
                "namespace": "default",
            },
            "spec": {
                "deviceId": runtime_device_id,
                "deviceType": DeviceType.CLOUD.value,
                "runtimeInstanceId": None,
                "cloudConfig": {
                    "sandboxId": sandbox_id,
                    "deviceId": runtime_device_id,
                },
            },
        },
    )
    test_db.add(device)
    test_db.commit()

    @contextmanager
    def test_db_session():
        yield test_db

    monkeypatch.setattr(device_namespace, "get_db_session", test_db_session)

    matched = device_namespace._match_cloud_device_sync(
        user_id=test_user.id,
        client_ip="198.51.100.31",
        executor_device_id=runtime_device_id,
        runtime_instance_id="runtime-instance-first",
    )

    test_db.expire_all()
    persisted = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == logical_device_id,
        )
        .one()
    )
    assert matched == (logical_device_id, False, None)
    assert persisted.json["spec"]["runtimeInstanceId"] == "runtime-instance-first"


@pytest.mark.asyncio
async def test_legacy_cloud_runtime_matching_returns_migrated_canonical_id(
    test_db,
    test_user,
    monkeypatch,
):
    sandbox_id = "sandbox-legacy-runtime"
    runtime_device_id = "cloud-migrated-route"
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name=sandbox_id,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {"name": sandbox_id, "namespace": "default"},
            "spec": {
                "deviceType": DeviceType.CLOUD.value,
                "cloudConfig": {"sandboxId": sandbox_id},
            },
        },
    )
    test_db.add(device)
    test_db.commit()

    @contextmanager
    def test_db_session():
        try:
            yield test_db
        finally:
            test_db.commit()

    async def run_inline(func, *args):
        return func(*args)

    monkeypatch.setattr(device_namespace, "get_db_session", test_db_session)
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", run_inline)

    matched = await DeviceNamespace()._match_cloud_device(
        user_id=test_user.id,
        client_ip="198.51.100.32",
        executor_device_id=runtime_device_id,
        runtime_instance_id="runtime-instance-migrated",
    )

    test_db.expire_all()
    persisted = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Device",
            Kind.namespace == "default",
        )
        .one()
    )
    assert matched == runtime_device_id
    assert persisted.name == runtime_device_id
    assert persisted.json["spec"]["deviceId"] == runtime_device_id
    assert persisted.json["spec"]["cloudConfig"] == {
        "sandboxId": sandbox_id,
        "deviceId": runtime_device_id,
    }


@pytest.mark.asyncio
async def test_remote_runtime_mismatch_is_not_hidden_by_registration_debounce(
    test_db,
    test_user,
    monkeypatch,
):
    device_id = "remote-persistent-device"
    device = Kind(
        user_id=test_user.id,
        kind="Device",
        name=device_id,
        namespace="default",
        is_active=True,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Device",
            "metadata": {
                "name": device_id,
                "namespace": "default",
            },
            "spec": {
                "deviceId": device_id,
                "deviceType": DeviceType.REMOTE.value,
                "displayName": "Remote Device",
                "runtimeInstanceId": "runtime-instance-original",
            },
        },
    )
    test_db.add(device)
    test_db.commit()

    @contextmanager
    def test_db_session():
        yield test_db

    async def run_inline(func, *args):
        return func(*args)

    namespace = DeviceNamespace()
    namespace._remember_registration(
        test_user.id,
        device_id,
        DeviceRegistrationFingerprint(
            display_name="Remote Device",
            client_ip="198.51.100.32",
            device_type=DeviceType.REMOTE.value,
            bind_shell="claudecode",
            runtime_transfer_host="",
            runtime_instance_id="runtime-instance-original",
            app_device_id="",
        ),
        "Remote Device",
    )
    monkeypatch.setattr(
        namespace,
        "get_session",
        AsyncMock(
            return_value={
                "user_id": test_user.id,
                "client_ip": "198.51.100.32",
            }
        ),
    )
    monkeypatch.setattr(device_namespace, "_db_session", test_db_session)
    monkeypatch.setattr(device_namespace, "run_sync_in_executor", run_inline)

    result = await namespace.on_device_register(
        "remote-runtime-mismatch",
        {
            "device_id": device_id,
            "name": "Remote Device",
            "device_type": DeviceType.REMOTE.value,
            "runtime_instance_id": "runtime-instance-replacement",
        },
    )

    test_db.expire_all()
    persisted_devices = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Device",
            Kind.namespace == "default",
            Kind.name == device_id,
        )
        .all()
    )
    assert result == {
        "error": (
            "Registration failed: Runtime instance ID mismatch for persistent "
            f"remote device {device_id}"
        )
    }
    assert len(persisted_devices) == 1
    assert (
        persisted_devices[0].json["spec"]["runtimeInstanceId"]
        == "runtime-instance-original"
    )

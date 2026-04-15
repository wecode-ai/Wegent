# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from sqlalchemy.orm import sessionmaker

from app.api.ws import device_namespace
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

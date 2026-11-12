# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the delivery object-storage boundary."""

import hashlib
from io import BytesIO
from unittest.mock import Mock

import pytest
from minio.error import S3Error

from app.services.delivery.storage import (
    DeliveryObjectNotFoundError,
    DeliveryStorage,
    DeliveryStorageUnavailableError,
)


def test_get_bytes_translates_missing_minio_object() -> None:
    client = Mock()
    client.get_object.side_effect = S3Error(
        None,
        "NoSuchKey",
        "The specified key does not exist",
        "/deliveries/markdown.md",
        "request-id",
        "host-id",
        bucket_name="deliveries",
        object_name="deliveries/markdown.md",
    )
    storage = DeliveryStorage()
    storage._client = client

    with pytest.raises(
        DeliveryObjectNotFoundError,
        match="deliveries/markdown.md",
    ):
        storage.get_bytes("deliveries/markdown.md")

    assert client.get_object.call_count == 2


def test_get_bytes_retries_a_transient_missing_minio_object() -> None:
    response = Mock()
    response.read.return_value = b"delivery"
    client = Mock()
    client.get_object.side_effect = [
        S3Error(
            None,
            "NoSuchKey",
            "The specified key does not exist",
            "/deliveries/markdown.md",
            "request-id",
            "host-id",
            bucket_name="deliveries",
            object_name="deliveries/markdown.md",
        ),
        response,
    ]
    storage = DeliveryStorage()
    storage._client = client

    assert storage.get_bytes("deliveries/markdown.md") == b"delivery"
    assert client.get_object.call_count == 2
    response.close.assert_called_once_with()
    response.release_conn.assert_called_once_with()


def test_unconfigured_delivery_storage_is_service_unavailable(monkeypatch) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "ATTACHMENT_S3_ACCESS_KEY", "")
    monkeypatch.setattr(settings, "ATTACHMENT_S3_SECRET_KEY", "")
    with pytest.raises(DeliveryStorageUnavailableError, match="not configured"):
        DeliveryStorage().put_bytes("report.md", b"report", "text/markdown")


def test_fingerprint_streams_bytes_and_releases_the_connection() -> None:
    content = b"snapshot" * (300 * 1024)
    stream = BytesIO(content)
    response = Mock()
    response.read.side_effect = stream.read
    storage = DeliveryStorage()
    storage._client = Mock()
    storage._client.get_object.return_value = response

    assert storage.fingerprint("snapshot.bin") == (
        len(content),
        hashlib.sha256(content).hexdigest(),
    )
    assert response.read.call_count > 2
    assert all(call.args == (1024 * 1024,) for call in response.read.call_args_list)
    response.close.assert_called_once_with()
    response.release_conn.assert_called_once_with()


def test_fingerprint_read_error_still_releases_the_connection() -> None:
    response = Mock()
    response.read.side_effect = OSError("interrupted read")
    storage = DeliveryStorage()
    storage._client = Mock()
    storage._client.get_object.return_value = response
    with pytest.raises(OSError, match="interrupted read"):
        storage.fingerprint("snapshot.bin")
    response.close.assert_called_once_with()
    response.release_conn.assert_called_once_with()


def test_fingerprint_missing_object_is_not_retried() -> None:
    storage = DeliveryStorage()
    storage._client = Mock()
    storage._client.get_object.side_effect = S3Error(
        None,
        "NoSuchKey",
        "Missing",
        "/snapshot",
        "request",
        "host",
        bucket_name="deliveries",
        object_name="snapshot",
    )
    with pytest.raises(DeliveryObjectNotFoundError, match="snapshot"):
        storage.fingerprint("snapshot")
    storage._client.get_object.assert_called_once_with(storage.bucket, "snapshot")


def test_fingerprint_header_failure_logs_phase_without_private_data(caplog) -> None:
    error = ConnectionResetError("private-token/private-object")
    storage = DeliveryStorage()
    storage._client = Mock()
    storage._client.get_object.side_effect = error

    with pytest.raises(ConnectionResetError) as raised:
        storage.fingerprint("private-object")

    assert raised.value is error
    storage._client.get_object.assert_called_once_with(storage.bucket, "private-object")
    assert "phase=response_headers bytes_read=0 content_length=None" in caplog.text
    assert "connection=unspecified" in caplog.text
    assert "response_status=None" in caplog.text
    assert "error_type=ConnectionResetError" in caplog.text
    assert "elapsed_ms=" in caplog.text
    assert "private" not in caplog.text


@pytest.mark.parametrize(
    ("length", "connection", "expected_length", "expected_connection"),
    [
        ("1024", "close", "1024", "close"),
        ("1024", "Keep-Alive", "1024", "keep-alive"),
        ("private-header", "private-token", "None", "unspecified"),
    ],
)
def test_fingerprint_body_failure_logs_safe_transport_facts_and_releases(
    caplog, length, connection, expected_length, expected_connection
) -> None:
    error = OSError("private-token/private-object")
    response = Mock()
    response.status = 200
    response.headers = {"Content-Length": length, "Connection": connection}
    response.read.side_effect = [b"private-body", error]
    storage = DeliveryStorage()
    storage._client = Mock()
    storage._client.get_object.return_value = response

    with pytest.raises(OSError) as raised:
        storage.fingerprint("private-object")

    assert raised.value is error
    assert "phase=response_body bytes_read=12" in caplog.text
    assert f"content_length={expected_length}" in caplog.text
    assert f"connection={expected_connection}" in caplog.text
    assert "response_status=200" in caplog.text
    assert "error_type=OSError" in caplog.text
    assert "private" not in caplog.text
    response.close.assert_called_once_with()
    response.release_conn.assert_called_once_with()

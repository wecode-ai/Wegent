# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the delivery object-storage boundary."""

from unittest.mock import Mock

import pytest
from minio.error import S3Error

from app.services.delivery.storage import (
    DeliveryObjectNotFoundError,
    DeliveryStorage,
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

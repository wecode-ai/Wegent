# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for object storage presigned URL generation."""

from urllib.parse import parse_qs, urlparse

from minio import Minio

from app.services.object_storage.presign_service import ObjectStoragePresignService


def test_generate_download_url_supports_long_lived_expiration(monkeypatch):
    """Generate publish download URLs longer than the MinIO client default limit."""
    service = ObjectStoragePresignService()
    client = Minio(
        "s3.example.com",
        access_key="access-key",
        secret_key="secret-key",
        secure=False,
        region="us-east-1",
    )
    monkeypatch.setattr(client, "_get_region", lambda bucket_name: "us-east-1")
    service._client = client

    expires_seconds = 99 * 365 * 24 * 60 * 60
    download_url, _ = service.generate_download_url(
        bucket="wegent-archives",
        object_key="publish/tianyue/4805488/wblive-calendar.zip",
        expires_seconds=expires_seconds,
    )

    query = parse_qs(urlparse(download_url).query)
    assert query["X-Amz-Expires"] == [str(expires_seconds)]

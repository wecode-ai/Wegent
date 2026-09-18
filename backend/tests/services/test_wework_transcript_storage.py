# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for archived Wework transcript object storage."""

import logging
from io import BytesIO

import pytest
from minio.error import S3Error

from app.services.wework_transcript_storage import (
    WeworkTranscriptStorage,
    WeworkTranscriptStorageError,
)


class _ObjectClient:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, bytes, int, str]] = []
        self.response = None

    def put_object(
        self,
        bucket: str,
        object_key: str,
        stream,
        size_bytes: int,
        *,
        content_type: str,
    ) -> None:
        self.requests.append(
            (bucket, object_key, stream.read(), size_bytes, content_type)
        )

    def get_object(self, bucket: str, object_key: str):
        self.requests.append((bucket, object_key))
        return self.response

    def stat_object(self, bucket: str, object_key: str):
        self.requests.append(("stat", bucket, object_key))
        return object()


class _StreamingResponse:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.closed = False
        self.released = False

    def stream(self, *, amt: int):
        assert amt == 1024 * 1024
        yield from self.chunks

    def close(self) -> None:
        self.closed = True

    def release_conn(self) -> None:
        self.released = True


class _FailingObjectClient(_ObjectClient):
    def __init__(self, failure: Exception) -> None:
        super().__init__()
        self.failure = failure

    def put_object(self, *_args, **_kwargs) -> None:
        raise self.failure


class _FailingProbeClient:
    def __init__(self, failure: Exception) -> None:
        self.failure = failure

    def bucket_exists(self, _bucket: str) -> bool:
        raise self.failure


def _s3_error(code: str) -> S3Error:
    return S3Error(
        None,
        code,
        "Access Denied.",
        "/wework-transcripts/1-delta-ab.tgz.aes256gcm",
        "request-id",
        "host-id",
    )


def _storage(client, monkeypatch) -> WeworkTranscriptStorage:
    """Return storage with an injected client; pass None to exercise the probe."""
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings."
        "WEWORK_TRANSCRIPT_S3_BUCKET",
        "transcripts",
    )
    storage = WeworkTranscriptStorage()
    storage._client = client
    return storage


def _s3_settings(monkeypatch, **overrides: str) -> None:
    values = {
        "ATTACHMENT_S3_ENDPOINT": "s3.example:9000",
        "ATTACHMENT_S3_ACCESS_KEY": "access-key",
        "ATTACHMENT_S3_SECRET_KEY": "secret-value",
        **overrides,
    }
    for name, value in values.items():
        monkeypatch.setattr(
            f"app.services.wework_transcript_storage.settings.{name}", value
        )


def test_put_stream_stores_the_declared_object(monkeypatch) -> None:
    client = _ObjectClient()
    storage = WeworkTranscriptStorage()
    storage._client = client
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings."
        "WEWORK_TRANSCRIPT_S3_BUCKET",
        "transcripts",
    )
    content = b"native-transcript"
    storage.put_stream(
        "user/segment.tgz.enc",
        BytesIO(content),
        len(content),
    )

    assert client.requests == [
        (
            "transcripts",
            "user/segment.tgz.enc",
            content,
            len(content),
            "application/octet-stream",
        )
    ]


def test_stream_reads_and_releases_the_object(monkeypatch) -> None:
    client = _ObjectClient()
    response = _StreamingResponse([b"native-", b"transcript"])
    client.response = response
    storage = WeworkTranscriptStorage()
    storage._client = client
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings."
        "WEWORK_TRANSCRIPT_S3_BUCKET",
        "transcripts",
    )

    assert b"".join(storage.stream("user/segment.tgz.enc")) == b"native-transcript"
    assert client.requests == [("transcripts", "user/segment.tgz.enc")]
    assert response.closed is True
    assert response.released is True


def test_exists_distinguishes_present_and_missing_objects(monkeypatch) -> None:
    client = _ObjectClient()
    storage = _storage(client, monkeypatch)

    assert storage.exists("user/present.tgz.enc") is True
    assert client.requests == [("stat", "transcripts", "user/present.tgz.enc")]

    missing = _s3_error("NoSuchKey")
    client.stat_object = lambda *_args: (_ for _ in ()).throw(missing)
    assert storage.exists("user/missing.tgz.enc") is False


def test_put_stream_reports_and_logs_the_s3_reason(monkeypatch, caplog) -> None:
    failure = _s3_error("AccessDenied")
    storage = _storage(_FailingObjectClient(failure), monkeypatch)

    with caplog.at_level(logging.ERROR):
        with pytest.raises(WeworkTranscriptStorageError) as raised:
            storage.put_stream("user/segment.tgz.enc", BytesIO(b"segment"), 7)

    assert str(raised.value) == "Failed to store transcript segment (AccessDenied)"
    assert raised.value.code == "transcript_storage_unavailable"
    assert raised.value.__cause__ is failure
    record = caplog.records[-1]
    assert record.levelno == logging.ERROR
    assert record.getMessage() == "Failed to store transcript segment"
    assert record.storage_reason == "AccessDenied"
    assert record.bucket == "transcripts"
    assert record.exc_info is not None


def test_put_stream_names_failures_that_are_not_s3_errors(monkeypatch) -> None:
    storage = _storage(
        _FailingObjectClient(TimeoutError("read timed out")), monkeypatch
    )

    with pytest.raises(WeworkTranscriptStorageError) as raised:
        storage.put_stream("user/segment.tgz.enc", BytesIO(b"segment"), 7)

    assert str(raised.value) == "Failed to store transcript segment (TimeoutError)"


def _failing_probe(monkeypatch, failure: Exception) -> None:
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.Minio",
        lambda *_args, **_kwargs: _FailingProbeClient(failure),
    )


def test_client_reports_the_bucket_probe_failure(monkeypatch, caplog) -> None:
    _s3_settings(monkeypatch)
    _failing_probe(monkeypatch, _s3_error("AccessDenied"))
    storage = _storage(None, monkeypatch)

    with caplog.at_level(logging.ERROR):
        with pytest.raises(WeworkTranscriptStorageError) as raised:
            storage.client

    assert str(raised.value) == (
        "Wework transcript object storage is unavailable (AccessDenied)"
    )
    assert caplog.records[-1].exc_info is not None


def test_put_stream_keeps_the_bucket_probe_failure(monkeypatch) -> None:
    _s3_settings(monkeypatch)
    _failing_probe(monkeypatch, _s3_error("AccessDenied"))
    storage = WeworkTranscriptStorage()

    with pytest.raises(WeworkTranscriptStorageError) as raised:
        storage.put_stream("user/segment.tgz.enc", BytesIO(b"segment"), 7)

    assert str(raised.value) == (
        "Wework transcript object storage is unavailable (AccessDenied)"
    )


def test_client_logs_which_storage_settings_are_missing(monkeypatch, caplog) -> None:
    _s3_settings(monkeypatch, ATTACHMENT_S3_ACCESS_KEY="")
    storage = _storage(None, monkeypatch)

    with caplog.at_level(logging.ERROR):
        with pytest.raises(WeworkTranscriptStorageError) as raised:
            storage.client

    assert str(raised.value) == "Wework transcript object storage is unavailable"
    record = caplog.records[-1]
    assert record.getMessage() == "Wework transcript object storage is not configured"
    assert record.endpoint_configured is True
    assert record.access_key_configured is False
    assert record.secret_key_configured is True

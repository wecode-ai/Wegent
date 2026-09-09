# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for archived Wework transcript object storage."""

import hashlib

from app.services.wework_transcript_storage import WeworkTranscriptStorage


class _StreamingResponse:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.stream_amount: int | None = None
        self.closed = False
        self.released = False

    def stream(self, *, amt: int):
        self.stream_amount = amt
        yield from self.chunks

    def close(self) -> None:
        self.closed = True

    def release_conn(self) -> None:
        self.released = True


class _ObjectClient:
    def __init__(self, response: _StreamingResponse) -> None:
        self.response = response
        self.requests: list[tuple[str, str]] = []

    def get_object(self, bucket: str, object_key: str) -> _StreamingResponse:
        self.requests.append((bucket, object_key))
        return self.response


class _PolicyClient:
    def __init__(self) -> None:
        self.policy = None

    def presigned_post_policy(self, policy):
        self.policy = policy
        return {"key": "user/segment.tgz.enc", "policy": "signed"}


def test_upload_policy_requires_the_declared_object_size(monkeypatch) -> None:
    client = _PolicyClient()
    storage = WeworkTranscriptStorage()
    storage._client = client
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings."
        "WEWORK_TRANSCRIPT_S3_BUCKET",
        "transcripts",
    )
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings.ATTACHMENT_S3_ENDPOINT",
        "storage.example",
    )
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings.ATTACHMENT_S3_USE_SSL",
        True,
    )

    upload_url, fields, _expires_at = storage.upload_policy(
        "user/segment.tgz.enc",
        4096,
    )

    assert upload_url == "https://storage.example/transcripts"
    assert fields["policy"] == "signed"
    assert client.policy._conditions["eq"]["key"] == "user/segment.tgz.enc"
    assert client.policy._lower_limit == 4096
    assert client.policy._upper_limit == 4096


def test_integrity_streams_object_and_releases_connection(monkeypatch) -> None:
    response = _StreamingResponse([b"native-", b"transcript"])
    client = _ObjectClient(response)
    storage = WeworkTranscriptStorage()
    storage._client = client
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings."
        "WEWORK_TRANSCRIPT_S3_BUCKET",
        "transcripts",
    )

    size, digest = storage.integrity("user/segment.tgz.enc", 1024)

    content = b"native-transcript"
    assert size == len(content)
    assert digest == hashlib.sha256(content).hexdigest()
    assert client.requests == [("transcripts", "user/segment.tgz.enc")]
    assert response.stream_amount == 1024 * 1024
    assert response.closed is True
    assert response.released is True


def test_integrity_stops_after_the_object_exceeds_the_limit(monkeypatch) -> None:
    response = _StreamingResponse([b"1234", b"5678", b"ignored"])
    client = _ObjectClient(response)
    storage = WeworkTranscriptStorage()
    storage._client = client
    monkeypatch.setattr(
        "app.services.wework_transcript_storage.settings."
        "WEWORK_TRANSCRIPT_S3_BUCKET",
        "transcripts",
    )

    size, digest = storage.integrity("user/oversized.tgz.enc", 6)

    assert size == 8
    assert digest == ""
    assert response.closed is True
    assert response.released is True

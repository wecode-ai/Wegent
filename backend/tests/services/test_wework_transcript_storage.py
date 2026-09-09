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

    size, digest = storage.integrity("user/segment.tgz.enc")

    content = b"native-transcript"
    assert size == len(content)
    assert digest == hashlib.sha256(content).hexdigest()
    assert client.requests == [("transcripts", "user/segment.tgz.enc")]
    assert response.stream_amount == 1024 * 1024
    assert response.closed is True
    assert response.released is True

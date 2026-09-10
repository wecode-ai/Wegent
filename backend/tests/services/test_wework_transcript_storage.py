# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for archived Wework transcript object storage."""

from io import BytesIO

from app.services.wework_transcript_storage import WeworkTranscriptStorage


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

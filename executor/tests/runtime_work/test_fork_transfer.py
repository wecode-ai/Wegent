# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from executor.runtime_work import fork_transfer


def test_direct_transfer_defaults_to_loopback_hosts():
    assert fork_transfer._direct_transfer_bind_host() == "127.0.0.1"
    assert fork_transfer._candidate_hosts("127.0.0.1") == ["127.0.0.1"]


@pytest.mark.asyncio
async def test_upload_archive_streams_chunks_with_content_length(
    tmp_path,
    monkeypatch,
):
    archive_path = tmp_path / "archive.tar.gz"
    archive_path.write_bytes(b"a" * (fork_transfer.ARCHIVE_IO_CHUNK_BYTES + 3))
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

    class FakeAsyncClient:
        def __init__(self, *, timeout):
            captured["timeout"] = timeout

        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _tb):
            return None

        async def put(self, url, *, content, headers):
            chunks = []
            async for chunk in content:
                chunks.append(chunk)
            captured["url"] = url
            captured["headers"] = headers
            captured["chunk_sizes"] = [len(chunk) for chunk in chunks]
            return FakeResponse()

    monkeypatch.setattr(fork_transfer.httpx, "AsyncClient", FakeAsyncClient)

    await fork_transfer.upload_archive("https://storage/upload", archive_path)

    assert captured["url"] == "https://storage/upload"
    assert captured["headers"]["Content-Type"] == "application/gzip"
    assert captured["headers"]["Content-Length"] == str(archive_path.stat().st_size)
    assert captured["chunk_sizes"] == [fork_transfer.ARCHIVE_IO_CHUNK_BYTES, 3]

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from collections.abc import AsyncIterator
from unittest.mock import Mock

import httpx
import pytest
from fastapi import HTTPException
from pytest_mock import MockerFixture

from app.schemas.remote_workspace import RemoteWorkspaceArtifactSource
from app.services.remote_workspace_artifact_files import (
    _decode_chunk,
    _executor_file,
    stream_artifact_file,
)


class RecordingArtifactStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.chunks_read = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            self.chunks_read += 1
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize(
    "headers,expected_reads",
    [({"content-length": "6"}, 0), ({}, 2), ({"content-length": "1"}, 2)],
)
@pytest.mark.asyncio
async def test_executor_download_rejects_oversize_without_reading_remaining_body(
    mocker: MockerFixture, headers: dict[str, str], expected_reads: int
) -> None:
    mocker.patch(
        "app.services.remote_workspace_service.remote_workspace_service._get_executor_payload",
        return_value={"status": "success", "base_url": "http://original"},
    )
    mocker.patch(
        "app.services.remote_workspace_artifact_files.MAX_ARTIFACT_FILE_BYTES", 5
    )
    stream = RecordingArtifactStream([b"1234", b"56", b"unread body"])
    client_class = httpx.AsyncClient
    mocker.patch(
        "httpx.AsyncClient",
        side_effect=lambda **kw: client_class(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(200, headers=headers, stream=stream)
            ),
            **kw,
        ),
    )

    with pytest.raises(HTTPException) as error:
        await _executor_file(
            RemoteWorkspaceArtifactSource(
                executor_name="original",
                executor_namespace="namespace-a",
                workspace_root="/workspace/original-repository",
            ),
            "outputs/report.pdf",
        )

    assert error.value.status_code == 413
    assert stream.chunks_read == expected_reads
    assert stream.closed


@pytest.mark.parametrize("status,expected", [(403, 403), (404, 404), (500, 502)])
@pytest.mark.asyncio
async def test_canonical_reader_rejection_never_falls_back_to_files(
    mocker: MockerFixture, status: int, expected: int
) -> None:
    mocker.patch(
        "app.services.remote_workspace_service.remote_workspace_service._get_executor_payload",
        return_value={"status": "success", "base_url": "http://original"},
    )
    requests = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/filesystem/artifact":
            return httpx.Response(status)
        return httpx.Response(200, content=b"outside workspace secret")

    client_class = httpx.AsyncClient
    mocker.patch(
        "httpx.AsyncClient",
        side_effect=lambda **kw: client_class(
            transport=httpx.MockTransport(respond), **kw
        ),
    )

    with pytest.raises(HTTPException) as error:
        await stream_artifact_file(
            db=Mock(),
            user_id=7,
            source=RemoteWorkspaceArtifactSource(
                executor_name="original",
                executor_namespace="namespace-a",
                workspace_root="/workspace/original-repository",
            ),
            relative_path="outputs/report.pdf",
            mime_type="application/pdf",
            disposition="attachment",
        )

    assert error.value.status_code == expected
    assert len(requests) == 1
    assert requests[0].url.path == "/filesystem/artifact"


@pytest.mark.parametrize(
    "chunk",
    [
        {"content_base64": "bad!", "offset": 0, "size": 1, "eof": True},
        {"content_base64": "YQ==", "offset": 1, "size": 2, "eof": True},
        {"content_base64": "", "offset": 0, "size": 2, "eof": False},
        {"content_base64": "YQ==", "offset": 0, "size": -1, "eof": True},
        {"content_base64": "YQ==", "offset": 0, "size": 2, "eof": True},
    ],
)
def test_rejects_malformed_or_incomplete_device_chunks(chunk: dict) -> None:
    with pytest.raises(HTTPException) as error:
        _decode_chunk({"success": True, "stdout": chunk}, 0)

    assert error.value.status_code == 502

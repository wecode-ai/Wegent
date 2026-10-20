# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock

import httpx
import pytest
from fastapi import HTTPException
from pytest_mock import MockerFixture

from app.schemas.remote_workspace import RemoteWorkspaceArtifactSource
from app.services.remote_workspace_artifact_files import (
    _decode_chunk,
    stream_artifact_file,
)


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

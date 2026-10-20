# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read artifact bytes only from the execution source captured at declaration."""

import base64
import binascii
from collections.abc import AsyncIterator
from pathlib import PurePosixPath
from typing import Any

import httpx
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.schemas.remote_workspace import RemoteWorkspaceArtifactSource
from app.services.device.command_service import (
    DeviceCommandError,
    execute_configured_device_command,
)
from app.services.remote_workspace_service import (
    REMOTE_WORKSPACE_FILE_TIMEOUT_SECONDS,
    remote_workspace_service,
)

MAX_ARTIFACT_FILE_BYTES = 50 * 1024 * 1024


async def stream_artifact_file(
    *,
    db: Session,
    user_id: int,
    source: RemoteWorkspaceArtifactSource,
    relative_path: str,
    mime_type: str,
    disposition: str,
) -> StreamingResponse:
    if source.executor_name.startswith("device-"):
        device_id = source.executor_name.removeprefix("device-")
        first = await _device_chunk(
            db, user_id, device_id, source.workspace_root, relative_path, 0
        )
        content = _device_chunks(
            db, user_id, device_id, source.workspace_root, relative_path, first
        )
    else:
        content = iter([await _executor_file(source, relative_path)])
    response = StreamingResponse(content, media_type=mime_type)
    response.headers["Content-Disposition"] = (
        remote_workspace_service._build_content_disposition(
            disposition, PurePosixPath(relative_path).name
        )
    )
    return response


async def _executor_file(
    source: RemoteWorkspaceArtifactSource, relative_path: str
) -> bytes:
    payload = await run_in_threadpool(
        remote_workspace_service._get_executor_payload,
        executor_name=source.executor_name,
        executor_namespace=source.executor_namespace,
    )
    if (
        not payload
        or str(payload.get("status", "")).lower() != "success"
        or not payload.get("base_url")
    ):
        raise HTTPException(409, "Artifact execution source is unavailable")
    try:
        async with httpx.AsyncClient(
            timeout=REMOTE_WORKSPACE_FILE_TIMEOUT_SECONDS
        ) as client:
            response = await client.get(
                f"{str(payload['base_url']).rstrip('/')}/filesystem/artifact",
                params={"root_path": source.workspace_root, "path": relative_path},
            )
    except httpx.HTTPError as error:
        raise HTTPException(503, "Artifact execution source is unavailable") from error
    if response.status_code in {400, 403, 404, 413}:
        raise HTTPException(response.status_code, "Artifact file is unavailable")
    if response.is_error:
        raise HTTPException(502, "Artifact file request failed")
    if len(response.content) > MAX_ARTIFACT_FILE_BYTES:
        raise HTTPException(413, "Artifact exceeds 50 MiB limit")
    return response.content


async def _device_chunk(
    db: Session, user_id: int, device_id: str, root: str, path: str, offset: int
) -> tuple[bytes, bool]:
    try:
        result = await execute_configured_device_command(
            db=db,
            user_id=user_id,
            device_id=device_id,
            command_key="workspace_read_file_chunk",
            path=root,
            args=[path, str(offset)],
            max_output_bytes=2 * 1024 * 1024,
        )
    except DeviceCommandError as error:
        raise HTTPException(409, "Artifact execution source is unavailable") from error
    return _decode_chunk(result, offset)


def _decode_chunk(result: dict[str, Any], offset: int) -> tuple[bytes, bool]:
    chunk = result.get("stdout")
    if not result.get("success") or not isinstance(chunk, dict):
        raise HTTPException(502, "Artifact file read failed")
    try:
        content = base64.b64decode(chunk["content_base64"], validate=True)
        if type(chunk["size"]) is not int or chunk["size"] < 0:
            raise ValueError("Invalid artifact file size")
        if chunk["size"] > MAX_ARTIFACT_FILE_BYTES:
            raise HTTPException(413, "Artifact exceeds 50 MiB limit")
        if (
            chunk["offset"] != offset
            or type(chunk["offset"]) is not int
            or not isinstance(chunk["eof"], bool)
            or offset + len(content) > chunk["size"]
            or chunk["eof"] != (offset + len(content) == chunk["size"])
            or offset + len(content) > MAX_ARTIFACT_FILE_BYTES
            or (not content and not chunk["eof"])
        ):
            raise ValueError("Invalid artifact file chunk")
        return content, chunk["eof"]
    except (KeyError, TypeError, ValueError, binascii.Error) as error:
        raise HTTPException(502, "Invalid artifact file response") from error


async def _device_chunks(
    db: Session,
    user_id: int,
    device_id: str,
    root: str,
    path: str,
    first: tuple[bytes, bool],
) -> AsyncIterator[bytes]:
    offset = 0
    content, eof = first
    while True:
        yield content
        offset += len(content)
        if eof:
            return
        content, eof = await _device_chunk(db, user_id, device_id, root, path, offset)

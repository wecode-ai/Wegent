# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared request-body handling for marketplace package uploads."""

from fastapi import HTTPException, Request


async def read_marketplace_package(
    request: Request,
    *,
    max_bytes: int,
    resource_name: str,
) -> bytes:
    """Read a raw package upload while enforcing its maximum size."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise HTTPException(
                    status_code=413, detail=f"{resource_name} package is too large"
                )
        except ValueError as exc:
            raise HTTPException(
                status_code=400, detail="Invalid Content-Length"
            ) from exc

    chunks: list[bytes] = []
    total_size = 0
    async for chunk in request.stream():
        total_size += len(chunk)
        if total_size > max_bytes:
            raise HTTPException(
                status_code=413, detail=f"{resource_name} package is too large"
            )
        chunks.append(chunk)
    if total_size == 0:
        raise HTTPException(status_code=400, detail=f"{resource_name} package is empty")
    return b"".join(chunks)

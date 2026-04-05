# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import httpx

from shared.models.knowledge_runtime_protocol import (
    BackendAttachmentStreamContentRef,
    PresignedUrlContentRef,
)


async def fetch_content(
    content_ref: BackendAttachmentStreamContentRef | PresignedUrlContentRef,
) -> bytes:
    headers = {}
    if content_ref.kind == "backend_attachment_stream":
        headers["Authorization"] = f"Bearer {content_ref.auth_token}"

    async with httpx.AsyncClient() as client:
        response = await client.get(content_ref.url, headers=headers)
        response.raise_for_status()
        return response.content

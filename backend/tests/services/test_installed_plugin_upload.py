# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException

from app.api.endpoints.installed_plugins import _read_plugin_upload
from app.services.claude_plugin_parser import MAX_PLUGIN_PACKAGE_SIZE_BYTES
from app.services.installed_plugin_service import InstalledPluginService


class ChunkedUpload:
    def __init__(self, chunks: list[bytes]):
        self._chunks = chunks

    async def read(self, _size: int) -> bytes:
        if not self._chunks:
            return b""
        return self._chunks.pop(0)


@pytest.mark.asyncio
async def test_read_plugin_upload_rejects_before_buffering_past_limit():
    upload = ChunkedUpload([b"a" * MAX_PLUGIN_PACKAGE_SIZE_BYTES, b"b"])

    with pytest.raises(HTTPException) as exc_info:
        await _read_plugin_upload(upload)  # type: ignore[arg-type]

    assert exc_info.value.status_code == 413


def test_safe_kind_name_uses_hash_suffix_to_avoid_slug_collisions():
    service = InstalledPluginService()

    assert service._safe_kind_name("my/plugin") != service._safe_kind_name("my plugin")
    assert len(service._safe_kind_name("x" * 200)) <= 100

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for authenticated Skill binary downloads."""

from unittest.mock import patch

import pytest
from pytest_httpx import HTTPXMock

from chat_shell.core.config import settings
from chat_shell.tools.skill_factory import _download_skill_binary


@pytest.mark.asyncio
async def test_download_sends_service_auth_and_request_id(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = "http://backend:8000/api/internal/skills/12/binary"
    monkeypatch.setattr(settings, "REMOTE_STORAGE_TOKEN", "service-token")
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "")
    httpx_mock.add_response(url=url, content=b"skill-zip")

    with patch(
        "chat_shell.tools.skill_factory.get_request_id",
        return_value="request-123",
    ):
        result = await _download_skill_binary(url, "sandbox")

    request = httpx_mock.get_request()
    assert result == b"skill-zip"
    assert request.headers["Authorization"] == "Bearer service-token"
    assert request.headers["X-Service-Name"] == "chat-shell"
    assert request.headers["X-Request-ID"] == "request-123"


@pytest.mark.asyncio
async def test_download_omits_request_id_when_context_is_empty(
    httpx_mock: HTTPXMock, monkeypatch: pytest.MonkeyPatch
) -> None:
    url = "http://backend:8000/api/internal/skills/12/binary"
    monkeypatch.setattr(settings, "REMOTE_STORAGE_TOKEN", "service-token")
    httpx_mock.add_response(url=url, content=b"skill-zip")

    with patch(
        "chat_shell.tools.skill_factory.get_request_id",
        return_value=None,
    ):
        result = await _download_skill_binary(url, "sandbox")

    request = httpx_mock.get_request()
    assert result == b"skill-zip"
    assert "X-Request-ID" not in request.headers
    assert request.headers["X-Service-Name"] == "chat-shell"

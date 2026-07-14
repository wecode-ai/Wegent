# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MinerU API client."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_engine.conversion.mineru_client import (
    SUPPORTED_MIME_TYPES,
    MinerUConfig,
    is_supported_extension,
    submit_and_wait,
)


def test_is_supported_extension_pdf():
    assert is_supported_extension("pdf") is True


def test_is_supported_extension_with_dot():
    assert is_supported_extension(".pdf") is True


def test_is_supported_extension_uppercase():
    assert is_supported_extension("PDF") is True


def test_is_supported_extension_docx():
    assert is_supported_extension("docx") is True


def test_is_supported_extension_unsupported():
    assert is_supported_extension("txt") is False
    assert is_supported_extension("jpg") is False
    assert is_supported_extension("doc") is False


def test_supported_mime_types_count():
    assert len(SUPPORTED_MIME_TYPES) == 4


def test_mineru_config_defaults():
    config = MinerUConfig(api_base_url="http://localhost:8367")
    assert config.backend == "pipeline"
    assert config.parse_method == "ocr"
    assert config.poll_interval_seconds == 3
    assert config.max_wait_seconds == 600
    assert config.formula_enable is True
    assert config.table_enable is True


@pytest.mark.asyncio
async def test_submit_and_wait_success():
    """Full submit/poll/download flow with mocked HTTP."""
    config = MinerUConfig(api_base_url="http://mineru:8367")
    zip_bytes = b"PK\x03\x04fake_zip_content"

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_class.return_value.__aexit__ = AsyncMock(return_value=None)

        submit_resp = MagicMock()
        submit_resp.raise_for_status = MagicMock()
        submit_resp.json.return_value = {"task_id": "test-task-123"}

        status_resp = MagicMock()
        status_resp.raise_for_status = MagicMock()
        status_resp.json.return_value = {"status": "completed"}

        download_resp = MagicMock()
        download_resp.raise_for_status = MagicMock()
        download_resp.headers = {"content-type": "application/zip"}
        download_resp.content = zip_bytes

        mock_client.post = AsyncMock(return_value=submit_resp)
        mock_client.get = AsyncMock(side_effect=[status_resp, download_resp])

        result = await submit_and_wait(b"pdf_content", "pdf", config)
        assert result == zip_bytes


@pytest.mark.asyncio
async def test_submit_and_wait_task_failed():
    """Task failure raises RuntimeError."""
    config = MinerUConfig(api_base_url="http://mineru:8367")

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_class.return_value.__aexit__ = AsyncMock(return_value=None)

        submit_resp = MagicMock()
        submit_resp.raise_for_status = MagicMock()
        submit_resp.json.return_value = {"task_id": "fail-task"}

        status_resp = MagicMock()
        status_resp.raise_for_status = MagicMock()
        status_resp.json.return_value = {"status": "failed"}

        mock_client.post = AsyncMock(return_value=submit_resp)
        mock_client.get = AsyncMock(return_value=status_resp)

        with pytest.raises(RuntimeError, match="MinerU task failed"):
            await submit_and_wait(b"pdf_content", "pdf", config)


@pytest.mark.asyncio
async def test_submit_and_wait_json_response_raises():
    """JSON content-type in download response raises RuntimeError."""
    config = MinerUConfig(api_base_url="http://mineru:8367")

    with patch("httpx.AsyncClient") as mock_client_class:
        mock_client = AsyncMock()
        mock_client_class.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_class.return_value.__aexit__ = AsyncMock(return_value=None)

        submit_resp = MagicMock()
        submit_resp.raise_for_status = MagicMock()
        submit_resp.json.return_value = {"task_id": "json-task"}

        status_resp = MagicMock()
        status_resp.raise_for_status = MagicMock()
        status_resp.json.return_value = {"status": "completed"}

        download_resp = MagicMock()
        download_resp.raise_for_status = MagicMock()
        download_resp.headers = {"content-type": "application/json"}
        download_resp.content = b"{}"

        mock_client.post = AsyncMock(return_value=submit_resp)
        mock_client.get = AsyncMock(side_effect=[status_resp, download_resp])

        with pytest.raises(RuntimeError, match="JSON instead of ZIP"):
            await submit_and_wait(b"pdf_content", "pdf", config)

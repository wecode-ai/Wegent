# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DataService DuckDB generation orchestration."""

from __future__ import annotations

import hashlib
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_runtime.services.data_service import DataService
from knowledge_runtime.services.duckdb_generator import DuckDBGenerateResult
from shared.models import BackendAttachmentStreamContentRef
from shared.models.data_analysis_protocol import RemoteDataGenerateRequest


def _make_content_ref() -> BackendAttachmentStreamContentRef:
    """Create a test content reference."""
    return BackendAttachmentStreamContentRef(
        kind="backend_attachment_stream",
        url="http://backend:8000/api/internal/rag/content/42",
        auth_token="test-token",
    )


def _make_request(**overrides) -> RemoteDataGenerateRequest:
    """Create a test generate request."""
    defaults = {
        "attachment_id": 42,
        "content_ref": _make_content_ref(),
        "source_file": "test_data",
        "file_extension": ".csv",
    }
    defaults.update(overrides)
    return RemoteDataGenerateRequest(**defaults)


class TestDataServiceSourceUnchanged:
    """Tests for DataService source file hash comparison."""

    @pytest.mark.asyncio
    async def test_source_unchanged_when_hash_matches(self) -> None:
        """Should return source_unchanged when hash matches existing hash."""
        source_bytes = b"id,name\n1,Alice\n"
        existing_hash = hashlib.sha256(source_bytes).hexdigest()

        mock_fetcher = MagicMock()
        mock_fetcher.fetch = AsyncMock(return_value=(source_bytes, "test_data", ".csv"))

        with patch.object(DataService, "__init__", lambda self: None):
            service = DataService()
            service._content_fetcher = mock_fetcher
            service._generator = MagicMock()
            service._uploader = MagicMock()

            request = _make_request(existing_source_file_hash=existing_hash)
            result = await service.generate_duckdb(request)

        assert result.success is True
        assert result.source_unchanged is True
        assert result.source_file_hash == existing_hash
        # Generator should NOT be called when source is unchanged
        service._generator.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_source_changed_proceeds_with_generation(self) -> None:
        """Should proceed with generation when hash differs."""
        source_bytes = b"id,name\n1,Alice\n"
        different_hash = "0" * 64  # Different from actual hash

        mock_fetcher = MagicMock()
        mock_fetcher.fetch = AsyncMock(return_value=(source_bytes, "test_data", ".csv"))

        generate_result = DuckDBGenerateResult(
            duckdb_bytes=b"fake_duckdb",
            summary={"test_data": []},
            tables=[],
            source_file_hash=hashlib.sha256(source_bytes).hexdigest(),
            source_file_size=len(source_bytes),
        )

        with patch.object(DataService, "__init__", lambda self: None):
            service = DataService()
            service._content_fetcher = mock_fetcher
            service._generator = MagicMock()
            service._generator.generate = AsyncMock(return_value=generate_result)
            service._uploader = MagicMock()
            service._uploader.upload = AsyncMock(return_value=99)

            request = _make_request(existing_source_file_hash=different_hash)
            result = await service.generate_duckdb(request)

        assert result.success is True
        assert result.source_unchanged is False
        # Generator SHOULD be called when source has changed
        service._generator.generate.assert_called_once()

    @pytest.mark.asyncio
    async def test_no_existing_hash_proceeds_with_generation(self) -> None:
        """Should proceed with generation when no existing hash is provided."""
        source_bytes = b"id,name\n1,Alice\n"

        mock_fetcher = MagicMock()

        generate_result = DuckDBGenerateResult(
            duckdb_bytes=b"fake_duckdb",
            summary={"test_data": []},
            tables=[],
            source_file_hash=hashlib.sha256(source_bytes).hexdigest(),
            source_file_size=len(source_bytes),
        )

        with patch.object(DataService, "__init__", lambda self: None):
            service = DataService()
            service._content_fetcher = mock_fetcher
            service._generator = MagicMock()
            service._generator.generate = AsyncMock(return_value=generate_result)
            service._uploader = MagicMock()
            service._uploader.upload = AsyncMock(return_value=99)

            request = _make_request()  # No existing_source_file_hash
            result = await service.generate_duckdb(request)

        assert result.success is True
        assert result.source_unchanged is False
        # Generator SHOULD be called when no existing hash
        service._generator.generate.assert_called_once()
        # Fetcher should NOT be called (only generator fetches)
        mock_fetcher.fetch.assert_not_called()

    @pytest.mark.asyncio
    async def test_source_file_hash_is_of_source_not_duckdb(self) -> None:
        """source_file_hash should be hash of source file, not DuckDB file."""
        source_bytes = b"id,name\n1,Alice\n"
        expected_hash = hashlib.sha256(source_bytes).hexdigest()

        generate_result = DuckDBGenerateResult(
            duckdb_bytes=b"completely_different_duckdb_bytes",
            summary={"test_data": []},
            tables=[],
            source_file_hash=expected_hash,
            source_file_size=len(source_bytes),
        )

        with patch.object(DataService, "__init__", lambda self: None):
            service = DataService()
            service._content_fetcher = MagicMock()
            service._generator = MagicMock()
            service._generator.generate = AsyncMock(return_value=generate_result)
            service._uploader = MagicMock()
            service._uploader.upload = AsyncMock(return_value=99)

            request = _make_request()
            result = await service.generate_duckdb(request)

        # The hash should be of the source file, not the DuckDB file
        assert result.source_file_hash == expected_hash
        assert (
            result.source_file_hash
            != hashlib.sha256(b"completely_different_duckdb_bytes").hexdigest()
        )

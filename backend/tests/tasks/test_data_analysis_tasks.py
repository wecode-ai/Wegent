# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DuckDB data analysis Celery tasks."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.tasks.data_analysis_tasks import generate_duckdb_task


class TestGenerateDuckdbTask:
    """Tests for generate_duckdb_task."""

    def test_disabled_feature_flag_returns_error(self) -> None:
        """Should return error when DuckDB feature is disabled."""
        with patch("app.tasks.data_analysis_tasks.settings") as mock_settings:
            mock_settings.DUCKDB_DATA_ANALYSIS_ENABLED = False
            result = generate_duckdb_task(
                attachment_id=1,
                user_id=1,
                source_file="test.csv",
                file_extension=".csv",
            )
        assert result["success"] is False
        assert "disabled" in result["error"]

    def test_unsupported_extension_returns_error(self) -> None:
        """Should return error for unsupported file extensions."""
        with patch("app.tasks.data_analysis_tasks.settings") as mock_settings:
            mock_settings.DUCKDB_DATA_ANALYSIS_ENABLED = True
            result = generate_duckdb_task(
                attachment_id=1,
                user_id=1,
                source_file="test.pdf",
                file_extension=".pdf",
            )
        assert result["success"] is False
        assert "Unsupported" in result["error"]

    @patch("app.tasks.data_analysis_tasks.SessionLocal")
    @patch("app.tasks.data_analysis_tasks.settings")
    def test_existing_ready_cache_with_hash_skips_generation(
        self, mock_settings, mock_session_cls
    ) -> None:
        """Should skip generation when cache is ready and has source_file_hash."""
        mock_settings.DUCKDB_DATA_ANALYSIS_ENABLED = True

        # Mock DuckDBCache entry with ready status and hash
        mock_cache = MagicMock()
        mock_cache.status = "ready"
        mock_cache.source_file_hash = "a" * 64
        mock_cache.duckdb_attachment_id = 42

        mock_db = MagicMock()
        # Return the same cache for all queries
        mock_db.query.return_value.filter.return_value.first.return_value = mock_cache

        # Set up SessionLocal as a context manager
        mock_session_cls.return_value = mock_db
        mock_db.__enter__ = MagicMock(return_value=mock_db)
        mock_db.__exit__ = MagicMock(return_value=False)

        result = generate_duckdb_task(
            attachment_id=1,
            user_id=1,
            source_file="test.csv",
            file_extension=".csv",
        )

        assert result["success"] is True
        assert result["duckdb_attachment_id"] == 42

    @patch("app.tasks.data_analysis_tasks.SessionLocal")
    @patch("app.tasks.data_analysis_tasks.settings")
    def test_existing_ready_cache_without_hash_proceeds(
        self, mock_settings, mock_session_cls
    ) -> None:
        """Should proceed with generation when cache is ready but has no hash."""
        mock_settings.DUCKDB_DATA_ANALYSIS_ENABLED = True

        # Mock DuckDBCache entry with ready status but no hash (legacy entry)
        mock_cache = MagicMock()
        mock_cache.status = "ready"
        mock_cache.source_file_hash = None

        mock_db = MagicMock()
        mock_session_cls.return_value = mock_db
        mock_db.__enter__ = MagicMock(return_value=mock_db)
        mock_db.__exit__ = MagicMock(return_value=False)

        with patch("app.tasks.data_analysis_tasks._call_kr_generate") as mock_call:
            mock_call.return_value = {
                "success": True,
                "duckdb_attachment_id": 99,
                "source_file_hash": "b" * 64,
                "source_unchanged": False,
                "summary": {},
                "tables": [],
                "duckdb_file_size": 1024,
            }

            # First query returns cache, subsequent queries return cache too
            mock_db.query.return_value.filter.return_value.first.return_value = (
                mock_cache
            )

            result = generate_duckdb_task(
                attachment_id=1,
                user_id=1,
                source_file="test.csv",
                file_extension=".csv",
            )

        # Should have called _call_kr_generate because no hash existed
        mock_call.assert_called_once()

    @patch("app.tasks.data_analysis_tasks.SessionLocal")
    @patch("app.tasks.data_analysis_tasks.settings")
    def test_source_unchanged_response_restores_ready_status(
        self, mock_settings, mock_session_cls
    ) -> None:
        """Should restore ready status when source file is unchanged."""
        mock_settings.DUCKDB_DATA_ANALYSIS_ENABLED = True

        # Mock DuckDBCache entry in generating state with hash
        mock_cache = MagicMock()
        mock_cache.status = "generating"
        mock_cache.source_file_hash = "a" * 64
        mock_cache.duckdb_attachment_id = 42

        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_cache
        mock_session_cls.return_value = mock_db
        mock_db.__enter__ = MagicMock(return_value=mock_db)
        mock_db.__exit__ = MagicMock(return_value=False)

        with patch("app.tasks.data_analysis_tasks._call_kr_generate") as mock_call:
            mock_call.return_value = {
                "success": True,
                "source_file_hash": "a" * 64,
                "source_unchanged": True,
            }

            result = generate_duckdb_task(
                attachment_id=1,
                user_id=1,
                source_file="test.csv",
                file_extension=".csv",
            )

        assert result["success"] is True
        assert result["source_unchanged"] is True
        # Verify status was restored to ready
        assert mock_cache.status == "ready"


class TestCallKrGenerateHashPassing:
    """Tests for _call_kr_generate passing existing_source_file_hash.

    These tests mock the internal imports of httpx and create_rag_download_token
    since they are lazily imported inside _call_kr_generate.
    """

    def test_passes_existing_hash_in_request(self) -> None:
        """Should pass existing_source_file_hash in the request."""
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "success": True,
            "attachment_id": 1,
            "duckdb_attachment_id": 99,
            "source_file_hash": "a" * 64,
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.post.return_value = mock_response

        mock_httpx = MagicMock()
        mock_httpx.Client.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_httpx.Client.return_value.__exit__ = MagicMock(return_value=False)

        mock_token_fn = MagicMock(return_value="test-token")

        with (
            patch.dict("sys.modules", {"httpx": mock_httpx}),
            patch(
                "app.services.auth.rag_download_token.create_rag_download_token",
                mock_token_fn,
            ),
            patch("app.tasks.data_analysis_tasks.settings") as mock_settings,
        ):
            mock_settings.BACKEND_INTERNAL_URL = "http://backend:8000"
            mock_settings.API_PREFIX = "/api/v1"
            mock_settings.KNOWLEDGE_RUNTIME_URL = "http://kr:8200"
            mock_settings.INTERNAL_SERVICE_TOKEN = "test"

            from app.tasks.data_analysis_tasks import _call_kr_generate

            result = _call_kr_generate(
                attachment_id=1,
                user_id=1,
                source_file="test.csv",
                file_extension=".csv",
                existing_source_file_hash="a" * 64,
            )

        # Verify the request was made with the hash
        call_args = mock_client.post.call_args
        request_body = call_args.kwargs.get("json", call_args[1].get("json"))
        assert request_body["existing_source_file_hash"] == "a" * 64

    def test_no_hash_passed_when_none(self) -> None:
        """Should not pass existing_source_file_hash when it is None."""
        mock_response = MagicMock()
        mock_response.json.return_value = {
            "success": True,
            "attachment_id": 1,
            "duckdb_attachment_id": 99,
            "source_file_hash": "b" * 64,
        }
        mock_response.raise_for_status = MagicMock()

        mock_client = MagicMock()
        mock_client.post.return_value = mock_response

        mock_httpx = MagicMock()
        mock_httpx.Client.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_httpx.Client.return_value.__exit__ = MagicMock(return_value=False)

        mock_token_fn = MagicMock(return_value="test-token")

        with (
            patch.dict("sys.modules", {"httpx": mock_httpx}),
            patch(
                "app.services.auth.rag_download_token.create_rag_download_token",
                mock_token_fn,
            ),
            patch("app.tasks.data_analysis_tasks.settings") as mock_settings,
        ):
            mock_settings.BACKEND_INTERNAL_URL = "http://backend:8000"
            mock_settings.API_PREFIX = "/api/v1"
            mock_settings.KNOWLEDGE_RUNTIME_URL = "http://kr:8200"
            mock_settings.INTERNAL_SERVICE_TOKEN = "test"

            from app.tasks.data_analysis_tasks import _call_kr_generate

            result = _call_kr_generate(
                attachment_id=1,
                user_id=1,
                source_file="test.csv",
                file_extension=".csv",
                existing_source_file_hash=None,
            )

        call_args = mock_client.post.call_args
        request_body = call_args.kwargs.get("json", call_args[1].get("json"))
        assert request_body["existing_source_file_hash"] is None

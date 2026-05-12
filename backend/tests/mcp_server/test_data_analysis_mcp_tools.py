# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for data analysis MCP tools."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import data_analysis


class TestGetDuckDBInfo:
    """Tests for _get_duckdb_info helper."""

    def test_returns_info_when_cache_ready(self) -> None:
        """Should return duckdb info when cache entry is ready."""
        mock_db = MagicMock()

        # Mock SubtaskContext lookup
        mock_context = MagicMock()
        mock_context.type_data = {
            "duckdb_attachment_id": 99,
            "duckdb_summary": {"sales": [{"column_name": "id"}]},
            "duckdb_tables": [{"name": "sales", "row_count": 100, "columns": []}],
        }
        mock_db.query.return_value.filter.return_value.first.return_value = mock_context

        # Mock DuckDBCache lookup
        mock_cache = MagicMock()
        mock_cache.status = "ready"
        mock_cache.duckdb_attachment_id = 99

        # Set up sequential query calls
        mock_db.query.side_effect = [
            MagicMock(filter=MagicMock(return_value=MagicMock(first=MagicMock(return_value=mock_context)))),
            MagicMock(filter=MagicMock(return_value=MagicMock(first=MagicMock(return_value=mock_cache)))),
        ]

        # Mock content ref building
        mock_content_ref = MagicMock()
        mock_content_ref.model_dump.return_value = {
            "kind": "backend_attachment_stream",
            "url": "http://backend:8000/api/internal/rag/content/99",
            "auth_token": "test-token",
        }

        with patch.object(
            data_analysis, "build_content_ref_for_duckdb", return_value=mock_content_ref
        ):
            result = data_analysis._get_duckdb_info(
                db=mock_db, attachment_id=42, user_id=1
            )

        assert result is not None
        assert result["duckdb_attachment_id"] == 99
        assert "content_ref" in result
        assert "summary" in result
        assert "tables" in result

    def test_returns_none_when_context_not_found(self) -> None:
        """Should return None when no context record exists."""
        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = None

        result = data_analysis._get_duckdb_info(
            db=mock_db, attachment_id=42, user_id=1
        )
        assert result is None

    def test_returns_none_when_cache_not_ready(self) -> None:
        """Should return None when cache entry is not ready."""
        mock_db = MagicMock()

        # Mock SubtaskContext lookup
        mock_context = MagicMock()
        mock_context.type_data = {}

        # Mock DuckDBCache lookup - status is "generating"
        mock_cache = MagicMock()
        mock_cache.status = "generating"

        mock_db.query.side_effect = [
            MagicMock(filter=MagicMock(return_value=MagicMock(first=MagicMock(return_value=mock_context)))),
            MagicMock(filter=MagicMock(return_value=MagicMock(first=MagicMock(return_value=mock_cache)))),
        ]

        result = data_analysis._get_duckdb_info(
            db=mock_db, attachment_id=42, user_id=1
        )
        assert result is None

    def test_returns_none_when_no_cache_entry(self) -> None:
        """Should return None when no cache entry exists."""
        mock_db = MagicMock()

        # Mock SubtaskContext lookup
        mock_context = MagicMock()
        mock_context.type_data = {}

        # Mock DuckDBCache lookup - no entry
        mock_db.query.side_effect = [
            MagicMock(filter=MagicMock(return_value=MagicMock(first=MagicMock(return_value=mock_context)))),
            MagicMock(filter=MagicMock(return_value=MagicMock(first=MagicMock(return_value=None)))),
        ]

        result = data_analysis._get_duckdb_info(
            db=mock_db, attachment_id=42, user_id=1
        )
        assert result is None


class TestGetDataSchemaTool:
    """Tests for wegent_data_schema MCP tool."""

    def test_tool_registered_in_module(self) -> None:
        """get_data_schema function should exist in the module."""
        assert hasattr(data_analysis, "get_data_schema")
        assert callable(data_analysis.get_data_schema)

    def test_returns_error_when_no_duckdb_attachment(self) -> None:
        """Should return error when no DuckDB attachment ID is found."""
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="testuser",
        )

        with patch.object(data_analysis, "SessionLocal") as mock_session_cls:
            mock_db = MagicMock()
            mock_session_cls.return_value = mock_db
            mock_db.__enter__ = MagicMock(return_value=mock_db)
            mock_db.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_info",
                return_value=None,
            ):
                result = data_analysis.get_data_schema(
                    attachment_id=42,
                    token_info=token_info,
                )

        assert result["success"] is False
        assert "No DuckDB data found" in result["error"]

    def test_returns_schema_with_content_ref(self) -> None:
        """Should return schema info and content_ref when DuckDB exists."""
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="testuser",
        )

        info = {
            "duckdb_attachment_id": 99,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/99",
                "auth_token": "test-token",
            },
            "summary": {"sales": [{"column_name": "id", "column_type": "INTEGER"}]},
            "tables": [
                {
                    "name": "sales",
                    "row_count": 100,
                    "columns": [
                        {"name": "id", "type": "INTEGER", "null_count": 0},
                        {"name": "name", "type": "VARCHAR", "null_count": 5},
                    ],
                }
            ],
        }

        with patch.object(data_analysis, "SessionLocal") as mock_session_cls:
            mock_db = MagicMock()
            mock_session_cls.return_value = mock_db
            mock_db.__enter__ = MagicMock(return_value=mock_db)
            mock_db.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_info",
                return_value=info,
            ):
                result = data_analysis.get_data_schema(
                    attachment_id=42,
                    token_info=token_info,
                )

        assert result["success"] is True
        assert result["attachment_id"] == 42
        assert len(result["tables"]) == 1
        assert result["tables"][0]["name"] == "sales"
        assert "content_ref" in result
        assert "summary" in result


class TestExecuteDataQueryTool:
    """Tests for wegent_data_query MCP tool."""

    def test_tool_registered_in_module(self) -> None:
        """execute_data_query function should exist in the module."""
        assert hasattr(data_analysis, "execute_data_query")
        assert callable(data_analysis.execute_data_query)

    def test_returns_error_when_no_duckdb_attachment(self) -> None:
        """Should return error when no DuckDB attachment ID is found."""
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="testuser",
        )

        with patch.object(data_analysis, "SessionLocal") as mock_session_cls:
            mock_db = MagicMock()
            mock_session_cls.return_value = mock_db
            mock_db.__enter__ = MagicMock(return_value=mock_db)
            mock_db.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_info",
                return_value=None,
            ):
                result = data_analysis.execute_data_query(
                    attachment_id=42,
                    sql="SELECT * FROM data_db.sales",
                    token_info=token_info,
                )

        assert result["success"] is False
        assert "No DuckDB data found" in result["error"]

    def test_returns_content_ref_and_tables(self) -> None:
        """Should return content_ref and table names for local execution."""
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="testuser",
        )

        info = {
            "duckdb_attachment_id": 99,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/99",
                "auth_token": "test-token",
            },
            "summary": {},
            "tables": [
                {"name": "sales", "row_count": 100, "columns": []},
                {"name": "orders", "row_count": 50, "columns": []},
            ],
        }

        with patch.object(data_analysis, "SessionLocal") as mock_session_cls:
            mock_db = MagicMock()
            mock_session_cls.return_value = mock_db
            mock_db.__enter__ = MagicMock(return_value=mock_db)
            mock_db.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_info",
                return_value=info,
            ):
                result = data_analysis.execute_data_query(
                    attachment_id=42,
                    sql="SELECT * FROM data_db.sales",
                    token_info=token_info,
                )

        assert result["success"] is True
        assert "content_ref" in result
        assert result["tables"] == ["sales", "orders"]
        assert result["sql"] == "SELECT * FROM data_db.sales"
        assert "instruction" in result

    def test_handles_exception_gracefully(self) -> None:
        """Should return error dict on unexpected exceptions."""
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="testuser",
        )

        with patch.object(data_analysis, "SessionLocal") as mock_session_cls:
            mock_db = MagicMock()
            mock_session_cls.return_value = mock_db
            mock_db.__enter__ = MagicMock(return_value=mock_db)
            mock_db.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_info",
                side_effect=RuntimeError("Database connection failed"),
            ):
                result = data_analysis.execute_data_query(
                    attachment_id=42,
                    sql="SELECT 1",
                    token_info=token_info,
                )

        assert result["success"] is False
        assert "error" in result

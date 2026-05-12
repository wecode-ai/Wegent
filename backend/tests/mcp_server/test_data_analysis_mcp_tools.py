# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for data analysis MCP tools."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import data_analysis


class TestGetDuckDBAttachmentId:
    """Tests for _get_duckdb_attachment_id helper."""

    def test_returns_duckdb_attachment_id_when_found(self) -> None:
        """Should return duckdb_attachment_id when type_data contains it."""
        mock_db = MagicMock()
        mock_context = MagicMock()
        mock_context.type_data = {"duckdb_attachment_id": 99}
        mock_db.query.return_value.filter.return_value.first.return_value = mock_context

        result = data_analysis._get_duckdb_attachment_id(
            db=mock_db, attachment_id=42, user_id=1
        )
        assert result == 99

    def test_returns_none_when_context_not_found(self) -> None:
        """Should return None when no context record exists."""
        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = None

        result = data_analysis._get_duckdb_attachment_id(
            db=mock_db, attachment_id=42, user_id=1
        )
        assert result is None

    def test_returns_none_when_no_duckdb_key(self) -> None:
        """Should return None when type_data has no duckdb_attachment_id."""
        mock_db = MagicMock()
        mock_context = MagicMock()
        mock_context.type_data = {"other_key": "value"}
        mock_db.query.return_value.filter.return_value.first.return_value = mock_context

        result = data_analysis._get_duckdb_attachment_id(
            db=mock_db, attachment_id=42, user_id=1
        )
        assert result is None

    def test_returns_none_when_type_data_is_none(self) -> None:
        """Should return None when type_data is None."""
        mock_db = MagicMock()
        mock_context = MagicMock()
        mock_context.type_data = None
        mock_db.query.return_value.filter.return_value.first.return_value = mock_context

        result = data_analysis._get_duckdb_attachment_id(
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
            mock_session_cls.return_value.__enter__ = MagicMock(return_value=mock_db)
            mock_session_cls.return_value.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_attachment_id",
                return_value=None,
            ):
                result = data_analysis.get_data_schema(
                    attachment_id=42,
                    token_info=token_info,
                )

        assert result["success"] is False
        assert "No DuckDB data found" in result["error"]

    def test_calls_kr_schema_when_duckdb_attachment_exists(self) -> None:
        """Should call knowledge_runtime schema endpoint when DuckDB exists."""
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="testuser",
        )

        expected_result = {
            "success": True,
            "attachment_id": 42,
            "tables": [{"name": "sales", "row_count": 100, "columns": []}],
            "error": None,
        }

        with patch.object(data_analysis, "SessionLocal") as mock_session_cls:
            mock_db = MagicMock()
            mock_session_cls.return_value.__enter__ = MagicMock(return_value=mock_db)
            mock_session_cls.return_value.__exit__ = MagicMock(return_value=False)

            with (
                patch.object(
                    data_analysis,
                    "_get_duckdb_attachment_id",
                    return_value=99,
                ),
                patch.object(
                    data_analysis,
                    "_call_kr_schema",
                    return_value=expected_result,
                ) as mock_call_kr,
            ):
                result = data_analysis.get_data_schema(
                    attachment_id=42,
                    token_info=token_info,
                )

        assert result["success"] is True
        mock_call_kr.assert_called_once_with(
            attachment_id=42,
            duckdb_attachment_id=99,
        )


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
            mock_session_cls.return_value.__enter__ = MagicMock(return_value=mock_db)
            mock_session_cls.return_value.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_attachment_id",
                return_value=None,
            ):
                result = data_analysis.execute_data_query(
                    attachment_id=42,
                    sql="SELECT * FROM data_db.sales",
                    token_info=token_info,
                )

        assert result["success"] is False
        assert "No DuckDB data found" in result["error"]

    def test_calls_kr_query_when_duckdb_attachment_exists(self) -> None:
        """Should call knowledge_runtime query endpoint when DuckDB exists."""
        token_info = TaskTokenInfo(
            task_id=1,
            subtask_id=2,
            user_id=3,
            user_name="testuser",
        )

        expected_result = {
            "success": True,
            "columns": ["id", "name"],
            "rows": [[1, "Alice"]],
            "row_count": 1,
            "truncated": False,
            "error": None,
        }

        with patch.object(data_analysis, "SessionLocal") as mock_session_cls:
            mock_db = MagicMock()
            mock_session_cls.return_value.__enter__ = MagicMock(return_value=mock_db)
            mock_session_cls.return_value.__exit__ = MagicMock(return_value=False)

            with (
                patch.object(
                    data_analysis,
                    "_get_duckdb_attachment_id",
                    return_value=99,
                ),
                patch.object(
                    data_analysis,
                    "_call_kr_query",
                    return_value=expected_result,
                ) as mock_call_kr,
            ):
                result = data_analysis.execute_data_query(
                    attachment_id=42,
                    sql="SELECT * FROM data_db.sales",
                    token_info=token_info,
                )

        assert result["success"] is True
        mock_call_kr.assert_called_once_with(
            attachment_id=42,
            duckdb_attachment_id=99,
            sql="SELECT * FROM data_db.sales",
        )

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
            mock_session_cls.return_value.__enter__ = MagicMock(return_value=mock_db)
            mock_session_cls.return_value.__exit__ = MagicMock(return_value=False)

            with patch.object(
                data_analysis,
                "_get_duckdb_attachment_id",
                side_effect=RuntimeError("Database connection failed"),
            ):
                result = data_analysis.execute_data_query(
                    attachment_id=42,
                    sql="SELECT 1",
                    token_info=token_info,
                )

        assert result["success"] is False
        assert "error" in result

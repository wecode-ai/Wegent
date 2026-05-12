# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DuckDB query execution service."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import duckdb
import pytest

from knowledge_runtime.services.duckdb_manager import DuckDBManager
from knowledge_runtime.services.duckdb_query import (
    DuckDBQueryResult,
    DuckDBQueryService,
    DuckDBSchemaResult,
)
from shared.models import BackendAttachmentStreamContentRef


def _make_content_ref() -> BackendAttachmentStreamContentRef:
    """Create a test content reference."""
    return BackendAttachmentStreamContentRef(
        kind="backend_attachment_stream",
        url="http://backend:8000/api/internal/rag/content/42",
        auth_token="test-token",
    )


def _create_test_duckdb_file() -> Path:
    """Create a small DuckDB file with test data for query testing."""
    tmp_dir = tempfile.mkdtemp(prefix="duckdb_test_")
    db_path = Path(tmp_dir) / "test.duckdb"

    conn = duckdb.connect(str(db_path))
    try:
        conn.execute("CREATE TABLE sales (id INTEGER, name VARCHAR, amount DOUBLE)")
        conn.execute(
            "INSERT INTO sales VALUES (1, 'Alice', 100.0), (2, 'Bob', 200.0), (3, 'Charlie', 150.0)"
        )
        conn.execute("CHECKPOINT")
    finally:
        conn.close()

    return db_path


@pytest.fixture
def mock_settings():
    """Create mock settings for query service."""
    settings = MagicMock()
    settings.duckdb_query_timeout = 30
    settings.duckdb_cache_dir = "/tmp/wegent_duckdb_cache_test"
    settings.duckdb_cache_max_size_gb = 5.0
    settings.duckdb_cache_ttl_hours = 24
    settings.content_fetch_timeout = 120
    return settings


@pytest.fixture
def mock_manager(mock_settings):
    """Create a mock DuckDBManager."""
    with patch(
        "knowledge_runtime.services.duckdb_manager.get_settings",
        return_value=mock_settings,
    ):
        manager = MagicMock(spec=DuckDBManager)
        return manager


@pytest.fixture
def query_service(mock_manager, mock_settings):
    """Create a DuckDBQueryService with mocked dependencies."""
    with patch(
        "knowledge_runtime.services.duckdb_query.get_settings",
        return_value=mock_settings,
    ):
        service = DuckDBQueryService(manager=mock_manager)
        return service


class TestSQLValidation:
    """Tests for SQL keyword validation."""

    def test_blocked_keyword_drop(self, query_service) -> None:
        """DROP keyword should be blocked."""
        error = query_service._validate_sql("DROP TABLE sales")
        assert error is not None
        assert "DROP" in error

    def test_blocked_keyword_delete(self, query_service) -> None:
        """DELETE keyword should be blocked."""
        error = query_service._validate_sql("DELETE FROM sales")
        assert error is not None
        assert "DELETE" in error

    def test_blocked_keyword_insert(self, query_service) -> None:
        """INSERT keyword should be blocked."""
        error = query_service._validate_sql("INSERT INTO sales VALUES (1, 'x')")
        assert error is not None
        assert "INSERT" in error

    def test_blocked_keyword_update(self, query_service) -> None:
        """UPDATE keyword should be blocked."""
        error = query_service._validate_sql("UPDATE sales SET amount = 0")
        assert error is not None
        assert "UPDATE" in error

    def test_blocked_keyword_alter(self, query_service) -> None:
        """ALTER keyword should be blocked."""
        error = query_service._validate_sql("ALTER TABLE sales ADD COLUMN x INT")
        assert error is not None
        assert "ALTER" in error

    def test_blocked_keyword_attach(self, query_service) -> None:
        """ATTACH keyword should be blocked."""
        error = query_service._validate_sql("ATTACH 'file.db' AS extra")
        assert error is not None
        assert "ATTACH" in error

    def test_blocked_keyword_detach(self, query_service) -> None:
        """DETACH keyword should be blocked."""
        error = query_service._validate_sql("DETACH extra")
        assert error is not None
        assert "DETACH" in error

    def test_blocked_keyword_copy(self, query_service) -> None:
        """COPY keyword should be blocked."""
        error = query_service._validate_sql("COPY sales TO 'output.csv'")
        assert error is not None
        assert "COPY" in error

    def test_blocked_keyword_export(self, query_service) -> None:
        """EXPORT keyword should be blocked."""
        error = query_service._validate_sql("EXPORT DATABASE 'output_dir'")
        assert error is not None
        assert "EXPORT" in error

    def test_blocked_keyword_pragma(self, query_service) -> None:
        """PRAGMA keyword should be blocked."""
        error = query_service._validate_sql("PRAGMA version")
        assert error is not None
        assert "PRAGMA" in error

    def test_blocked_keyword_load(self, query_service) -> None:
        """LOAD keyword should be blocked."""
        error = query_service._validate_sql("LOAD json")
        assert error is not None
        assert "LOAD" in error

    def test_blocked_keyword_install(self, query_service) -> None:
        """INSTALL keyword should be blocked."""
        error = query_service._validate_sql("INSTALL json")
        assert error is not None
        assert "INSTALL" in error

    def test_allowed_select(self, query_service) -> None:
        """SELECT queries should be allowed."""
        error = query_service._validate_sql(
            "SELECT * FROM data_db.sales WHERE amount > 100"
        )
        assert error is None

    def test_allowed_create_temp_table(self, query_service) -> None:
        """CREATE TEMP TABLE should be allowed."""
        error = query_service._validate_sql(
            "CREATE TEMP TABLE temp_results AS SELECT * FROM data_db.sales"
        )
        assert error is None

    def test_allowed_create_temporary_view(self, query_service) -> None:
        """CREATE TEMPORARY VIEW should be allowed."""
        error = query_service._validate_sql(
            "CREATE TEMPORARY VIEW temp_view AS SELECT * FROM data_db.sales"
        )
        assert error is None

    def test_blocked_create_permanent_table(self, query_service) -> None:
        """CREATE TABLE (non-temp) should be blocked."""
        error = query_service._validate_sql(
            "CREATE TABLE new_table AS SELECT * FROM data_db.sales"
        )
        assert error is not None
        assert "CREATE" in error


class TestMemoryAndAttachPattern:
    """Tests for :memory: + ATTACH read-only query execution."""

    def test_execute_query_sync_uses_attach_readonly(self, query_service) -> None:
        """_execute_query_sync should use ATTACH with READ_ONLY mode."""
        db_path = _create_test_duckdb_file()

        try:
            result = query_service._execute_query_sync(
                duckdb_path=db_path,
                sql="SELECT COUNT(*) as cnt FROM data_db.sales",
                max_rows=5000,
            )

            assert isinstance(result, DuckDBQueryResult)
            assert result.error is None
            assert "cnt" in result.columns
            assert result.row_count == 1
            assert result.rows[0][0] == 3
        finally:
            # Cleanup
            import shutil

            shutil.rmtree(db_path.parent, ignore_errors=True)

    def test_execute_query_sync_enforces_max_rows(self, query_service) -> None:
        """_execute_query_sync should truncate results exceeding max_rows."""
        db_path = _create_test_duckdb_file()

        try:
            result = query_service._execute_query_sync(
                duckdb_path=db_path,
                sql="SELECT * FROM data_db.sales",
                max_rows=2,
            )

            assert result.row_count == 2
            assert result.truncated is True
            assert result.total_count == 3
        finally:
            import shutil

            shutil.rmtree(db_path.parent, ignore_errors=True)


class TestResultTruncation:
    """Tests for result truncation behavior."""

    def test_result_not_truncated_when_under_limit(self, query_service) -> None:
        """Results under max_rows should not be truncated."""
        db_path = _create_test_duckdb_file()

        try:
            result = query_service._execute_query_sync(
                duckdb_path=db_path,
                sql="SELECT * FROM data_db.sales",
                max_rows=5000,
            )

            assert result.truncated is False
            assert result.row_count == 3
            assert result.total_count is None
        finally:
            import shutil

            shutil.rmtree(db_path.parent, ignore_errors=True)

    def test_result_truncated_with_total_count(self, query_service) -> None:
        """Truncated results should include total_count."""
        db_path = _create_test_duckdb_file()

        try:
            result = query_service._execute_query_sync(
                duckdb_path=db_path,
                sql="SELECT * FROM data_db.sales",
                max_rows=1,
            )

            assert result.truncated is True
            assert result.total_count == 3
            assert result.row_count == 1
        finally:
            import shutil

            shutil.rmtree(db_path.parent, ignore_errors=True)


class TestSchemaExtraction:
    """Tests for schema extraction from DuckDB files."""

    def test_execute_schema_sync_returns_table_info(self, query_service) -> None:
        """_execute_schema_sync should return table and column metadata."""
        db_path = _create_test_duckdb_file()

        try:
            result = query_service._execute_schema_sync(duckdb_path=db_path)

            assert isinstance(result, DuckDBSchemaResult)
            assert result.error is None
            assert len(result.tables) == 1
            assert result.tables[0].name == "sales"
            assert result.tables[0].row_count == 3
            assert len(result.tables[0].columns) == 3

            # Verify column names
            col_names = [c.name for c in result.tables[0].columns]
            assert "id" in col_names
            assert "name" in col_names
            assert "amount" in col_names
        finally:
            import shutil

            shutil.rmtree(db_path.parent, ignore_errors=True)

    def test_execute_schema_sync_column_types(self, query_service) -> None:
        """_execute_schema_sync should report correct column types."""
        db_path = _create_test_duckdb_file()

        try:
            result = query_service._execute_schema_sync(duckdb_path=db_path)

            col_info = {c.name: c for c in result.tables[0].columns}
            assert "INTEGER" in col_info["id"].type.upper()
            # VARCHAR or TEXT are both valid for string columns
            assert "DOUBLE" in col_info["amount"].type.upper()
        finally:
            import shutil

            shutil.rmtree(db_path.parent, ignore_errors=True)

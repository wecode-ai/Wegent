# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DuckDB query execution service in Executor."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import duckdb
import pytest

from executor.services.duckdb_query import DuckDBQueryExecutor


@pytest.fixture
def temp_cache_dir(tmp_path):
    """Create a temporary cache directory."""
    cache_dir = tmp_path / "duckdb_cache"
    cache_dir.mkdir()
    return str(cache_dir)


@pytest.fixture
def executor(temp_cache_dir):
    """Create a DuckDBQueryExecutor with a temporary cache directory."""
    return DuckDBQueryExecutor(cache_dir=temp_cache_dir)


@pytest.fixture
def sample_duckdb_path(tmp_path):
    """Create a sample .duckdb file with a test table."""
    db_path = tmp_path / "test_data.duckdb"
    conn = duckdb.connect(str(db_path))
    conn.execute("CREATE TABLE sales (id INTEGER, name VARCHAR, amount DOUBLE)")
    conn.execute("INSERT INTO sales VALUES (1, 'Alice', 100.0), (2, 'Bob', 200.0)")
    conn.execute("CHECKPOINT")
    conn.close()
    return db_path


class TestDuckDBQueryExecutorInit:
    """Tests for DuckDBQueryExecutor initialization."""

    def test_creates_cache_dir(self, tmp_path) -> None:
        """Should create cache directory on init."""
        cache_dir = tmp_path / "new_cache"
        executor = DuckDBQueryExecutor(cache_dir=str(cache_dir))
        assert Path(cache_dir).exists()

    def test_default_cache_dir(self) -> None:
        """Should use default cache dir."""
        executor = DuckDBQueryExecutor()
        assert executor.cache_dir == Path("/tmp/wegent_duckdb_cache")


class TestGetCachePath:
    """Tests for cache path generation."""

    def test_returns_consistent_path(self, executor) -> None:
        """Should return consistent path for same attachment_id."""
        path1 = executor.get_cache_path(42)
        path2 = executor.get_cache_path(42)
        assert path1 == path2

    def test_returns_different_paths_for_different_ids(self, executor) -> None:
        """Should return different paths for different attachment IDs."""
        path1 = executor.get_cache_path(42)
        path2 = executor.get_cache_path(99)
        assert path1 != path2

    def test_path_has_duckdb_extension(self, executor) -> None:
        """Should return path with .duckdb extension."""
        path = executor.get_cache_path(42)
        assert path.suffix == ".duckdb"


class TestEnsureCached:
    """Tests for ensure_cached method."""

    @pytest.mark.asyncio
    async def test_returns_existing_cached_file(
        self, executor, sample_duckdb_path
    ) -> None:
        """Should return existing cached file without downloading."""
        # Pre-populate cache
        cache_path = executor.get_cache_path(42)
        cache_path.write_bytes(sample_duckdb_path.read_bytes())

        result = await executor.ensure_cached(
            attachment_id=42,
            content_ref={"url": "http://example.com/file", "auth_token": "tok"},
        )

        assert result == cache_path

    @pytest.mark.asyncio
    async def test_downloads_file_when_not_cached(
        self, executor, sample_duckdb_path
    ) -> None:
        """Should download and cache the .duckdb file."""
        duckdb_bytes = sample_duckdb_path.read_bytes()

        mock_response = MagicMock()
        mock_response.content = duckdb_bytes
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.get = AsyncMock(return_value=mock_response)

        with patch(
            "executor.services.duckdb_query.httpx.AsyncClient", return_value=mock_client
        ):
            result = await executor.ensure_cached(
                attachment_id=42,
                content_ref={
                    "url": "http://backend:8000/api/internal/rag/content/99",
                    "auth_token": "test-token",
                },
            )

        assert result.exists()
        assert result == executor.get_cache_path(42)

    @pytest.mark.asyncio
    async def test_uses_auth_token_in_request(
        self, executor, sample_duckdb_path
    ) -> None:
        """Should include auth token in download request headers."""
        duckdb_bytes = sample_duckdb_path.read_bytes()

        mock_response = MagicMock()
        mock_response.content = duckdb_bytes
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_client.get = AsyncMock(return_value=mock_response)

        with patch(
            "executor.services.duckdb_query.httpx.AsyncClient", return_value=mock_client
        ):
            await executor.ensure_cached(
                attachment_id=42,
                content_ref={
                    "url": "http://backend:8000/api/internal/rag/content/99",
                    "auth_token": "my-token",
                },
            )

        mock_client.get.assert_called_once()
        call_kwargs = mock_client.get.call_args
        assert call_kwargs[1]["headers"]["Authorization"] == "Bearer my-token"


class TestExecuteQuery:
    """Tests for execute_query method."""

    def test_select_query(self, executor, sample_duckdb_path) -> None:
        """Should execute a SELECT query and return results."""
        result = executor.execute_query(
            duckdb_path=sample_duckdb_path,
            sql="SELECT * FROM data_db.sales ORDER BY id",
        )

        assert result["success"] is True
        assert result["columns"] == ["id", "name", "amount"]
        assert result["row_count"] == 2
        assert result["rows"][0] == [1, "Alice", 100.0]
        assert result["truncated"] is False

    def test_query_with_max_rows(self, executor, sample_duckdb_path) -> None:
        """Should truncate results when exceeding max_rows."""
        result = executor.execute_query(
            duckdb_path=sample_duckdb_path,
            sql="SELECT * FROM data_db.sales",
            max_rows=1,
        )

        assert result["success"] is True
        assert result["row_count"] == 1
        assert result["truncated"] is True
        assert result["total_count"] == 2

    def test_write_operation_rejected_by_readonly(
        self, executor, sample_duckdb_path
    ) -> None:
        """Should reject write operations via READ_ONLY connection."""
        result = executor.execute_query(
            duckdb_path=sample_duckdb_path,
            sql="DROP TABLE data_db.sales",
        )

        assert result["success"] is False
        # READ_ONLY connection prevents write operations
        assert "error" in result

    def test_invalid_sql(self, executor, sample_duckdb_path) -> None:
        """Should return error for invalid SQL."""
        result = executor.execute_query(
            duckdb_path=sample_duckdb_path,
            sql="SELECTT * FROM nonexistent",
        )

        assert result["success"] is False
        assert "error" in result

    def test_non_serializable_types_converted(self, executor, tmp_path) -> None:
        """Should convert non-serializable types to string."""
        db_path = tmp_path / "test_types.duckdb"
        conn = duckdb.connect(str(db_path))
        conn.execute("CREATE TABLE test_data (id INTEGER, data BLOB)")
        conn.execute("INSERT INTO test_data VALUES (1, BLOB '\\x01\\x02\\x03')")
        conn.execute("CHECKPOINT")
        conn.close()

        result = executor.execute_query(
            duckdb_path=db_path,
            sql="SELECT * FROM data_db.test_data",
        )

        assert result["success"] is True
        # BLOB values should be converted to string
        assert len(result["rows"]) == 1


class TestGetSchema:
    """Tests for get_schema method."""

    def test_returns_table_info(self, executor, sample_duckdb_path) -> None:
        """Should return table names and column metadata."""
        result = executor.get_schema(duckdb_path=sample_duckdb_path)

        assert result["success"] is True
        assert len(result["tables"]) == 1

        table = result["tables"][0]
        assert table["name"] == "sales"
        assert table["row_count"] == 2
        assert len(table["columns"]) == 3

        col_names = [col["name"] for col in table["columns"]]
        assert "id" in col_names
        assert "name" in col_names
        assert "amount" in col_names

    def test_column_metadata(self, executor, sample_duckdb_path) -> None:
        """Should include type and null_count in column metadata."""
        result = executor.get_schema(duckdb_path=sample_duckdb_path)

        table = result["tables"][0]
        for col in table["columns"]:
            assert "name" in col
            assert "type" in col
            assert "null_count" in col

    def test_invalid_path(self, executor) -> None:
        """Should return error for non-existent path."""
        result = executor.get_schema(duckdb_path=Path("/nonexistent/path.duckdb"))

        assert result["success"] is False
        assert "error" in result

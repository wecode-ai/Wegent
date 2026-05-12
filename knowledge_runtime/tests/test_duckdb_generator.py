# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for DuckDB file generation service."""

from __future__ import annotations

import csv
import hashlib
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from knowledge_runtime.services.duckdb_generator import (
    DuckDBGenerateResult,
    DuckDBGenerator,
)
from shared.models import BackendAttachmentStreamContentRef


@pytest.fixture
def mock_settings():
    """Create mock settings for DuckDB generator."""
    settings = MagicMock()
    settings.duckdb_max_file_size_mb = 500
    settings.duckdb_min_free_memory_mb = 512
    settings.duckdb_memory_limit = "4GB"
    settings.duckdb_temp_dir = "/tmp/duckdb_spill"
    settings.duckdb_summary_sample_rows = 50
    return settings


@pytest.fixture
def mock_content_fetcher():
    """Create a mock ContentFetcher."""
    with patch(
        "knowledge_runtime.services.duckdb_generator.ContentFetcher"
    ) as mock_cls:
        fetcher = MagicMock()
        mock_cls.return_value = fetcher
        yield fetcher


@pytest.fixture
def generator(mock_settings, mock_content_fetcher):
    """Create a DuckDBGenerator with mocked dependencies."""
    with patch(
        "knowledge_runtime.services.duckdb_generator.get_settings",
        return_value=mock_settings,
    ):
        gen = DuckDBGenerator()
        return gen


def _make_csv_bytes(rows: list[list[str]], header: list[str]) -> bytes:
    """Create CSV file bytes from rows and header."""
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in rows:
        writer.writerow(row)
    return buf.getvalue().encode("utf-8")


def _make_content_ref() -> BackendAttachmentStreamContentRef:
    """Create a test content reference."""
    return BackendAttachmentStreamContentRef(
        kind="backend_attachment_stream",
        url="http://backend:8000/api/internal/rag/content/42",
        auth_token="test-token",
    )


class TestDuckDBGeneratorCSVImport:
    """Tests for CSV file import into DuckDB."""

    @pytest.mark.asyncio
    async def test_csv_import_creates_table_with_data(
        self, generator, mock_content_fetcher
    ) -> None:
        """CSV import should create a DuckDB table with the correct row count."""
        csv_bytes = _make_csv_bytes(
            rows=[
                ["1", "Alice", "30"],
                ["2", "Bob", "25"],
                ["3", "Charlie", "35"],
            ],
            header=["id", "name", "age"],
        )
        mock_content_fetcher.fetch = AsyncMock(
            return_value=(csv_bytes, "test_data", ".csv")
        )

        result = await generator.generate(
            content_ref=_make_content_ref(),
            source_file="test_data",
            file_extension=".csv",
        )

        assert isinstance(result, DuckDBGenerateResult)
        assert len(result.duckdb_bytes) > 0
        assert len(result.tables) >= 1
        # The table should have the imported rows
        table = result.tables[0]
        assert table.row_count == 3
        assert len(table.columns) == 3

    @pytest.mark.asyncio
    async def test_csv_import_computes_source_file_hash(
        self, generator, mock_content_fetcher
    ) -> None:
        """Generate should compute SHA256 hash of the source file bytes."""
        csv_bytes = _make_csv_bytes(
            rows=[
                ["1", "Alice", "30"],
                ["2", "Bob", "25"],
            ],
            header=["id", "name", "age"],
        )
        mock_content_fetcher.fetch = AsyncMock(
            return_value=(csv_bytes, "test_data", ".csv")
        )

        result = await generator.generate(
            content_ref=_make_content_ref(),
            source_file="test_data",
            file_extension=".csv",
        )

        # Verify source_file_hash is the SHA256 of the source bytes (not DuckDB bytes)
        expected_hash = hashlib.sha256(csv_bytes).hexdigest()
        assert result.source_file_hash == expected_hash
        assert len(result.source_file_hash) == 64  # SHA256 hex length
        assert result.source_file_size == len(csv_bytes)

    @pytest.mark.asyncio
    async def test_different_source_content_produces_different_hash(
        self, generator, mock_content_fetcher
    ) -> None:
        """Different source file content should produce different hashes."""
        csv_bytes_1 = _make_csv_bytes(
            rows=[["1", "Alice"]],
            header=["id", "name"],
        )
        csv_bytes_2 = _make_csv_bytes(
            rows=[["2", "Bob"]],
            header=["id", "name"],
        )

        mock_content_fetcher.fetch = AsyncMock(
            return_value=(csv_bytes_1, "test_data", ".csv")
        )
        result1 = await generator.generate(
            content_ref=_make_content_ref(),
            source_file="test_data",
            file_extension=".csv",
        )

        mock_content_fetcher.fetch = AsyncMock(
            return_value=(csv_bytes_2, "test_data", ".csv")
        )
        result2 = await generator.generate(
            content_ref=_make_content_ref(),
            source_file="test_data",
            file_extension=".csv",
        )

        assert result1.source_file_hash != result2.source_file_hash

    @pytest.mark.asyncio
    async def test_csv_import_table_name_from_filename(
        self, generator, mock_content_fetcher
    ) -> None:
        """CSV import should use the filename (without extension) as table name."""
        csv_bytes = _make_csv_bytes(
            rows=[["1", "test"]],
            header=["id", "value"],
        )
        mock_content_fetcher.fetch = AsyncMock(
            return_value=(csv_bytes, "sales_report", ".csv")
        )

        result = await generator.generate(
            content_ref=_make_content_ref(),
            source_file="sales_report",
            file_extension=".csv",
        )

        assert result.tables[0].name == "sales_report"


class TestDuckDBGeneratorExcelHandling:
    """Tests for Excel multi-sheet handling."""

    def test_xlsx_sheet_naming_convention(self) -> None:
        """Multi-sheet imports should use sheet_{name} table naming."""
        gen = DuckDBGenerator()
        # Single sheet: uses base filename
        assert gen._sanitize_table_name("report") == "report"
        # Sheet prefix would be applied by _import_xlsx for multi-sheet
        # Note: _sanitize_table_name lowercases names for consistency
        assert gen._sanitize_table_name("sheet_Sales") == "sheet_sales"

    def test_single_sheet_uses_filename_as_table_name(self) -> None:
        """Single-sheet Excel files should use the base filename as table name."""
        gen = DuckDBGenerator()
        base_name = gen._extract_table_name("financial_report.xlsx")
        table_name = gen._sanitize_table_name(base_name)
        assert table_name == "financial_report"


class TestDuckDBGeneratorSQLValidation:
    """Tests for SQL validation and security checks."""

    def test_unsupported_extension_raises_value_error(self) -> None:
        """Unsupported file extensions should raise ValueError."""
        gen = DuckDBGenerator()
        with pytest.raises(ValueError, match="Unsupported file extension"):
            # Use synchronous validation that happens before fetch
            import asyncio

            async def _test():
                with patch.object(gen, "_content_fetcher"):
                    await gen.generate(
                        content_ref=_make_content_ref(),
                        source_file="data",
                        file_extension=".pdf",
                    )

            # The extension check happens before fetch, so it raises immediately
            asyncio.get_event_loop().run_until_complete(_test())

    @pytest.mark.asyncio
    async def test_unsupported_extension_rejected(
        self, generator, mock_content_fetcher
    ) -> None:
        """Unsupported file extensions should raise ValueError before fetching."""
        with pytest.raises(ValueError, match="Unsupported file extension"):
            await generator.generate(
                content_ref=_make_content_ref(),
                source_file="document",
                file_extension=".pdf",
            )

        # Content fetcher should not be called
        mock_content_fetcher.fetch.assert_not_called()


class TestDuckDBGeneratorFileSizeLimit:
    """Tests for file size limit enforcement."""

    @pytest.mark.asyncio
    async def test_file_size_exceeds_limit(
        self, generator, mock_content_fetcher, mock_settings
    ) -> None:
        """Files exceeding the size limit should raise ValueError."""
        # Set a very small limit
        mock_settings.duckdb_max_file_size_mb = 0  # 0 MB = 0 bytes allowed

        large_data = b"x" * 1024  # 1 KB, exceeds 0 MB limit
        mock_content_fetcher.fetch = AsyncMock(
            return_value=(large_data, "big_file", ".csv")
        )

        with pytest.raises(ValueError, match="exceeds maximum allowed size"):
            await generator.generate(
                content_ref=_make_content_ref(),
                source_file="big_file",
                file_extension=".csv",
            )


class TestDuckDBGeneratorTableNameSanitization:
    """Tests for table name sanitization logic."""

    def test_special_characters_replaced(self) -> None:
        """Special characters in table names should be replaced with underscores."""
        gen = DuckDBGenerator()
        assert gen._sanitize_table_name("my-table name!") == "my_table_name"

    def test_leading_digits_prefixed(self) -> None:
        """Table names starting with digits should be prefixed with 't_'."""
        gen = DuckDBGenerator()
        assert gen._sanitize_table_name("123data") == "t_123data"

    def test_empty_name_fallback(self) -> None:
        """Empty table names should fallback to 'data'."""
        gen = DuckDBGenerator()
        assert gen._sanitize_table_name("!!!") == "data"

    def test_deduplicate_table_name(self) -> None:
        """Duplicate table names should be deduplicated with _1, _2 suffix."""
        gen = DuckDBGenerator()
        assert gen._deduplicate_table_name("sales", []) == "sales"
        assert gen._deduplicate_table_name("sales", ["sales"]) == "sales_1"
        assert gen._deduplicate_table_name("sales", ["sales", "sales_1"]) == "sales_2"

    def test_extract_table_name(self) -> None:
        """Table name should be extracted from filename without extension."""
        gen = DuckDBGenerator()
        assert gen._extract_table_name("report.xlsx") == "report"
        assert gen._extract_table_name("data.csv") == "data"
        assert gen._extract_table_name("my.file.name.tsv") == "my.file.name"
        assert gen._extract_table_name("") == "data"


class TestDuckDBGeneratorGenerateSync:
    """Tests for the synchronous generation logic."""

    def test_generate_sync_csv_creates_duckdb_bytes(self) -> None:
        """_generate_sync should create a valid DuckDB file from CSV."""
        mock_settings = MagicMock()
        mock_settings.duckdb_memory_limit = "4GB"
        mock_settings.duckdb_temp_dir = "/tmp/duckdb_spill"
        mock_settings.duckdb_summary_sample_rows = 50

        gen = DuckDBGenerator()
        csv_bytes = _make_csv_bytes(
            rows=[
                ["1", "Alice", "30"],
                ["2", "Bob", "25"],
            ],
            header=["id", "name", "age"],
        )

        with patch(
            "knowledge_runtime.services.duckdb_generator.get_settings",
            return_value=mock_settings,
        ):
            result = gen._generate_sync(csv_bytes, "test_data", ".csv")

        assert isinstance(result, DuckDBGenerateResult)
        assert len(result.duckdb_bytes) > 0
        assert len(result.tables) >= 1
        assert result.tables[0].row_count == 2

    def test_generate_sync_summary_populated(self) -> None:
        """_generate_sync should populate summary from SUMMARIZE output."""
        mock_settings = MagicMock()
        mock_settings.duckdb_memory_limit = "4GB"
        mock_settings.duckdb_temp_dir = "/tmp/duckdb_spill"
        mock_settings.duckdb_summary_sample_rows = 50

        gen = DuckDBGenerator()
        csv_bytes = _make_csv_bytes(
            rows=[["1", "test"]],
            header=["id", "value"],
        )

        with patch(
            "knowledge_runtime.services.duckdb_generator.get_settings",
            return_value=mock_settings,
        ):
            result = gen._generate_sync(csv_bytes, "test_data", ".csv")

        # Summary should contain data for the table
        assert isinstance(result.summary, dict)
        assert len(result.summary) > 0
        # The table name should appear in summary keys
        table_name = result.tables[0].name
        assert table_name in result.summary

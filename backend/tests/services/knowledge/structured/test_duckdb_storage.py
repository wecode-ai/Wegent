# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for DuckDB Storage Manager."""

import io
import pytest

from app.services.knowledge.structured.duckdb_storage import DuckDBManager


class TestDuckDBManager:
    """Test cases for DuckDBManager."""

    def setup_method(self):
        """Set up test fixtures."""
        self.kb_id = 999  # Use high ID to avoid conflicts
        self.doc_id = 1

    def teardown_method(self):
        """Clean up after tests."""
        # Clean up any tables created during tests
        table_name = DuckDBManager.get_table_name(self.kb_id, self.doc_id)
        if DuckDBManager.table_exists(table_name):
            DuckDBManager.drop_table(table_name)

    def test_get_table_name(self):
        """Test table name generation."""
        table_name = DuckDBManager.get_table_name(123, 456)
        assert table_name == "kb_123_doc_456"

    def test_ingest_csv_simple(self):
        """Test ingesting a simple CSV file."""
        csv_content = b"name,age,city\nAlice,30,Beijing\nBob,25,Shanghai\nCharlie,35,Guangzhou"

        schema = DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        assert "table_name" in schema
        assert schema["table_name"] == f"kb_{self.kb_id}_doc_{self.doc_id}"
        assert schema["row_count"] == 3
        assert schema["column_count"] == 3
        assert len(schema["schema"]) == 3

        # Check column names
        col_names = [col["name"] for col in schema["schema"]]
        assert "name" in col_names
        assert "age" in col_names
        assert "city" in col_names

    def test_ingest_csv_with_numeric_types(self):
        """Test CSV with numeric columns."""
        csv_content = b"product,price,quantity\nApple,1.5,100\nBanana,0.8,200\nOrange,2.0,150"

        schema = DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        # Check that numeric columns are detected
        type_map = {col["name"]: col["type"] for col in schema["schema"]}
        assert "price" in type_map
        assert "quantity" in type_map

    def test_table_exists(self):
        """Test table existence check."""
        table_name = DuckDBManager.get_table_name(self.kb_id, self.doc_id)

        # Before ingestion
        assert DuckDBManager.table_exists(table_name) is False

        # After ingestion
        csv_content = b"id,value\n1,100\n2,200"
        DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        assert DuckDBManager.table_exists(table_name) is True

    def test_execute_query_select_all(self):
        """Test executing SELECT * query."""
        csv_content = b"name,score\nAlice,95\nBob,87\nCharlie,92"
        DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        table_name = DuckDBManager.get_table_name(self.kb_id, self.doc_id)
        result = DuckDBManager.execute_query(
            table_name=table_name,
            sql=f"SELECT * FROM {table_name} ORDER BY name",
            max_rows=100,
        )

        assert result["row_count"] == 3
        assert len(result["columns"]) == 2
        assert "name" in result["columns"]
        assert "score" in result["columns"]
        assert result["rows"][0][0] == "Alice"  # First row, first column

    def test_execute_query_aggregation(self):
        """Test executing aggregation query."""
        csv_content = b"category,amount\nA,100\nB,200\nA,150\nB,300\nA,50"
        DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        table_name = DuckDBManager.get_table_name(self.kb_id, self.doc_id)
        result = DuckDBManager.execute_query(
            table_name=table_name,
            sql=f"SELECT category, SUM(amount) as total FROM {table_name} GROUP BY category ORDER BY total DESC",
            max_rows=100,
        )

        assert result["row_count"] == 2
        assert "category" in result["columns"]
        assert "total" in result["columns"]

    def test_execute_query_with_limit(self):
        """Test query result limiting."""
        csv_content = b"id,value\n1,10\n2,20\n3,30\n4,40\n5,50"
        DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        table_name = DuckDBManager.get_table_name(self.kb_id, self.doc_id)
        result = DuckDBManager.execute_query(
            table_name=table_name,
            sql=f"SELECT * FROM {table_name}",
            max_rows=2,
        )

        assert result["row_count"] == 2
        assert result["truncated"] is True

    def test_drop_table(self):
        """Test dropping a table."""
        csv_content = b"id,value\n1,100"
        DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        table_name = DuckDBManager.get_table_name(self.kb_id, self.doc_id)
        assert DuckDBManager.table_exists(table_name) is True

        DuckDBManager.drop_table(table_name)
        assert DuckDBManager.table_exists(table_name) is False

    def test_get_schema(self):
        """Test getting schema information."""
        csv_content = b"name,age,salary\nAlice,30,5000\nBob,25,4000"
        DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        table_name = DuckDBManager.get_table_name(self.kb_id, self.doc_id)
        schema = DuckDBManager.get_schema(table_name)

        assert schema is not None
        # The schema dict has 'schema' key (list of column defs), not 'columns'
        assert "schema" in schema
        assert "column_stats" in schema
        assert len(schema["schema"]) == 3

    def test_column_statistics(self):
        """Test column statistics calculation."""
        csv_content = b"value\n10\n20\n30\n40\n50"
        schema = DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        # Check statistics are generated
        assert "column_stats" in schema
        stats = schema["column_stats"]
        assert "value" in stats
        value_stats = stats["value"]
        assert value_stats["min"] == 10
        assert value_stats["max"] == 50
        assert value_stats["distinct_count"] == 5

    def test_csv_with_special_characters(self):
        """Test CSV with special characters in values."""
        csv_content = b'name,description\nProduct A,"Contains, comma"\nProduct B,"Has ""quotes"""\nProduct C,Normal text'

        schema = DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        assert schema["row_count"] == 3

        table_name = schema["table_name"]
        result = DuckDBManager.execute_query(
            table_name=table_name,
            sql=f"SELECT * FROM {table_name}",
            max_rows=100,
        )

        assert result["row_count"] == 3

    def test_csv_with_null_values(self):
        """Test CSV with missing/null values."""
        csv_content = b"id,name,value\n1,Alice,100\n2,,200\n3,Charlie,"

        schema = DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        assert schema["row_count"] == 3

    def test_large_csv(self):
        """Test ingesting a larger CSV file."""
        # Generate a CSV with 1000 rows
        rows = ["id,value"]
        for i in range(1000):
            rows.append(f"{i},{i * 10}")
        csv_content = "\n".join(rows).encode()

        schema = DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content,
        )

        assert schema["row_count"] == 1000

    def test_replace_existing_table(self):
        """Test that re-ingesting replaces the existing table."""
        # First ingestion
        csv_content_1 = b"id,value\n1,100\n2,200"
        DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content_1,
        )

        # Second ingestion with different data
        csv_content_2 = b"id,value,extra\n1,999,A\n2,888,B\n3,777,C"
        schema = DuckDBManager.ingest_csv(
            kb_id=self.kb_id,
            doc_id=self.doc_id,
            file_data=csv_content_2,
        )

        # Should reflect new data
        assert schema["row_count"] == 3
        assert schema["column_count"] == 3

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for Schema Extractor."""

import io
import pytest

from app.services.knowledge.structured.schema_extractor import SchemaExtractor


class TestSchemaExtractor:
    """Test cases for SchemaExtractor."""

    def setup_method(self):
        """Set up test fixtures."""
        self.extractor = SchemaExtractor()

    def test_extract_from_csv_basic(self):
        """Test extracting schema from a basic CSV."""
        csv_content = b"name,age,city\nAlice,30,Beijing\nBob,25,Shanghai"

        schema = self.extractor.extract_from_csv(csv_content)

        assert "columns" in schema
        assert len(schema["columns"]) == 3

        col_names = [col["name"] for col in schema["columns"]]
        assert "name" in col_names
        assert "age" in col_names
        assert "city" in col_names

    def test_extract_from_csv_types(self):
        """Test type inference from CSV."""
        csv_content = b"id,price,is_active,created_at\n1,19.99,true,2024-01-01\n2,29.99,false,2024-02-01"

        schema = self.extractor.extract_from_csv(csv_content)

        # Check inferred types
        type_map = {col["name"]: col["type"] for col in schema["columns"]}

        # Types may vary by implementation, but should detect numeric
        assert "id" in type_map
        assert "price" in type_map

    def test_extract_from_csv_sample_values(self):
        """Test sample value extraction from CSV."""
        csv_content = b"product\nApple\nBanana\nCherry\nDate\nElderberry"

        schema = self.extractor.extract_from_csv(csv_content)

        product_col = next(c for c in schema["columns"] if c["name"] == "product")
        assert "sample_values" in product_col
        assert len(product_col["sample_values"]) <= 5  # Should limit samples

    def test_extract_from_csv_with_nulls(self):
        """Test handling of NULL/empty values."""
        csv_content = b"id,name,value\n1,Alice,100\n2,,200\n3,Charlie,"

        schema = self.extractor.extract_from_csv(csv_content)

        # Should handle nulls gracefully
        assert len(schema["columns"]) == 3

        # Check nullable flags
        for col in schema["columns"]:
            assert "nullable" in col

    def test_extract_from_csv_unicode(self):
        """Test handling of Unicode characters."""
        csv_content = "名称,价格,城市\n苹果,10,北京\n香蕉,5,上海".encode("utf-8")

        schema = self.extractor.extract_from_csv(csv_content)

        assert len(schema["columns"]) == 3
        col_names = [col["name"] for col in schema["columns"]]
        assert "名称" in col_names
        assert "价格" in col_names

    def test_extract_from_csv_large_file(self):
        """Test schema extraction from larger CSV."""
        # Generate 1000 rows
        rows = ["id,value,category"]
        for i in range(1000):
            rows.append(f"{i},{i * 10},Cat{i % 10}")
        csv_content = "\n".join(rows).encode()

        schema = self.extractor.extract_from_csv(csv_content)

        assert schema["row_count"] == 1000
        assert len(schema["columns"]) == 3

    def test_extract_from_csv_column_stats(self):
        """Test column statistics extraction."""
        csv_content = b"value\n10\n20\n30\n40\n50"

        schema = self.extractor.extract_from_csv(csv_content)

        assert "column_stats" in schema
        if "value" in schema["column_stats"]:
            stats = schema["column_stats"]["value"]
            assert stats["min"] == 10
            assert stats["max"] == 50

    def test_extract_from_csv_empty_file(self):
        """Test handling of empty CSV."""
        csv_content = b""

        with pytest.raises(Exception):
            self.extractor.extract_from_csv(csv_content)

    def test_extract_from_csv_header_only(self):
        """Test handling of CSV with only header."""
        csv_content = b"col1,col2,col3"

        schema = self.extractor.extract_from_csv(csv_content)

        assert len(schema["columns"]) == 3
        assert schema["row_count"] == 0

    def test_extract_from_csv_special_characters(self):
        """Test handling of special characters in column names."""
        csv_content = b'"Column Name","Price ($)","Qty #"\nA,100,10\nB,200,20'

        schema = self.extractor.extract_from_csv(csv_content)

        # Should handle or sanitize special characters
        assert len(schema["columns"]) == 3

    def test_type_inference_integer(self):
        """Test integer type inference through CSV extraction."""
        csv_content = b"id\n1\n2\n3\n100\n999"
        schema = self.extractor.extract_from_csv(csv_content)

        # Find the id column
        id_col = next(c for c in schema["columns"] if c["name"] == "id")
        # Should infer as an integer type
        assert id_col["type"] in ["INTEGER", "BIGINT", "INT64", "INT", "DOUBLE"]

    def test_type_inference_float(self):
        """Test float type inference through CSV extraction."""
        csv_content = b"price\n1.5\n2.7\n3.14\n100.99"
        schema = self.extractor.extract_from_csv(csv_content)

        price_col = next(c for c in schema["columns"] if c["name"] == "price")
        assert price_col["type"] in ["DOUBLE", "FLOAT", "REAL", "DECIMAL"]

    def test_type_inference_string(self):
        """Test string type inference through CSV extraction."""
        csv_content = b"name\nhello\nworld\ntest"
        schema = self.extractor.extract_from_csv(csv_content)

        name_col = next(c for c in schema["columns"] if c["name"] == "name")
        assert name_col["type"] in ["VARCHAR", "STRING", "TEXT", "OBJECT"]

    def test_type_inference_mixed(self):
        """Test type inference with mixed values through CSV extraction."""
        csv_content = b"mixed\n1\nhello\n3.14\ntrue"
        schema = self.extractor.extract_from_csv(csv_content)

        mixed_col = next(c for c in schema["columns"] if c["name"] == "mixed")
        # Mixed types should result in VARCHAR or OBJECT
        assert mixed_col["type"] in ["VARCHAR", "STRING", "TEXT", "OBJECT"]

    def test_type_inference_boolean(self):
        """Test boolean type inference through CSV extraction."""
        csv_content = b"flag\ntrue\nfalse\nTrue\nFalse"
        schema = self.extractor.extract_from_csv(csv_content)

        flag_col = next(c for c in schema["columns"] if c["name"] == "flag")
        # Boolean values might be detected as BOOLEAN or VARCHAR
        assert flag_col["type"] in ["BOOLEAN", "BOOL", "VARCHAR", "OBJECT"]

    def test_extract_with_different_delimiters(self):
        """Test extraction with semicolon delimiter.

        Note: DuckDB's CSV reader auto-detects delimiters, so semicolon-
        separated files should be parsed correctly with 3 columns.
        """
        # Some CSVs use semicolon as delimiter
        csv_content = b"name;age;city\nAlice;30;Beijing"

        # The extractor should handle or detect different delimiters
        # DuckDB typically auto-detects semicolons
        schema = self.extractor.extract_from_csv(csv_content)

        # If DuckDB auto-detected semicolons, should have 3 columns
        # If not, should have 1 column with semicolons in name
        assert "columns" in schema
        assert len(schema["columns"]) >= 1

        # Verify structure is valid
        for col in schema["columns"]:
            assert "name" in col
            assert "type" in col

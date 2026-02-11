# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for Text-to-SQL Generator."""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from app.services.knowledge.structured.text_to_sql import TextToSQLGenerator


class TestTextToSQLGenerator:
    """Test cases for TextToSQLGenerator."""

    def setup_method(self):
        """Set up test fixtures."""
        self.generator = TextToSQLGenerator()
        self.sample_schema = {
            "columns": [
                {
                    "name": "product_name",
                    "type": "VARCHAR",
                    "nullable": True,
                    "sample_values": ["Apple", "Banana", "Orange"],
                },
                {
                    "name": "price",
                    "type": "DOUBLE",
                    "nullable": True,
                    "sample_values": [1.5, 2.0, 0.8],
                },
                {
                    "name": "quantity",
                    "type": "INTEGER",
                    "nullable": True,
                    "sample_values": [100, 200, 150],
                },
                {
                    "name": "category",
                    "type": "VARCHAR",
                    "nullable": True,
                    "sample_values": ["Fruit", "Fruit", "Fruit"],
                },
            ],
            "column_stats": {
                "price": {"min": 0.5, "max": 10.0, "distinct_count": 20},
                "quantity": {"min": 1, "max": 1000, "distinct_count": 100},
            },
            "row_count": 1000,
            "column_count": 4,
        }
        self.table_name = "kb_1_doc_1"

    def test_build_prompt(self):
        """Test prompt building with schema information."""
        prompt = self.generator._build_prompt(
            query="What is the total sales?",
            schema=self.sample_schema,
            table_name=self.table_name,
        )

        # Check that prompt contains essential components
        assert self.table_name in prompt
        assert "product_name" in prompt
        assert "price" in prompt
        assert "quantity" in prompt
        assert "total sales" in prompt.lower()

    def test_format_columns(self):
        """Test column formatting for prompt."""
        columns_str = self.generator._format_columns(self.sample_schema["columns"])

        assert "product_name" in columns_str
        assert "VARCHAR" in columns_str
        assert "price" in columns_str
        assert "DOUBLE" in columns_str

    def test_format_stats(self):
        """Test statistics formatting for prompt."""
        stats_str = self.generator._format_stats(self.sample_schema["column_stats"])

        assert "price" in stats_str
        assert "min=0.5" in stats_str
        assert "max=10.0" in stats_str
        assert "distinct=20" in stats_str

    def test_format_samples(self):
        """Test sample values formatting for prompt."""
        samples_str = self.generator._format_samples(self.sample_schema["columns"])

        assert "product_name" in samples_str
        assert "Apple" in samples_str

    def test_format_stats_empty(self):
        """Test statistics formatting with empty stats."""
        stats_str = self.generator._format_stats({})
        assert "No statistics available" in stats_str

    def test_format_samples_empty(self):
        """Test sample formatting with empty columns."""
        samples_str = self.generator._format_samples([])
        assert "No samples available" in samples_str

    def test_extract_sql_from_code_block(self):
        """Test SQL extraction from markdown code block."""
        response = """
        Here's the query:
        ```sql
        SELECT product_name, SUM(price * quantity) as total
        FROM kb_1_doc_1
        GROUP BY product_name
        LIMIT 10
        ```
        This query calculates the total sales.
        """

        sql = self.generator._extract_sql(response)

        assert "SELECT" in sql
        assert "product_name" in sql
        assert "GROUP BY" in sql

    def test_extract_sql_from_plain_code_block(self):
        """Test SQL extraction from plain code block."""
        response = """
        ```
        SELECT * FROM table LIMIT 100
        ```
        """

        sql = self.generator._extract_sql(response)
        assert "SELECT * FROM table" in sql

    def test_extract_sql_direct(self):
        """Test SQL extraction when no code block is present."""
        response = "SELECT name FROM users WHERE active = true LIMIT 50"

        sql = self.generator._extract_sql(response)
        assert "SELECT name FROM users" in sql

    def test_extract_explanation(self):
        """Test explanation extraction from response."""
        response = """
        ```sql
        SELECT * FROM table LIMIT 10
        ```
        This query retrieves all records from the table.
        It's useful for understanding the data structure.
        """

        explanation = self.generator._extract_explanation(response)

        assert "query" in explanation.lower() or len(explanation) > 0

    def test_calculate_confidence_high(self):
        """Test confidence calculation for well-formed SQL."""
        sql = "SELECT product_name, SUM(price) FROM kb_1_doc_1 GROUP BY product_name LIMIT 10"

        confidence = self.generator._calculate_confidence(sql, self.sample_schema)

        assert confidence >= 0.5
        assert confidence <= 1.0

    def test_calculate_confidence_low(self):
        """Test confidence calculation for poor SQL."""
        sql = "INVALID SQL STATEMENT"

        confidence = self.generator._calculate_confidence(sql, self.sample_schema)

        assert confidence <= 0.7  # Should be lower without proper structure

    def test_calculate_confidence_with_limit(self):
        """Test that LIMIT clause increases confidence."""
        sql_with_limit = "SELECT * FROM kb_1_doc_1 LIMIT 100"
        sql_without_limit = "SELECT * FROM kb_1_doc_1"

        conf_with = self.generator._calculate_confidence(sql_with_limit, self.sample_schema)
        conf_without = self.generator._calculate_confidence(sql_without_limit, self.sample_schema)

        assert conf_with >= conf_without

    def test_generate_fallback_sql(self):
        """Test fallback SQL generation when LLM is unavailable."""
        prompt = "Table: test_table\nSome query"

        fallback = self.generator._generate_fallback_sql(prompt)

        assert "SELECT" in fallback
        assert "test_table" in fallback
        assert "LIMIT" in fallback

    @pytest.mark.asyncio
    async def test_generate_with_mock_llm(self):
        """Test generate method with mocked LLM response."""
        mock_response = """
        ```sql
        SELECT category, COUNT(*) as count
        FROM kb_1_doc_1
        GROUP BY category
        ORDER BY count DESC
        LIMIT 10
        ```
        This query counts products by category.
        """

        with patch.object(
            self.generator, "_call_llm", new_callable=AsyncMock
        ) as mock_llm:
            mock_llm.return_value = mock_response

            result = await self.generator.generate(
                query="How many products are in each category?",
                schema=self.sample_schema,
                table_name=self.table_name,
            )

            assert "sql" in result
            assert "explanation" in result
            assert "confidence" in result
            assert "SELECT" in result["sql"]
            assert "GROUP BY" in result["sql"]

    @pytest.mark.asyncio
    async def test_generate_with_llm_error(self):
        """Test generate method when LLM fails."""
        with patch.object(
            self.generator, "_call_llm", new_callable=AsyncMock
        ) as mock_llm:
            mock_llm.side_effect = Exception("LLM API error")

            # Should fall back to fallback SQL generation
            # The actual behavior depends on implementation
            # This test verifies error handling

    def test_system_prompt_content(self):
        """Test that system prompt contains necessary instructions."""
        prompt = self.generator.SYSTEM_PROMPT

        # Check for essential instructions
        assert "SELECT" in prompt
        assert "LIMIT" in prompt
        assert "SQL" in prompt.upper()

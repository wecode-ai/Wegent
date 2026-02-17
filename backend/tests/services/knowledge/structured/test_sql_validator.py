# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unit tests for SQL Validator."""

import pytest

from app.services.knowledge.structured.sql_validator import SQLValidator


class TestSQLValidator:
    """Test cases for SQLValidator."""

    def setup_method(self):
        """Set up test fixtures."""
        self.validator = SQLValidator()
        self.allowed_tables = ["kb_1_doc_1", "kb_1_doc_2"]

    def test_valid_select_query(self):
        """Test validation of a valid SELECT query."""
        sql = "SELECT * FROM kb_1_doc_1 LIMIT 100"
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is True
        assert result["sanitized_sql"] is not None
        assert len(result["errors"]) == 0

    def test_valid_select_with_aggregation(self):
        """Test validation of SELECT with aggregation functions."""
        sql = """
        SELECT category, SUM(amount) as total_amount, COUNT(*) as count
        FROM kb_1_doc_1
        GROUP BY category
        ORDER BY total_amount DESC
        LIMIT 10
        """
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is True

    def test_valid_select_with_where(self):
        """Test validation of SELECT with WHERE clause."""
        sql = """
        SELECT name, amount
        FROM kb_1_doc_1
        WHERE amount > 100 AND status = 'active'
        LIMIT 50
        """
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is True

    def test_invalid_insert_query(self):
        """Test that INSERT queries are rejected."""
        sql = "INSERT INTO kb_1_doc_1 (name, value) VALUES ('test', 123)"
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False
        assert any("INSERT" in err.upper() for err in result["errors"])

    def test_invalid_update_query(self):
        """Test that UPDATE queries are rejected."""
        sql = "UPDATE kb_1_doc_1 SET value = 100 WHERE id = 1"
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False
        assert any("UPDATE" in err.upper() for err in result["errors"])

    def test_invalid_delete_query(self):
        """Test that DELETE queries are rejected."""
        sql = "DELETE FROM kb_1_doc_1 WHERE id = 1"
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False
        assert any("DELETE" in err.upper() for err in result["errors"])

    def test_invalid_drop_query(self):
        """Test that DROP queries are rejected."""
        sql = "DROP TABLE kb_1_doc_1"
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False
        assert any("DROP" in err.upper() for err in result["errors"])

    def test_invalid_truncate_query(self):
        """Test that TRUNCATE queries are rejected."""
        sql = "TRUNCATE TABLE kb_1_doc_1"
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False

    def test_invalid_table_access(self):
        """Test that queries accessing non-allowed tables are rejected."""
        sql = "SELECT * FROM unauthorized_table LIMIT 10"
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False
        assert any("unauthorized_table" in err.lower() for err in result["errors"])

    def test_subquery_with_unauthorized_table(self):
        """Test that subqueries accessing unauthorized tables are rejected."""
        sql = """
        SELECT * FROM kb_1_doc_1
        WHERE id IN (SELECT id FROM unauthorized_table)
        LIMIT 10
        """
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False

    def test_union_with_unauthorized_table(self):
        """Test that UNION with unauthorized tables is rejected."""
        sql = """
        SELECT name FROM kb_1_doc_1
        UNION
        SELECT name FROM unauthorized_table
        LIMIT 10
        """
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is False

    def test_empty_sql(self):
        """Test handling of empty SQL."""
        result = self.validator.validate("", self.allowed_tables)

        assert result["is_valid"] is False

    def test_invalid_sql_syntax(self):
        """Test handling of invalid SQL syntax."""
        sql = "SELCT * FORM kb_1_doc_1"  # Intentional typos
        result = self.validator.validate(sql, self.allowed_tables)

        # Should fail because it doesn't start with SELECT
        assert result["is_valid"] is False

    def test_sql_injection_attempt(self):
        """Test that SQL injection attempts are blocked."""
        sql = "SELECT * FROM kb_1_doc_1; DROP TABLE kb_1_doc_1; --"
        result = self.validator.validate(sql, self.allowed_tables)

        # Should fail due to multiple statements or DROP keyword
        assert result["is_valid"] is False

    def test_case_insensitive_forbidden_keywords(self):
        """Test that forbidden keywords are detected case-insensitively."""
        for keyword in ["INSERT", "insert", "Insert", "InSeRt"]:
            sql = f"{keyword} INTO kb_1_doc_1 (name) VALUES ('test')"
            result = self.validator.validate(sql, self.allowed_tables)
            assert result["is_valid"] is False, f"Failed for keyword: {keyword}"

    def test_multiple_tables_join(self):
        """Test JOIN between allowed tables."""
        sql = """
        SELECT a.name, b.value
        FROM kb_1_doc_1 a
        JOIN kb_1_doc_2 b ON a.id = b.ref_id
        LIMIT 100
        """
        result = self.validator.validate(sql, self.allowed_tables)

        assert result["is_valid"] is True

    def test_cte_query(self):
        """Test Common Table Expression (CTE) queries.

        Note: The simple validator does not fully parse CTEs.
        The CTE alias 'top_items' is not in allowed_tables,
        so this query will fail validation as expected.
        """
        sql = """
        WITH top_items AS (
            SELECT * FROM kb_1_doc_1 WHERE amount > 100
        )
        SELECT * FROM top_items ORDER BY amount DESC LIMIT 10
        """
        result = self.validator.validate(sql, self.allowed_tables)

        # CTE validation depends on implementation
        # The simple validator treats 'top_items' as an unauthorized table
        # since it's not in allowed_tables, so this should fail
        assert result["is_valid"] is False
        assert any("top_items" in err.lower() for err in result["errors"])

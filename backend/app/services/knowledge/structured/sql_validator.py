# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SQL validator for structured data queries.

This module provides SQL validation to ensure queries are safe and only
perform allowed operations (SELECT only, no modifications).
"""

import logging
import re
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


class SQLValidator:
    """Validates SQL queries for safety.

    Ensures that:
    - Only SELECT operations are allowed
    - No data modification (INSERT, UPDATE, DELETE)
    - No schema changes (CREATE, DROP, ALTER)
    - No dangerous operations (TRUNCATE, GRANT, etc.)
    - Only allowed tables are accessed
    """

    # Forbidden SQL keywords (data modification and schema changes)
    # Includes DuckDB-specific dangerous commands
    FORBIDDEN_KEYWORDS = [
        "DROP",
        "DELETE",
        "UPDATE",
        "INSERT",
        "ALTER",
        "CREATE",
        "TRUNCATE",
        "GRANT",
        "REVOKE",
        "EXECUTE",
        "EXEC",
        "MERGE",
        "REPLACE",
        "LOAD",
        "COPY",
        "ATTACH",
        "DETACH",
        # DuckDB-specific dangerous commands
        "PRAGMA",
        "INSTALL",
        "EXPORT",
        "IMPORT",
        "CALL",
        "SET",
    ]

    # Patterns that might indicate SQL injection
    INJECTION_PATTERNS = [
        r";\s*--",  # SQL comment after statement
        r";\s*/\*",  # Block comment after statement
        r"'\s*OR\s+'",  # OR injection
        r"'\s*AND\s+'",  # AND injection
        r"UNION\s+ALL\s+SELECT",  # Union injection
        r"UNION\s+SELECT",  # Union injection
    ]

    # Allowed aggregate functions
    ALLOWED_FUNCTIONS = [
        "SUM",
        "COUNT",
        "AVG",
        "MIN",
        "MAX",
        "ROUND",
        "COALESCE",
        "NULLIF",
        "CONCAT",
        "UPPER",
        "LOWER",
        "TRIM",
        "SUBSTRING",
        "LENGTH",
        "ABS",
        "CEIL",
        "FLOOR",
        "CAST",
        "DATE_PART",
        "DATE_TRUNC",
        "EXTRACT",
        "STRFTIME",
        "CASE",
        "WHEN",
        "THEN",
        "ELSE",
        "END",
        "DISTINCT",
        "AS",
    ]

    def validate(
        self,
        sql: str,
        allowed_tables: List[str],
    ) -> Dict[str, Any]:
        """Validate SQL query for safety.

        Args:
            sql: SQL query string
            allowed_tables: List of table names the query is allowed to access

        Returns:
            Validation result dict with:
            - is_valid: bool
            - errors: List[str] of validation errors
            - sanitized_sql: str or None if invalid
        """
        errors = []
        sql_upper = sql.upper()

        # Check 1: Must start with SELECT
        if not sql_upper.strip().startswith("SELECT"):
            errors.append("Query must start with SELECT")

        # Check 2: Forbidden keywords
        for keyword in self.FORBIDDEN_KEYWORDS:
            # Use word boundary to avoid false positives (e.g., "UPDATED" vs "UPDATE")
            pattern = rf"\b{keyword}\b"
            if re.search(pattern, sql_upper):
                errors.append(f"Forbidden operation: {keyword}")

        # Check 3: SQL injection patterns
        for pattern in self.INJECTION_PATTERNS:
            if re.search(pattern, sql_upper):
                errors.append(f"Potential SQL injection detected")
                break

        # Check 4: Multiple statements (prevent stacked queries)
        # Count semicolons not inside strings
        if self._has_multiple_statements(sql):
            errors.append("Multiple SQL statements not allowed")

        # Check 5: Table access validation
        tables_used = self._extract_tables(sql)
        for table in tables_used:
            if table.upper() not in [t.upper() for t in allowed_tables]:
                errors.append(f"Access denied to table: {table}")

        # Check 6: Subquery depth limit (prevent complex attacks)
        subquery_depth = sql_upper.count("SELECT") - 1
        if subquery_depth > 3:
            errors.append("Subquery depth exceeds limit (max 3 levels)")

        is_valid = len(errors) == 0

        if is_valid:
            logger.info(f"[SQLValidator] Query validated successfully")
        else:
            logger.warning(f"[SQLValidator] Query validation failed: {errors}")

        return {
            "is_valid": is_valid,
            "errors": errors,
            "sanitized_sql": sql if is_valid else None,
        }

    def _extract_tables(self, sql: str) -> List[str]:
        """Extract table names from SQL query.

        Args:
            sql: SQL query string

        Returns:
            List of table names referenced in the query
        """
        tables = []

        # Pattern for FROM clause (handles JOIN as well)
        # Matches: FROM table_name, JOIN table_name
        from_pattern = r"\bFROM\s+(\w+)"
        join_pattern = r"\bJOIN\s+(\w+)"

        for pattern in [from_pattern, join_pattern]:
            matches = re.findall(pattern, sql, re.IGNORECASE)
            tables.extend(matches)

        # Remove duplicates while preserving order
        seen = set()
        unique_tables = []
        for table in tables:
            if table.upper() not in seen:
                seen.add(table.upper())
                unique_tables.append(table)

        return unique_tables

    def _has_multiple_statements(self, sql: str) -> bool:
        """Check if SQL contains multiple statements.

        Args:
            sql: SQL query string

        Returns:
            True if multiple statements detected
        """
        # Remove string literals to avoid false positives
        # Replace single-quoted strings with placeholder
        cleaned = re.sub(r"'[^']*'", "''", sql)
        # Replace double-quoted strings with placeholder
        cleaned = re.sub(r'"[^"]*"', '""', cleaned)

        # Count semicolons
        semicolon_count = cleaned.count(";")

        # Allow one trailing semicolon
        return semicolon_count > 1

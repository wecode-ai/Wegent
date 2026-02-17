# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Text-to-SQL generator for structured data queries.

This module converts natural language queries to SQL using LLM,
with schema context and safety validation.
"""

import asyncio
import logging
import re
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class TextToSQLGenerator:
    """Generates SQL from natural language using LLM.

    Uses schema information and column statistics to generate
    accurate SQL queries from natural language questions.
    """

    # System prompt for SQL generation
    SYSTEM_PROMPT = """You are a SQL expert. Generate DuckDB SQL queries based on natural language questions.

RULES:
1. ONLY generate SELECT queries (no INSERT, UPDATE, DELETE, DROP, etc.)
2. Use appropriate aggregate functions (SUM, COUNT, AVG, MAX, MIN) when asked for totals/averages
3. Use GROUP BY for categorical analysis
4. Use ORDER BY to sort results meaningfully
5. ALWAYS include LIMIT clause for safety (default LIMIT 100)
6. Use column names exactly as provided in the schema
7. Handle NULL values appropriately with COALESCE or IS NOT NULL

OUTPUT FORMAT:
Return ONLY the SQL query wrapped in ```sql``` code blocks, followed by a brief explanation.

Example:
```sql
SELECT category, SUM(amount) as total_amount
FROM sales
GROUP BY category
ORDER BY total_amount DESC
LIMIT 10
```
This query calculates the total amount for each category and returns the top 10."""

    def __init__(self, model_name: Optional[str] = None):
        """Initialize the generator.

        Args:
            model_name: Optional model name override
        """
        self.model_name = model_name

    async def generate(
        self,
        query: str,
        schema: Dict[str, Any],
        table_name: str,
        model_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Generate SQL from natural language query.

        Args:
            query: Natural language query
            schema: Schema information dict
            table_name: Target table name
            model_config: Optional model configuration

        Returns:
            Dict with sql, explanation, confidence
        """
        # Build the prompt
        prompt = self._build_prompt(query, schema, table_name)

        # Call LLM
        response = await self._call_llm(prompt, model_config)

        # Extract SQL from response
        sql = self._extract_sql(response)

        # Extract explanation
        explanation = self._extract_explanation(response)

        # Calculate confidence based on response quality
        confidence = self._calculate_confidence(sql, schema)

        logger.info(
            f"[TextToSQL] Generated SQL for query: {query[:50]}... "
            f"confidence={confidence:.2f}"
        )

        return {
            "sql": sql,
            "explanation": explanation,
            "confidence": confidence,
            "raw_response": response,
        }

    def _build_prompt(
        self,
        query: str,
        schema: Dict[str, Any],
        table_name: str,
    ) -> str:
        """Build the user prompt for SQL generation.

        Note: This returns only the user content. The system prompt
        is passed separately to the LLM API.

        Args:
            query: Natural language query
            schema: Schema information
            table_name: Table name

        Returns:
            Formatted user prompt string
        """
        # Format columns
        columns_str = self._format_columns(schema.get("columns", []))

        # Format statistics
        stats_str = self._format_stats(schema.get("column_stats", {}))

        # Format sample values
        samples_str = self._format_samples(schema.get("columns", []))

        return f"""## TABLE SCHEMA
Table: {table_name}

### Columns
{columns_str}

### Column Statistics
{stats_str}

### Sample Values
{samples_str}

## USER QUESTION
{query}

Generate a SQL query to answer this question. Remember to:
- Use table name: {table_name}
- Include LIMIT clause
- Use exact column names from the schema"""

    def _format_columns(self, columns: list) -> str:
        """Format column definitions for prompt."""
        if not columns:
            return "No columns defined"

        lines = []
        for col in columns:
            nullable = "NULL" if col.get("nullable", True) else "NOT NULL"
            lines.append(f"- {col['name']} ({col['type']}) {nullable}")
        return "\n".join(lines)

    def _format_stats(self, stats: Dict[str, Any]) -> str:
        """Format column statistics for prompt."""
        if not stats:
            return "No statistics available"

        lines = []
        for col_name, col_stats in stats.items():
            stat_parts = []
            if "min" in col_stats and col_stats["min"] is not None:
                stat_parts.append(f"min={col_stats['min']}")
            if "max" in col_stats and col_stats["max"] is not None:
                stat_parts.append(f"max={col_stats['max']}")
            if "distinct_count" in col_stats:
                stat_parts.append(f"distinct={col_stats['distinct_count']}")

            if stat_parts:
                lines.append(f"- {col_name}: {', '.join(stat_parts)}")

        return "\n".join(lines) if lines else "No statistics available"

    def _format_samples(self, columns: list) -> str:
        """Format sample values for prompt."""
        if not columns:
            return "No samples available"

        lines = []
        for col in columns:
            samples = col.get("sample_values", [])
            if samples:
                sample_str = ", ".join(str(s)[:50] for s in samples[:3])
                lines.append(f"- {col['name']}: {sample_str}")

        return "\n".join(lines) if lines else "No samples available"

    async def _call_llm(
        self,
        prompt: str,
        model_config: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Call LLM to generate SQL.

        Uses asyncio.to_thread to avoid blocking the event loop
        when calling the synchronous Anthropic client.

        Args:
            prompt: User prompt (system prompt is passed separately)
            model_config: Optional model configuration with keys:
                - model: Model name override
                - max_tokens: Maximum tokens for response
                - temperature: Sampling temperature

        Returns:
            LLM response string
        """
        try:
            # Import here to avoid circular imports
            from anthropic import Anthropic

            from app.core.config import settings

            # Get configuration from model_config or defaults
            config = model_config or {}
            model_name = config.get("model") or self.model_name or settings.STRUCTURED_DATA_MODEL
            max_tokens = config.get("max_tokens", 1024)
            temperature = config.get("temperature", 0.0)

            # Create client
            client = Anthropic()

            # Define synchronous API call
            def _sync_call() -> str:
                response = client.messages.create(
                    model=model_name,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    system=self.SYSTEM_PROMPT,
                    messages=[{"role": "user", "content": prompt}],
                )
                return response.content[0].text

            # Run in thread to avoid blocking event loop
            return await asyncio.to_thread(_sync_call)

        except ImportError:
            logger.warning("[TextToSQL] Anthropic not available, using fallback")
            return self._generate_fallback_sql(prompt)
        except Exception as e:
            logger.error(f"[TextToSQL] LLM call failed: {e}")
            return self._generate_fallback_sql(prompt)

    def _generate_fallback_sql(self, prompt: str) -> str:
        """Generate a simple fallback SQL when LLM is unavailable.

        Args:
            prompt: Original prompt (used to extract table name)

        Returns:
            Simple SELECT * query
        """
        # Extract table name from prompt
        table_match = re.search(r"Table:\s*(\w+)", prompt)
        table_name = table_match.group(1) if table_match else "data"

        return f"""```sql
SELECT * FROM {table_name} LIMIT 100
```
This is a fallback query that returns the first 100 rows from the table."""

    def _extract_sql(self, response: str) -> str:
        """Extract SQL from LLM response.

        Args:
            response: LLM response string

        Returns:
            Extracted SQL query
        """
        # Look for SQL code block
        sql_match = re.search(r"```sql\s*(.*?)\s*```", response, re.DOTALL | re.IGNORECASE)
        if sql_match:
            return sql_match.group(1).strip()

        # Look for any code block
        code_match = re.search(r"```\s*(.*?)\s*```", response, re.DOTALL)
        if code_match:
            return code_match.group(1).strip()

        # Try to find SELECT statement directly
        select_match = re.search(r"(SELECT\s+.*?)(?:$|;|\n\n)", response, re.DOTALL | re.IGNORECASE)
        if select_match:
            return select_match.group(1).strip()

        # Return the whole response as fallback
        return response.strip()

    def _extract_explanation(self, response: str) -> str:
        """Extract explanation from LLM response.

        Args:
            response: LLM response string

        Returns:
            Explanation text
        """
        # Remove code blocks
        text = re.sub(r"```.*?```", "", response, flags=re.DOTALL)
        text = text.strip()

        # Return first paragraph or sentence
        paragraphs = text.split("\n\n")
        if paragraphs:
            return paragraphs[0].strip()[:500]

        return "Query generated successfully"

    def _calculate_confidence(self, sql: str, schema: Dict[str, Any]) -> float:
        """Calculate confidence score for generated SQL.

        Args:
            sql: Generated SQL
            schema: Schema information

        Returns:
            Confidence score (0.0 - 1.0)
        """
        confidence = 0.5  # Base confidence

        sql_upper = sql.upper()

        # Check if SQL starts with SELECT
        if sql_upper.strip().startswith("SELECT"):
            confidence += 0.1

        # Check if table columns are used
        columns = schema.get("columns", [])
        col_names = [c["name"].upper() for c in columns]
        used_columns = sum(1 for col in col_names if col in sql_upper)
        if used_columns > 0:
            confidence += min(0.2, used_columns * 0.05)

        # Check for LIMIT clause
        if "LIMIT" in sql_upper:
            confidence += 0.1

        # Check for valid structure
        if "FROM" in sql_upper:
            confidence += 0.1

        return min(1.0, confidence)

---
description: "Data analysis tools for Excel and CSV files. Provides SQL query and schema exploration capabilities for structured data analysis. Use this skill when the user wants to analyze, query, aggregate, or explore data in Excel/CSV files."
displayName: "数据分析工具"
version: "1.0.0"
author: "Wegent Team"
tags: ["data-analysis", "excel", "csv", "sql", "duckdb", "query"]
bindShells:
  - ClaudeCode
mcpServers:
  wegent-data-analysis:
    type: streamable-http
    # NOTE: MCP client only supports ${{...}} variable substitution.
    # The platform will inject `backend_url` via task_data.
    url: "${{backend_url}}/mcp/data-analysis/sse"
    headers:
      Authorization: "Bearer ${{task_token}}"
    timeout: 300
---

# Wegent Data Analysis Skill

You now have access to data analysis tools for Excel and CSV files. These tools allow you to query structured data using SQL.

## Available Tools

- **wegent_data_schema**: Get the schema and statistical summary of a data file attachment
  - attachment_id: The attachment ID from the chat context (found in the attachment metadata)

- **wegent_data_query**: Execute a SQL query against a data file attachment
  - attachment_id: The attachment ID from the chat context
  - sql: SQL SELECT query to execute

## Important Notes

- **Table name prefix**: All table names must use the `data_db.` prefix (e.g., `data_db.sales_2024`, `data_db.sheet_Q1`)
- **Read-only**: Only SELECT queries are allowed; INSERT, UPDATE, DELETE, DROP are blocked
- **Temp tables**: You can create temporary tables and views for complex multi-step analysis
- **Row limit**: Results are limited to 5000 rows by default; use LIMIT clauses for large datasets
- **Query timeout**: Queries have a 30-second timeout; optimize complex queries
- **Schema first**: Always use wegent_data_schema first to understand the table structure before writing queries

## Table Naming Conventions

- Single-sheet Excel files: Table name matches the filename (without extension)
- Multi-sheet Excel files: Tables named `sheet_{sheet_name}`
- CSV files: Table name matches the filename (without extension)

## Example Workflow

1. First, get the schema to understand the data structure:
   ```sql
   -- Via wegent_data_schema tool
   wegent_data_schema(attachment_id=123)
   ```

2. Explore the data with simple queries:
   ```sql
   -- Via wegent_data_query tool
   SELECT * FROM data_db.sales_2024 LIMIT 10
   ```

3. Perform aggregations and analysis:
   ```sql
   SELECT
     product_category,
     COUNT(*) as order_count,
     SUM(amount) as total_sales,
     AVG(amount) as avg_sale
   FROM data_db.sales_2024
   GROUP BY product_category
   ORDER BY total_sales DESC
   ```

4. For complex analysis, use temporary tables:
   ```sql
   CREATE TEMP TABLE monthly_sales AS
   SELECT
     DATE_TRUNC('month', order_date) as month,
     SUM(amount) as total
   FROM data_db.sales_2024
   GROUP BY DATE_TRUNC('month', order_date);

   SELECT month, total,
     LAG(total) OVER (ORDER BY month) as prev_month,
     (total - LAG(total) OVER (ORDER BY month)) / LAG(total) OVER (ORDER BY month) * 100 as growth_pct
   FROM monthly_sales
   ORDER BY month;
   ```

5. Filter and rank data:
   ```sql
   SELECT * FROM (
     SELECT
       product_name,
       SUM(amount) as total_sales,
       RANK() OVER (ORDER BY SUM(amount) DESC) as sales_rank
     FROM data_db.sales_2024
     GROUP BY product_name
   ) ranked
   WHERE sales_rank <= 10
   ```

## Tips for Effective Data Analysis

- Start with schema exploration to understand column types and data ranges
- Use LIMIT to preview data before running large queries
- Leverage SQL aggregate functions: SUM, AVG, COUNT, MIN, MAX
- Use GROUP BY for categorical analysis
- Use window functions (OVER, RANK, LAG) for trend analysis
- Create temp tables for multi-step complex analysis
- Check NULL values in the schema summary before relying on columns

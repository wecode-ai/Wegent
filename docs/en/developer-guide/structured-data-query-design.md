---
sidebar_position: 10
---

# Structured Data Query Design - Minimal Invasion Approach

This document outlines a minimal-invasion approach to add structured data (CSV/XLSX) query capabilities to Wegent's knowledge base system without modifying database schema.

## 1. Problem Statement

### Current Limitation
When users upload CSV/XLSX files with numerical/tabular data:
- Traditional RAG (chunk → embed → vector search) performs poorly
- Numerical data has no semantic meaning for embeddings
- Users expect SQL-like queries (aggregations, filters, joins)
- The system cannot answer analytical questions like "Top 10 customers by sales"

### Goal
Add structured data query capability with:
- **Zero database migrations** - Reuse existing JSON fields
- **Minimal code changes** - Leverage existing patterns and extension points
- **Backward compatibility** - Existing KBs continue to work unchanged
- **Single unified API** - Same RAG endpoint handles both semantic and structured queries

---

## 2. Existing Fields Analysis

### 2.1 Fields That Can Be Reused

| Field | Location | Current Use | Structured Query Use |
|-------|----------|-------------|---------------------|
| `source_type` | KnowledgeDocument | `file`, `text`, `table`, `web` | Already supports `table` type |
| `source_config` | KnowledgeDocument (JSON) | `{"url": "..."}` for tables | Store schema, DuckDB table name |
| `splitter_config` | KnowledgeDocument (JSON) | Chunking strategy | Add `structured` type |
| `chunks` | KnowledgeDocument (JSON) | Chunk metadata | Store schema info, column stats |
| `retrieval_mode` | RetrievalConfig | `vector`, `keyword`, `hybrid` | Add `structured` mode |
| `metadata_condition` | RetrieveRequest | Not fully utilized | Already supports structured filtering |

### 2.2 Detailed Field Structures

**source_config (JSON)** - Can store:
```json
{
  "url": "https://...",
  "structured_data": {
    "duckdb_table_name": "kb_123_doc_456",
    "column_count": 10,
    "row_count": 5000,
    "schema": [
      {"name": "customer_id", "type": "INTEGER", "nullable": false},
      {"name": "customer_name", "type": "VARCHAR", "nullable": true},
      {"name": "amount", "type": "DOUBLE", "nullable": false},
      {"name": "order_date", "type": "DATE", "nullable": true}
    ],
    "column_stats": {
      "amount": {"min": 10.5, "max": 99999.99, "avg": 1500.0},
      "order_date": {"min": "2020-01-01", "max": "2024-12-31"}
    },
    "sample_values": {
      "customer_name": ["Alice", "Bob", "Charlie"],
      "amount": [100.0, 250.5, 1000.0]
    }
  }
}
```

**chunks (JSON)** - Can store:
```json
{
  "items": [...],
  "total_count": 25,
  "splitter_type": "structured",
  "created_at": "2025-02-11T10:00:00Z",
  "structured_metadata": {
    "query_type": "sql",
    "natural_language_description": "This table contains customer sales data...",
    "sample_queries": [
      "What are the total sales by customer?",
      "Show me the top 10 orders by amount"
    ]
  }
}
```

**RetrievalConfig** - Extend retrieval_mode:
```python
# Current values: "vector", "keyword", "hybrid"
# New value: "structured"
retrieval_mode: str = Field(
    "vector",
    description="'vector', 'keyword', 'hybrid', or 'structured'"
)
```

---

## 3. Architecture Design

### 3.1 High-Level Flow

```
                      ┌─────────────────────────┐
                      │  Unified RAG API        │
                      │  /api/internal/rag/*    │
                      └───────────┬─────────────┘
                                  │
                      ┌───────────▼─────────────┐
                      │  Query Orchestrator     │
                      │  (check retrieval_mode) │
                      └───────────┬─────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            │                     │                     │
            ▼                     ▼                     ▼
   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
   │ Semantic Mode  │   │ Structured Mode│   │  Hybrid Mode   │
   │ (Existing RAG) │   │ (New DuckDB)   │   │ (Both + Merge) │
   └────────────────┘   └────────────────┘   └────────────────┘
```

### 3.2 File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `backend/app/schemas/rag.py` | Add enum value | Add `STRUCTURED = "structured"` to `RetrievalMode` |
| `backend/app/schemas/kind.py` | Add field | Add `structured_query_config` to `RetrievalConfig` |
| `backend/app/services/knowledge/structured/` | New directory | DuckDB engine, Text-to-SQL, SQL validator |
| `backend/app/services/rag/retrieval_service.py` | Extend method | Add structured mode handling in `retrieve()` |
| `backend/app/api/endpoints/internal/rag.py` | Extend endpoint | Add structured query handling |
| `chat_shell/chat_shell/tools/builtin/knowledge_base.py` | Extend tool | Add structured query support |

**Estimated: ~8 files modified/created, ~800 lines of code**

---

## 4. Implementation Details

### 4.1 New Directory Structure

```
backend/app/services/knowledge/structured/
├── __init__.py
├── engine.py              # StructuredQueryEngine
├── duckdb_storage.py      # DuckDB storage management
├── text_to_sql.py         # Text-to-SQL generator
├── sql_validator.py       # SQL safety validation
├── schema_extractor.py    # Extract schema from CSV/XLSX
└── ingestion.py           # Data ingestion pipeline
```

### 4.2 Schema Extension (No DB Migration)

**RetrievalConfig in `kind.py`** - Add optional field:

```python
class StructuredQueryConfig(BaseModel):
    """Configuration for structured data queries."""

    enabled: bool = Field(default=False, description="Enable structured queries")
    max_rows_per_query: int = Field(default=10000, ge=1, le=100000)
    sql_model_name: Optional[str] = Field(None, description="Model for Text-to-SQL")
    sql_model_namespace: str = Field("default")
    allowed_operations: List[str] = Field(default=["SELECT"])

class RetrievalConfig(BaseModel):
    # ... existing fields ...

    # NEW: Optional structured query configuration
    structured_query_config: Optional[StructuredQueryConfig] = Field(
        None,
        description="Configuration for structured data queries (CSV/XLSX)"
    )
```

### 4.3 Retrieval Mode Extension

**In `schemas/rag.py`:**

```python
class RetrievalMode(str, Enum):
    VECTOR = "vector"       # Pure vector search
    KEYWORD = "keyword"     # Pure BM25 keyword search
    HYBRID = "hybrid"       # Hybrid search (vector + BM25)
    STRUCTURED = "structured"  # NEW: SQL-based structured query
```

### 4.4 Query Orchestration

**In `retrieval_service.py`:**

```python
async def _retrieve_from_kb_internal(self, query, kb, db, ...):
    # Extract retrieval config
    retrieval_config = spec.get("retrievalConfig")
    retrieval_mode = retrieval_config.get("retrieval_mode", "vector")

    # NEW: Check if structured mode
    if retrieval_mode == "structured":
        # Check if structured query is configured
        structured_config = retrieval_config.get("structured_query_config")
        if structured_config and structured_config.get("enabled"):
            return await self._execute_structured_query(
                query=query,
                kb=kb,
                db=db,
                structured_config=structured_config,
            )
        else:
            # Fall back to vector mode if structured not configured
            retrieval_mode = "vector"

    # ... existing vector/keyword/hybrid logic ...
```

### 4.5 DuckDB Storage

**Key Design:**
- Use **per-KB in-memory DuckDB** for isolation and simplicity
- Store schema metadata in `source_config` JSON field
- Store table name reference in `source_config.structured_data.duckdb_table_name`

```python
# backend/app/services/knowledge/structured/duckdb_storage.py

class DuckDBManager:
    """Manages DuckDB instances for structured data queries."""

    _instances: Dict[int, duckdb.DuckDBPyConnection] = {}

    @classmethod
    def get_connection(cls, kb_id: int) -> duckdb.DuckDBPyConnection:
        """Get or create DuckDB connection for a knowledge base."""
        if kb_id not in cls._instances:
            cls._instances[kb_id] = duckdb.connect(":memory:")
        return cls._instances[kb_id]

    @classmethod
    def ingest_csv(cls, kb_id: int, doc_id: int, file_data: bytes) -> Dict:
        """Ingest CSV data into DuckDB and return schema."""
        conn = cls.get_connection(kb_id)
        table_name = f"doc_{doc_id}"

        # Create table from CSV
        df = pd.read_csv(io.BytesIO(file_data))
        conn.register(f"df_{doc_id}", df)
        conn.execute(f"CREATE TABLE {table_name} AS SELECT * FROM df_{doc_id}")

        # Extract schema
        schema = cls._extract_schema(conn, table_name)
        return {
            "duckdb_table_name": table_name,
            "schema": schema,
            "row_count": len(df),
            "column_count": len(df.columns),
        }

    @classmethod
    def execute_query(cls, kb_id: int, sql: str, max_rows: int = 10000) -> Dict:
        """Execute SQL query with safety limits."""
        conn = cls.get_connection(kb_id)

        # Add LIMIT if not present
        if "LIMIT" not in sql.upper():
            sql = f"{sql} LIMIT {max_rows}"

        result = conn.execute(sql).fetchdf()
        return {
            "columns": list(result.columns),
            "rows": result.values.tolist(),
            "row_count": len(result),
            "truncated": len(result) >= max_rows,
        }
```

### 4.6 Text-to-SQL

```python
# backend/app/services/knowledge/structured/text_to_sql.py

class TextToSQLGenerator:
    """Generate SQL from natural language using LLM."""

    SYSTEM_PROMPT = """You are a SQL expert. Generate DuckDB SQL queries.

Rules:
1. Only generate SELECT queries (no INSERT, UPDATE, DELETE, DROP)
2. Use appropriate aggregations (SUM, COUNT, AVG, MAX, MIN)
3. Add WHERE clauses for filtering when appropriate
4. Use GROUP BY for categorical analysis
5. Order results meaningfully
6. Always include LIMIT for safety

Output format:
```sql
YOUR_QUERY_HERE
```
"""

    async def generate(self, query: str, schema: Dict, model_config: Dict) -> Dict:
        """Generate SQL from natural language query."""
        prompt = self._build_prompt(query, schema)

        # Call LLM (use existing model infrastructure)
        response = await self._call_model(prompt, model_config)

        # Extract SQL from response
        sql = self._extract_sql(response)

        return {
            "sql": sql,
            "explanation": self._extract_explanation(response),
            "confidence": self._calculate_confidence(response),
        }

    def _build_prompt(self, query: str, schema: Dict) -> str:
        return f"""
## Table Schema
{self._format_schema(schema)}

## User Question
{query}

Generate a SQL query to answer this question.
"""
```

### 4.7 SQL Validator

```python
# backend/app/services/knowledge/structured/sql_validator.py

class SQLValidator:
    """Validate SQL for safety."""

    FORBIDDEN_KEYWORDS = [
        "DROP", "DELETE", "UPDATE", "INSERT", "ALTER", "CREATE",
        "TRUNCATE", "GRANT", "REVOKE", "EXECUTE",
    ]

    def validate(self, sql: str, allowed_tables: List[str]) -> Dict:
        """Validate SQL query for safety."""
        errors = []

        # Check forbidden keywords
        sql_upper = sql.upper()
        for keyword in self.FORBIDDEN_KEYWORDS:
            if keyword in sql_upper:
                errors.append(f"Forbidden operation: {keyword}")

        # Check table access
        tables = self._extract_tables(sql)
        for table in tables:
            if table not in allowed_tables:
                errors.append(f"Access denied to table: {table}")

        return {
            "is_valid": len(errors) == 0,
            "errors": errors,
        }
```

---

## 5. Integration Points

### 5.1 Document Upload Flow

**Location:** `backend/app/api/endpoints/knowledge.py` line 426

Current code:
```python
if knowledge_base and data.source_type != DocumentSourceType.TABLE:
    # Schedule RAG indexing
```

New code:
```python
if knowledge_base:
    if self._is_structured_document(data.file_extension):
        # Schedule structured data ingestion
        await _schedule_structured_ingestion(background_tasks, params)
    elif data.source_type != DocumentSourceType.TABLE:
        # Existing RAG indexing
        await _schedule_rag_indexing(background_tasks, params)
```

### 5.2 Chat Shell Tool

**Location:** `chat_shell/chat_shell/tools/builtin/knowledge_base.py`

Extend `_arun` method:
```python
async def _arun(self, query: str, max_results: int = 20, ...):
    # Get KB info to determine query type
    kb_info = await self._get_kb_info()

    # Check if structured query is available
    if self._is_structured_query_available(kb_info):
        query_type = self._classify_query(query)
        if query_type == "structured":
            return await self._execute_structured_query(query, kb_info)

    # Fall back to existing semantic query
    # ... existing code ...
```

### 5.3 Internal RAG API

**Location:** `backend/app/api/endpoints/internal/rag.py`

Add endpoint:
```python
@router.post("/structured-query")
async def structured_query(
    request: StructuredQueryRequest,
    db: Session = Depends(get_db),
):
    """Execute structured SQL query on knowledge base."""
    from app.services.knowledge.structured.engine import StructuredQueryEngine

    engine = StructuredQueryEngine()
    return await engine.execute(
        knowledge_base_id=request.knowledge_base_id,
        query=request.query,
        db=db,
    )
```

---

## 6. Feature Flag & Configuration

### 6.1 Backend Settings

**Location:** `backend/app/core/config.py`

```python
class Settings(BaseSettings):
    # Structured data feature flag
    ENABLE_STRUCTURED_DATA: bool = Field(
        default=False,
        env="ENABLE_STRUCTURED_DATA",
        description="Enable structured data (CSV/XLSX) query support"
    )

    # Text-to-SQL model (default: fast and cheap)
    STRUCTURED_QUERY_MODEL: str = Field(
        default="claude-3-5-haiku-20241022",
        description="Model for Text-to-SQL generation"
    )

    # Safety limits
    MAX_STRUCTURED_ROWS: int = Field(
        default=10000,
        description="Maximum rows per structured query"
    )
```

### 6.2 Per-KB Configuration

Via `spec.retrievalConfig.structured_query_config`:
```json
{
  "retrievalConfig": {
    "retrieval_mode": "structured",
    "structured_query_config": {
      "enabled": true,
      "max_rows_per_query": 10000,
      "sql_model_name": "claude-3-5-haiku",
      "sql_model_namespace": "default",
      "allowed_operations": ["SELECT"]
    }
  }
}
```

---

## 7. Query Routing Logic

### 7.1 Auto-Detection Patterns

```python
# Structured query indicators
STRUCTURED_PATTERNS = [
    r"\b(sum|count|average|avg|max|min|total|合计|统计|平均)\b",
    r"\b(group by|filter|where|between|筛选|过滤|分组)\b",
    r"\b(how many|what is the total|calculate|多少|总共|计算)\b",
    r"\b(top \d+|bottom \d+|前\d+|后\d+|排名)\b",
    r"\b(percentage|ratio|rate|百分比|比例|占比)\b",
]

# Semantic query indicators
SEMANTIC_PATTERNS = [
    r"\b(what|why|how|explain|describe|什么|为什么|如何|解释|描述)\b",
    r"\b(summarize|overview|meaning|总结|概述|含义)\b",
    r"\b(similar to|related to|like|类似|相关|像)\b",
]
```

### 7.2 Routing Decision

```python
def classify_query(query: str, kb_has_structured: bool, kb_has_semantic: bool) -> str:
    """Classify query intent."""
    if not kb_has_structured:
        return "semantic"
    if not kb_has_semantic:
        return "structured"

    # Both available - use pattern matching
    structured_score = sum(1 for p in STRUCTURED_PATTERNS if re.search(p, query, re.I))
    semantic_score = sum(1 for p in SEMANTIC_PATTERNS if re.search(p, query, re.I))

    if structured_score > semantic_score:
        return "structured"
    return "semantic"
```

---

## 8. Response Format

### 8.1 Structured Query Response

```json
{
  "query": "Top 10 customers by sales",
  "mode": "structured_query",
  "generated_sql": "SELECT customer_name, SUM(amount) as total_sales FROM doc_123 GROUP BY customer_name ORDER BY total_sales DESC LIMIT 10",
  "explanation": "This query aggregates sales by customer and returns the top 10",
  "confidence": 0.95,
  "results": {
    "columns": ["customer_name", "total_sales"],
    "rows": [
      ["Alice Corp", 150000.0],
      ["Bob Inc", 120000.0]
    ],
    "row_count": 10,
    "truncated": false
  },
  "sources": [
    {"index": 1, "title": "sales_2024.csv", "kb_id": 123}
  ]
}
```

---

## 9. Implementation Phases

### Phase 1: Core Infrastructure (Week 1-2)
- [ ] Add `STRUCTURED` to `RetrievalMode` enum
- [ ] Add `StructuredQueryConfig` to `RetrievalConfig`
- [ ] Create `backend/app/services/knowledge/structured/` directory
- [ ] Implement `DuckDBManager` for data storage
- [ ] Implement `SchemaExtractor` for CSV/XLSX parsing

### Phase 2: Query Engine (Week 3)
- [ ] Implement `TextToSQLGenerator`
- [ ] Implement `SQLValidator`
- [ ] Implement `StructuredQueryEngine`
- [ ] Add feature flag configuration

### Phase 3: Integration (Week 4)
- [ ] Extend document upload flow for structured ingestion
- [ ] Add `/structured-query` internal API endpoint
- [ ] Extend `RetrievalService` for structured mode
- [ ] Update `KnowledgeBaseTool` in chat_shell

### Phase 4: Testing & Polish (Week 5)
- [ ] Unit tests for all new components
- [ ] Integration tests for end-to-end flow
- [ ] Query routing accuracy testing
- [ ] Performance optimization

---

## 10. Files to Modify/Create

### New Files (~6 files)
```
backend/app/services/knowledge/structured/__init__.py
backend/app/services/knowledge/structured/engine.py
backend/app/services/knowledge/structured/duckdb_storage.py
backend/app/services/knowledge/structured/text_to_sql.py
backend/app/services/knowledge/structured/sql_validator.py
backend/app/services/knowledge/structured/schema_extractor.py
```

### Modified Files (~6 files)
```
backend/app/schemas/rag.py                    # Add STRUCTURED enum
backend/app/schemas/kind.py                   # Add StructuredQueryConfig
backend/app/core/config.py                    # Add feature flags
backend/app/services/rag/retrieval_service.py # Add structured mode
backend/app/api/endpoints/internal/rag.py     # Add structured query endpoint
chat_shell/chat_shell/tools/builtin/knowledge_base.py  # Add structured support
```

**Total: ~12 files, ~1000 lines of new code**

---

## 11. Key Design Decisions

### Why No Database Migration?
1. All structured metadata fits in existing JSON fields
2. `source_config` is flexible JSON - can store any data
3. `chunks` JSON can store schema metadata
4. `retrieval_mode` in RetrievalConfig is a string field

### Why Per-KB In-Memory DuckDB?
1. Simple isolation between knowledge bases
2. No persistent storage management needed
3. Fast startup (data loaded from source_config on demand)
4. Easy cleanup when KB is deleted

### Why Pattern-Based Query Routing?
1. No additional LLM call needed for routing
2. Deterministic and fast
3. Can be overridden by explicit `query_type` parameter
4. Works well for common query patterns

---

## 12. Backward Compatibility

### Existing KBs
- Default `retrieval_mode` remains `"vector"`
- No changes to existing document processing
- Structured features only activated when explicitly configured

### API Compatibility
- All existing endpoints unchanged
- New functionality added as optional parameters
- `retrieval_mode: "structured"` is opt-in

### Data Compatibility
- Existing `source_config` JSON preserved
- New structured data stored alongside existing fields
- No migration of existing documents required

---

## 13. Testing Strategy

### Unit Tests
```python
# test_duckdb_storage.py
def test_ingest_csv():
    manager = DuckDBManager()
    schema = manager.ingest_csv(kb_id=1, doc_id=1, file_data=csv_bytes)
    assert "duckdb_table_name" in schema
    assert len(schema["schema"]) > 0

# test_text_to_sql.py
async def test_generate_simple_query():
    generator = TextToSQLGenerator()
    result = await generator.generate(
        query="Total sales by customer",
        schema=mock_schema,
        model_config=mock_config,
    )
    assert "SELECT" in result["sql"].upper()
    assert "GROUP BY" in result["sql"].upper()

# test_sql_validator.py
def test_block_dangerous_sql():
    validator = SQLValidator()
    result = validator.validate("DROP TABLE users", allowed_tables=["doc_1"])
    assert not result["is_valid"]
    assert "DROP" in str(result["errors"])
```

### Integration Tests
```python
# test_structured_query_e2e.py
async def test_structured_query_flow():
    # 1. Create KB with structured config
    # 2. Upload CSV document
    # 3. Query with natural language
    # 4. Verify SQL generation and execution
    pass
```

---

## 14. Summary

This design achieves structured data query capability with:

| Metric | Value |
|--------|-------|
| Database migrations | 0 |
| New files | ~6 |
| Modified files | ~6 |
| Lines of code | ~1000 |
| Breaking changes | 0 |
| Feature flag | Yes |

The key insight is that Wegent's existing JSON fields (`source_config`, `chunks`, `retrieval_mode`) provide all the flexibility needed to store structured data metadata without schema changes.

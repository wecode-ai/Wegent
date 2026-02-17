---
sidebar_position: 10
---

# 结构化数据查询设计 - 最小侵入方案

本文档描述了一种最小侵入式的方案，用于向 Wegent 的知识库系统添加结构化数据（CSV/XLSX）查询能力，且无需修改数据库模式。

## 1. 问题描述

### 当前限制
当用户上传包含数值/表格数据的 CSV/XLSX 文件时：
- 传统 RAG（分块 → 向量化 → 向量搜索）效果较差
- 数值数据对向量嵌入没有语义意义
- 用户期望类 SQL 查询（聚合、过滤、连接）
- 系统无法回答类似"按销售额排名前10的客户"这样的分析问题

### 目标
添加结构化数据查询能力，具备以下特点：
- **零数据库迁移** - 复用现有的 JSON 字段
- **最小代码改动** - 利用现有模式和扩展点
- **向后兼容** - 现有知识库继续正常工作
- **统一 API** - 同一个 RAG 端点处理语义和结构化查询

---

## 2. 现有字段分析

### 2.1 可复用的字段

| 字段 | 位置 | 当前用途 | 结构化查询用途 |
|------|------|---------|--------------|
| `source_type` | KnowledgeDocument | `file`, `text`, `table`, `web` | 已支持 `table` 类型 |
| `source_config` | KnowledgeDocument (JSON) | 表格的 `{"url": "..."}` | 存储模式、DuckDB 表名 |
| `splitter_config` | KnowledgeDocument (JSON) | 分块策略 | 添加 `structured` 类型 |
| `chunks` | KnowledgeDocument (JSON) | 分块元数据 | 存储模式信息、列统计 |
| `retrieval_mode` | RetrievalConfig | `vector`, `keyword`, `hybrid` | 添加 `structured` 模式 |
| `metadata_condition` | RetrieveRequest | 未充分利用 | 已支持结构化过滤 |

### 2.2 详细字段结构

**source_config (JSON)** - 可存储：
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

**chunks (JSON)** - 可存储：
```json
{
  "items": [...],
  "total_count": 25,
  "splitter_type": "structured",
  "created_at": "2025-02-11T10:00:00Z",
  "structured_metadata": {
    "query_type": "sql",
    "natural_language_description": "此表包含客户销售数据...",
    "sample_queries": [
      "每个客户的总销售额是多少？",
      "显示金额最高的前10个订单"
    ]
  }
}
```

**RetrievalConfig** - 扩展 retrieval_mode：
```python
# 当前值: "vector", "keyword", "hybrid"
# 新增值: "structured"
retrieval_mode: str = Field(
    "vector",
    description="'vector', 'keyword', 'hybrid' 或 'structured'"
)
```

---

## 3. 架构设计

### 3.1 高层流程

```
                      ┌─────────────────────────┐
                      │     统一 RAG API        │
                      │  /api/internal/rag/*    │
                      └───────────┬─────────────┘
                                  │
                      ┌───────────▼─────────────┐
                      │      查询编排器         │
                      │  (检查 retrieval_mode)  │
                      └───────────┬─────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            │                     │                     │
            ▼                     ▼                     ▼
   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
   │   语义模式     │   │   结构化模式   │   │    混合模式    │
   │  (现有 RAG)    │   │  (新 DuckDB)   │   │  (两者 + 合并) │
   └────────────────┘   └────────────────┘   └────────────────┘
```

### 3.2 文件变更概览

| 文件 | 变更类型 | 描述 |
|------|---------|------|
| `backend/app/schemas/rag.py` | 添加枚举值 | 为 `RetrievalMode` 添加 `STRUCTURED = "structured"` |
| `backend/app/schemas/kind.py` | 添加字段 | 为 `RetrievalConfig` 添加 `structured_query_config` |
| `backend/app/services/knowledge/structured/` | 新目录 | DuckDB 引擎、Text-to-SQL、SQL 验证器 |
| `backend/app/services/rag/retrieval_service.py` | 扩展方法 | 在 `retrieve()` 中添加结构化模式处理 |
| `backend/app/api/endpoints/internal/rag.py` | 扩展端点 | 添加结构化查询处理 |
| `chat_shell/chat_shell/tools/builtin/knowledge_base.py` | 扩展工具 | 添加结构化查询支持 |

**预估：约 8 个文件修改/创建，约 800 行代码**

---

## 4. 实现细节

### 4.1 新目录结构

```
backend/app/services/knowledge/structured/
├── __init__.py
├── engine.py              # StructuredQueryEngine
├── duckdb_storage.py      # DuckDB 存储管理
├── text_to_sql.py         # Text-to-SQL 生成器
├── sql_validator.py       # SQL 安全验证
├── schema_extractor.py    # 从 CSV/XLSX 提取模式
└── ingestion.py           # 数据摄入管道
```

### 4.2 模式扩展（无数据库迁移）

**kind.py 中的 RetrievalConfig** - 添加可选字段：

```python
class StructuredQueryConfig(BaseModel):
    """结构化数据查询配置。"""

    enabled: bool = Field(default=False, description="启用结构化查询")
    max_rows_per_query: int = Field(default=10000, ge=1, le=100000)
    sql_model_name: Optional[str] = Field(None, description="Text-to-SQL 使用的模型")
    sql_model_namespace: str = Field("default")
    allowed_operations: List[str] = Field(default=["SELECT"])

class RetrievalConfig(BaseModel):
    # ... 现有字段 ...

    # 新增：可选的结构化查询配置
    structured_query_config: Optional[StructuredQueryConfig] = Field(
        None,
        description="结构化数据查询配置（CSV/XLSX）"
    )
```

### 4.3 检索模式扩展

**在 `schemas/rag.py` 中：**

```python
class RetrievalMode(str, Enum):
    VECTOR = "vector"       # 纯向量搜索
    KEYWORD = "keyword"     # 纯 BM25 关键词搜索
    HYBRID = "hybrid"       # 混合搜索（向量 + BM25）
    STRUCTURED = "structured"  # 新增：基于 SQL 的结构化查询
```

### 4.4 查询编排

**在 `retrieval_service.py` 中：**

```python
async def _retrieve_from_kb_internal(self, query, kb, db, ...):
    # 提取检索配置
    retrieval_config = spec.get("retrievalConfig")
    retrieval_mode = retrieval_config.get("retrieval_mode", "vector")

    # 新增：检查是否为结构化模式
    if retrieval_mode == "structured":
        # 检查结构化查询是否已配置
        structured_config = retrieval_config.get("structured_query_config")
        if structured_config and structured_config.get("enabled"):
            return await self._execute_structured_query(
                query=query,
                kb=kb,
                db=db,
                structured_config=structured_config,
            )
        else:
            # 如果未配置结构化，回退到向量模式
            retrieval_mode = "vector"

    # ... 现有的 vector/keyword/hybrid 逻辑 ...
```

### 4.5 DuckDB 存储

**关键设计：**
- 使用**每个知识库独立的内存 DuckDB** 实现隔离和简化
- 将模式元数据存储在 `source_config` JSON 字段中
- 将表名引用存储在 `source_config.structured_data.duckdb_table_name`

```python
# backend/app/services/knowledge/structured/duckdb_storage.py

class DuckDBManager:
    """管理用于结构化数据查询的 DuckDB 实例。"""

    _instances: Dict[int, duckdb.DuckDBPyConnection] = {}

    @classmethod
    def get_connection(cls, kb_id: int) -> duckdb.DuckDBPyConnection:
        """获取或创建知识库的 DuckDB 连接。"""
        if kb_id not in cls._instances:
            cls._instances[kb_id] = duckdb.connect(":memory:")
        return cls._instances[kb_id]

    @classmethod
    def ingest_csv(cls, kb_id: int, doc_id: int, file_data: bytes) -> Dict:
        """将 CSV 数据摄入 DuckDB 并返回模式。"""
        conn = cls.get_connection(kb_id)
        table_name = f"doc_{doc_id}"

        # 从 CSV 创建表
        df = pd.read_csv(io.BytesIO(file_data))
        conn.register(f"df_{doc_id}", df)
        conn.execute(f"CREATE TABLE {table_name} AS SELECT * FROM df_{doc_id}")

        # 提取模式
        schema = cls._extract_schema(conn, table_name)
        return {
            "duckdb_table_name": table_name,
            "schema": schema,
            "row_count": len(df),
            "column_count": len(df.columns),
        }

    @classmethod
    def execute_query(cls, kb_id: int, sql: str, max_rows: int = 10000) -> Dict:
        """执行 SQL 查询，带安全限制。"""
        conn = cls.get_connection(kb_id)

        # 如果没有 LIMIT 则添加
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
    """使用 LLM 从自然语言生成 SQL。"""

    SYSTEM_PROMPT = """你是一个 SQL 专家。生成 DuckDB SQL 查询。

规则：
1. 只生成 SELECT 查询（禁止 INSERT、UPDATE、DELETE、DROP）
2. 使用适当的聚合函数（SUM、COUNT、AVG、MAX、MIN）
3. 适当时添加 WHERE 子句进行过滤
4. 使用 GROUP BY 进行分类分析
5. 有意义地排序结果
6. 始终包含 LIMIT 以确保安全

输出格式：
```sql
你的查询
```
"""

    async def generate(self, query: str, schema: Dict, model_config: Dict) -> Dict:
        """从自然语言查询生成 SQL。"""
        prompt = self._build_prompt(query, schema)

        # 调用 LLM（使用现有模型基础设施）
        response = await self._call_model(prompt, model_config)

        # 从响应中提取 SQL
        sql = self._extract_sql(response)

        return {
            "sql": sql,
            "explanation": self._extract_explanation(response),
            "confidence": self._calculate_confidence(response),
        }

    def _build_prompt(self, query: str, schema: Dict) -> str:
        return f"""
## 表模式
{self._format_schema(schema)}

## 用户问题
{query}

生成一个 SQL 查询来回答这个问题。
"""
```

### 4.7 SQL 验证器

```python
# backend/app/services/knowledge/structured/sql_validator.py

class SQLValidator:
    """验证 SQL 安全性。"""

    FORBIDDEN_KEYWORDS = [
        "DROP", "DELETE", "UPDATE", "INSERT", "ALTER", "CREATE",
        "TRUNCATE", "GRANT", "REVOKE", "EXECUTE",
    ]

    def validate(self, sql: str, allowed_tables: List[str]) -> Dict:
        """验证 SQL 查询的安全性。"""
        errors = []

        # 检查禁止的关键词
        sql_upper = sql.upper()
        for keyword in self.FORBIDDEN_KEYWORDS:
            if keyword in sql_upper:
                errors.append(f"禁止的操作: {keyword}")

        # 检查表访问权限
        tables = self._extract_tables(sql)
        for table in tables:
            if table not in allowed_tables:
                errors.append(f"拒绝访问表: {table}")

        return {
            "is_valid": len(errors) == 0,
            "errors": errors,
        }
```

---

## 5. 集成点

### 5.1 文档上传流程

**位置：** `backend/app/api/endpoints/knowledge.py` 第 426 行

当前代码：
```python
if knowledge_base and data.source_type != DocumentSourceType.TABLE:
    # 调度 RAG 索引
```

新代码：
```python
if knowledge_base:
    if self._is_structured_document(data.file_extension):
        # 调度结构化数据摄入
        await _schedule_structured_ingestion(background_tasks, params)
    elif data.source_type != DocumentSourceType.TABLE:
        # 现有 RAG 索引
        await _schedule_rag_indexing(background_tasks, params)
```

### 5.2 Chat Shell 工具

**位置：** `chat_shell/chat_shell/tools/builtin/knowledge_base.py`

扩展 `_arun` 方法：
```python
async def _arun(self, query: str, max_results: int = 20, ...):
    # 获取 KB 信息以确定查询类型
    kb_info = await self._get_kb_info()

    # 检查结构化查询是否可用
    if self._is_structured_query_available(kb_info):
        query_type = self._classify_query(query)
        if query_type == "structured":
            return await self._execute_structured_query(query, kb_info)

    # 回退到现有语义查询
    # ... 现有代码 ...
```

### 5.3 内部 RAG API

**位置：** `backend/app/api/endpoints/internal/rag.py`

添加端点：
```python
@router.post("/structured-query")
async def structured_query(
    request: StructuredQueryRequest,
    db: Session = Depends(get_db),
):
    """在知识库上执行结构化 SQL 查询。"""
    from app.services.knowledge.structured.engine import StructuredQueryEngine

    engine = StructuredQueryEngine()
    return await engine.execute(
        knowledge_base_id=request.knowledge_base_id,
        query=request.query,
        db=db,
    )
```

---

## 6. 功能开关与配置

### 6.1 后端设置

**位置：** `backend/app/core/config.py`

```python
class Settings(BaseSettings):
    # 结构化数据功能开关
    STRUCTURED_DATA_ENABLED: bool = False  # 启用结构化数据（CSV/XLSX）查询支持

    # Text-to-SQL 模型（默认：快速且便宜）
    STRUCTURED_DATA_MODEL: str = "claude-3-5-haiku-20241022"  # 用于 Text-to-SQL 生成的模型

    # 安全限制
    STRUCTURED_DATA_MAX_ROWS: int = 10000  # 每次结构化查询的最大行数
```

### 6.2 每个知识库的配置

通过 `spec.retrievalConfig.structured_query_config`：
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

## 7. 查询路由逻辑

### 7.1 自动检测模式

```python
# 结构化查询指示符
STRUCTURED_PATTERNS = [
    r"\b(sum|count|average|avg|max|min|total|合计|统计|平均)\b",
    r"\b(group by|filter|where|between|筛选|过滤|分组)\b",
    r"\b(how many|what is the total|calculate|多少|总共|计算)\b",
    r"\b(top \d+|bottom \d+|前\d+|后\d+|排名)\b",
    r"\b(percentage|ratio|rate|百分比|比例|占比)\b",
]

# 语义查询指示符
SEMANTIC_PATTERNS = [
    r"\b(what|why|how|explain|describe|什么|为什么|如何|解释|描述)\b",
    r"\b(summarize|overview|meaning|总结|概述|含义)\b",
    r"\b(similar to|related to|like|类似|相关|像)\b",
]
```

### 7.2 路由决策

```python
def classify_query(query: str, kb_has_structured: bool, kb_has_semantic: bool) -> str:
    """分类查询意图。"""
    if not kb_has_structured:
        return "semantic"
    if not kb_has_semantic:
        return "structured"

    # 两者都可用 - 使用模式匹配
    structured_score = sum(1 for p in STRUCTURED_PATTERNS if re.search(p, query, re.I))
    semantic_score = sum(1 for p in SEMANTIC_PATTERNS if re.search(p, query, re.I))

    if structured_score > semantic_score:
        return "structured"
    return "semantic"
```

---

## 8. 响应格式

### 8.1 结构化查询响应

```json
{
  "query": "按销售额排名前10的客户",
  "mode": "structured_query",
  "generated_sql": "SELECT customer_name, SUM(amount) as total_sales FROM doc_123 GROUP BY customer_name ORDER BY total_sales DESC LIMIT 10",
  "explanation": "此查询按客户汇总销售额并返回前10名",
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

## 9. 实施阶段

### 第一阶段：核心基础设施（第1-2周）
- [ ] 向 `RetrievalMode` 枚举添加 `STRUCTURED`
- [ ] 向 `RetrievalConfig` 添加 `StructuredQueryConfig`
- [ ] 创建 `backend/app/services/knowledge/structured/` 目录
- [ ] 实现用于数据存储的 `DuckDBManager`
- [ ] 实现用于 CSV/XLSX 解析的 `SchemaExtractor`

### 第二阶段：查询引擎（第3周）
- [ ] 实现 `TextToSQLGenerator`
- [ ] 实现 `SQLValidator`
- [ ] 实现 `StructuredQueryEngine`
- [ ] 添加功能开关配置

### 第三阶段：集成（第4周）
- [ ] 扩展文档上传流程以支持结构化摄入
- [ ] 添加 `/structured-query` 内部 API 端点
- [ ] 扩展 `RetrievalService` 以支持结构化模式
- [ ] 更新 chat_shell 中的 `KnowledgeBaseTool`

### 第四阶段：测试与优化（第5周）
- [ ] 所有新组件的单元测试
- [ ] 端到端流程的集成测试
- [ ] 查询路由准确性测试
- [ ] 性能优化

---

## 10. 需要修改/创建的文件

### 新文件（约6个）
```
backend/app/services/knowledge/structured/__init__.py
backend/app/services/knowledge/structured/engine.py
backend/app/services/knowledge/structured/duckdb_storage.py
backend/app/services/knowledge/structured/text_to_sql.py
backend/app/services/knowledge/structured/sql_validator.py
backend/app/services/knowledge/structured/schema_extractor.py
```

### 修改的文件（约6个）
```
backend/app/schemas/rag.py                    # 添加 STRUCTURED 枚举
backend/app/schemas/kind.py                   # 添加 StructuredQueryConfig
backend/app/core/config.py                    # 添加功能开关
backend/app/services/rag/retrieval_service.py # 添加结构化模式
backend/app/api/endpoints/internal/rag.py     # 添加结构化查询端点
chat_shell/chat_shell/tools/builtin/knowledge_base.py  # 添加结构化支持
```

**总计：约12个文件，约1000行新代码**

---

## 11. 关键设计决策

### 为什么不需要数据库迁移？
1. 所有结构化元数据都可以放入现有的 JSON 字段
2. `source_config` 是灵活的 JSON - 可以存储任何数据
3. `chunks` JSON 可以存储模式元数据
4. RetrievalConfig 中的 `retrieval_mode` 是字符串字段

### 为什么使用每个知识库独立的内存 DuckDB？
1. 知识库之间简单隔离
2. 不需要持久存储管理
3. 快速启动（数据按需从 source_config 加载）
4. 删除知识库时容易清理

### 为什么使用基于模式的查询路由？
1. 不需要额外的 LLM 调用来路由
2. 确定性且快速
3. 可以通过显式的 `query_type` 参数覆盖
4. 对常见查询模式效果良好

---

## 12. 向后兼容性

### 现有知识库
- 默认 `retrieval_mode` 保持 `"vector"`
- 现有文档处理不变
- 结构化功能仅在明确配置时激活

### API 兼容性
- 所有现有端点不变
- 新功能作为可选参数添加
- `retrieval_mode: "structured"` 是可选启用的

### 数据兼容性
- 现有 `source_config` JSON 保留
- 新的结构化数据与现有字段并存
- 不需要迁移现有文档

---

## 13. 测试策略

### 单元测试
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
        query="按客户统计总销售额",
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

### 集成测试
```python
# test_structured_query_e2e.py
async def test_structured_query_flow():
    # 1. 创建带结构化配置的知识库
    # 2. 上传 CSV 文档
    # 3. 用自然语言查询
    # 4. 验证 SQL 生成和执行
    pass
```

---

## 14. 总结

本设计通过以下方式实现结构化数据查询能力：

| 指标 | 值 |
|------|-----|
| 数据库迁移 | 0 |
| 新文件 | 约6个 |
| 修改的文件 | 约6个 |
| 代码行数 | 约1000行 |
| 破坏性变更 | 0 |
| 功能开关 | 是 |

关键洞察是 Wegent 现有的 JSON 字段（`source_config`、`chunks`、`retrieval_mode`）提供了足够的灵活性来存储结构化数据元数据，无需进行模式变更。

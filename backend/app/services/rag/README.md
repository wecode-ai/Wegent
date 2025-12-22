# RAG Retriever Architecture Design

## Overview

This document describes the architecture design of the Retriever abstraction for the RAG (Retrieval-Augmented Generation) system. The Retriever is implemented as an independent CRD (Custom Resource Definition) Kind, parallel to Model and Shell, providing flexible storage backend configuration capabilities.

## Design Goals

1. **Storage Backend Abstraction**: Support multiple vector databases (Elasticsearch, Qdrant, etc.)
2. **Flexible Index Strategies**: Support fixed index, rolling index, and per-knowledge-base index
3. **Multiple Retrieval Methods**: Support vector search, keyword search, and hybrid search
4. **Dify-style API**: Reference Dify External Knowledge API design for standardized interface
5. **Metadata Filtering**: Support advanced filtering based on metadata conditions

## Architecture Components

### 1. Retriever CRD Schema

**Location**: `backend/app/schemas/kind.py`

```python
class Retriever(BaseModel):
    """Retriever CRD"""
    apiVersion: str = "agent.wecode.io/v1"
    kind: str = "Retriever"
    metadata: ObjectMeta
    spec: RetrieverSpec
```

**Core Configuration**:

- **IndexStrategy**: Index naming strategy
  - `mode`: 'fixed' | 'rolling' | 'per_dataset'
  - `fixedName`: Fixed index name (for fixed mode)
  - `rollingStep`: Rolling step size (for rolling mode)
  - `prefix`: Index prefix (for per_dataset mode)

- **StorageConfig**: Storage backend configuration
  - `type`: 'elasticsearch' | 'qdrant'
  - `url`: Connection URL
  - `username/password`: Authentication credentials
  - `apiKey`: API key (optional)
  - `indexStrategy`: Index strategy configuration
  - `ext`: Extended provider-specific configuration

- **RetrievalMethods**: Retrieval method configuration
  - `vector`: Vector search (default weight 0.7)
  - `keyword`: Keyword search (default weight 0.3)
  - `hybrid`: Hybrid search

### 2. Storage Backend Abstraction Layer

**Location**: `backend/app/services/rag/storage/`

#### Base Class (base.py)

```python
class BaseStorageBackend(ABC):
    @abstractmethod
    def get_index_name(self, knowledge_id: str, **kwargs) -> str:
        """Get index/collection name"""
        
    @abstractmethod
    def index(self, nodes: List[BaseNode], index_name: str, embed_model) -> Dict:
        """Index documents"""
        
    @abstractmethod
    def retrieve(
        self,
        knowledge_id: str,
        query: str,
        embed_model,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs
    ) -> Dict:
        """Retrieve documents (Dify-style API)"""
```

#### Elasticsearch Implementation (elasticsearch_backend.py)

- Supports three index strategies
- Implements vector and hybrid search
- Supports metadata filtering (to be enhanced)
- Provides document management (CRUD)

#### Qdrant Implementation (qdrant_backend.py)

- Placeholder implementation, to be completed

#### Factory Function (factory.py)

```python
def create_storage_backend(config: Dict) -> BaseStorageBackend:
    """Create storage backend instance based on configuration"""
```

### 3. Index Strategy Details

#### Fixed Mode
- All knowledge bases share a single index
- Use case: Small-scale deployment with limited data
- Configuration example:
```json
{
  "mode": "fixed",
  "fixedName": "rag_documents"
}
```

#### Rolling Mode
- Shard based on knowledge_id hash
- Use case: Medium-scale deployment requiring load balancing
- Configuration example:
```json
{
  "mode": "rolling",
  "rollingStep": 5000
}
```

#### Per Dataset Mode
- Each knowledge base has its own index
- Use case: Large-scale deployment requiring isolation
- Configuration example:
```json
{
  "mode": "per_dataset",
  "prefix": "rag"
}
```
Generated index name: `rag_kb_{knowledge_id}`

### 4. Dify-style API Design

#### Retrieval Endpoint

**Request Parameters**:
```json
{
  "knowledge_id": "AAA-BBB-CCC",
  "query": "What is Dify?",
  "retrieval_setting": {
    "top_k": 5,
    "score_threshold": 0.5,
    "retrieval_mode": "hybrid",
    "vector_weight": 0.7,
    "keyword_weight": 0.3
  },
  "metadata_condition": {
    "operator": "and",
    "conditions": [
      {"key": "category", "operator": "eq", "value": "tech"},
      {"key": "year", "operator": "gte", "value": 2020}
    ]
  }
}
```

**Response Format**:
```json
{
  "records": [
    {
      "doc_ref": "doc_123",
      "chunk_index": 0,
      "source_file": "example.md",
      "content": "...",
      "score": 0.85,
      "metadata": {...}
    }
  ],
  "query": "What is Dify?",
  "knowledge_id": "AAA-BBB-CCC",
  "total": 5,
  "retrieval_mode": "hybrid"
}
```

### 5. Metadata Filtering (To Be Implemented)

Supported operators:
- `eq`: Equal
- `ne`: Not equal
- `in`: In array
- `nin`: Not in array
- `gt`: Greater than
- `gte`: Greater than or equal
- `lt`: Less than
- `lte`: Less than or equal

Logical operators:
- `and`: Logical AND
- `or`: Logical OR

## Data Flow

### Indexing Flow

```
Document Upload
    ↓
Document Service
    ↓
Retriever CRD (loaded from kinds table)
    ↓
Storage Backend Factory
    ↓
Elasticsearch/Qdrant Backend
    ↓
Index Strategy → Index Name
    ↓
Vector Store → Index Nodes
```

### Retrieval Flow

```
Retrieval Request
    ↓
Retrieval Service
    ↓
Retriever CRD (loaded from kinds table)
    ↓
Storage Backend Factory
    ↓
Elasticsearch/Qdrant Backend
    ↓
Index Strategy → Index Name
    ↓
Metadata Filters → Build Query
    ↓
Execute Search (Vector/Hybrid)
    ↓
Filter by Score Threshold
    ↓
Return Results
```

## Database Design

Retriever is stored as a Kind in the `kinds` table:

```sql
-- kinds table structure (existing)
CREATE TABLE kinds (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,
    kind VARCHAR(50) NOT NULL,  -- 'Retriever'
    name VARCHAR(100) NOT NULL,
    namespace VARCHAR(100) NOT NULL DEFAULT 'default',
    json JSON NOT NULL,  -- Retriever CRD JSON
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**Retriever JSON Example**:
```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Retriever",
  "metadata": {
    "name": "my-es-retriever",
    "namespace": "default",
    "displayName": "My ES Retriever"
  },
  "spec": {
    "storageConfig": {
      "type": "elasticsearch",
      "url": "http://localhost:9200",
      "username": "elastic",
      "password": "changeme",
      "indexStrategy": {
        "mode": "per_dataset",
        "prefix": "rag"
      }
    },
    "retrievalMethods": {
      "vector": {"enabled": true, "defaultWeight": 0.7},
      "keyword": {"enabled": true, "defaultWeight": 0.3},
      "hybrid": {"enabled": true}
    },
    "description": "Elasticsearch retriever for production"
  }
}
```

## API Endpoints Design (To Be Implemented)

### Retriever Management

```
GET    /api/v1/namespaces/{namespace}/retrievers       # List
POST   /api/v1/namespaces/{namespace}/retrievers       # Create
GET    /api/v1/namespaces/{namespace}/retrievers/{name} # Get
PUT    /api/v1/namespaces/{namespace}/retrievers/{name} # Update
DELETE /api/v1/namespaces/{namespace}/retrievers/{name} # Delete
POST   /api/v1/namespaces/{namespace}/retrievers/{name}/test # Test connection
```

### RAG Operations (Updated)

```
POST /api/rag/documents/upload
{
  "knowledge_id": "kb_123",
  "retriever_ref": {
    "name": "my-es-retriever",
    "namespace": "default"
  },
  "file": <binary>,
  "embedding_config": {...}
}

POST /api/rag/retrieve
{
  "knowledge_id": "kb_123",
  "retriever_ref": {
    "name": "my-es-retriever",
    "namespace": "default"
  },
  "query": "...",
  "retrieval_setting": {...},
  "metadata_condition": {...}
}
```

## Migration Plan

### Phase 1: Core Architecture (Completed)
- [x] Retriever CRD schema definition
- [x] Storage backend abstract base class
- [x] Elasticsearch backend implementation
- [x] Qdrant backend placeholder
- [x] Factory function

### Phase 2: Service Layer Integration (Pending)
- [ ] Retriever service adapter (reference public_model.py)
- [ ] Update DocumentService to use Retriever
- [ ] Update RetrievalService to use Retriever
- [ ] Retriever API endpoints

### Phase 3: Data Migration (Pending)
- [ ] Create default Retriever (based on existing RAGSettings)
- [ ] Migrate existing RAG data to new architecture
- [ ] Deprecate RAGSettings global configuration

### Phase 4: Advanced Features (Pending)
- [ ] Complete metadata filtering parser
- [ ] Full Qdrant backend implementation
- [ ] Retrieval performance optimization
- [ ] Monitoring and logging

## Usage Examples

### Create a Retriever

```python
from app.schemas.kind import Retriever, RetrieverSpec, StorageConfig, IndexStrategy

retriever = Retriever(
    metadata=ObjectMeta(
        name="my-retriever",
        namespace="default",
        displayName="My Retriever"
    ),
    spec=RetrieverSpec(
        storageConfig=StorageConfig(
            type="elasticsearch",
            url="http://localhost:9200",
            indexStrategy=IndexStrategy(
                mode="per_dataset",
                prefix="rag"
            )
        ),
        description="Production retriever"
    )
)
```

### Use Retriever for Retrieval

```python
from app.services.rag.storage import create_storage_backend

# Load Retriever CRD from kinds table
retriever_crd = load_retriever("my-retriever", "default")

# Create storage backend
backend = create_storage_backend(retriever_crd.spec.storageConfig.dict())

# Execute retrieval
results = backend.retrieve(
    knowledge_id="kb_123",
    query="What is RAG?",
    embed_model=embed_model,
    retrieval_setting={
        "top_k": 5,
        "score_threshold": 0.7,
        "retrieval_mode": "hybrid"
    }
)
```

## Extensibility

### Adding a New Storage Backend

1. Inherit from `BaseStorageBackend`
2. Implement all abstract methods
3. Register in `factory.py`
4. Update documentation

### Adding a New Index Strategy

1. Add new mode to `IndexStrategy` schema
2. Implement in `get_index_name` for each backend
3. Update documentation

### Adding a New Retrieval Method

1. Define in `RetrievalMethod`
2. Implement in storage backends
3. Update API documentation

## Important Notes

1. **Backward Compatibility**: Existing RAG APIs must remain compatible during gradual migration
2. **Performance Considerations**: Index strategy choice affects query performance
3. **Security**: Sensitive information (password, API keys) must be encrypted in storage
4. **Monitoring**: Need to add retrieval performance and error monitoring
5. **Testing**: Each storage backend requires comprehensive unit and integration tests

## References

- [Dify External Knowledge API](https://docs.dify.ai/guides/knowledge-base/external-knowledge-api-documentation)
- [LlamaIndex Vector Stores](https://docs.llamaindex.ai/en/stable/module_guides/storing/vector_stores/)
- [Elasticsearch Vector Search](https://www.elastic.co/guide/en/elasticsearch/reference/current/knn-search.html)
- [Qdrant Documentation](https://qdrant.tech/documentation/)

## File Structure

```
backend/
├── app/
│   ├── schemas/
│   │   └── kind.py                    # Retriever CRD schema
│   └── services/
│       └── rag/
│           └── storage/
│               ├── __init__.py        # Package exports
│               ├── base.py            # Abstract base class
│               ├── factory.py         # Backend factory
│               ├── elasticsearch_backend.py  # ES implementation
│               └── qdrant_backend.py  # Qdrant implementation
└── docs/
    └── RAG_RETRIEVER_ARCHITECTURE.md  # This document
```

## Next Steps

1. **Create Retriever Service Adapter**: Similar to `public_model.py`, create CRUD operations for Retriever Kind
2. **Update RAG Services**: Refactor `DocumentService` and `RetrievalService` to use Retriever
3. **Implement API Endpoints**: Create RESTful endpoints for Retriever management
4. **Add Tests**: Write unit tests for storage backends and integration tests for the full flow
5. **Create Migration Script**: Script to create default Retriever from existing RAGSettings
6. **Update Frontend**: Add UI for Retriever management in settings page

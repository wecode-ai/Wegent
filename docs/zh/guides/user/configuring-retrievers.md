# 配置检索器（Retriever）用于 RAG

[English](../../en/guides/user/configuring-retrievers.md) | 简体中文

> ⚠️ **实验性功能**：RAG（检索增强生成）功能目前正在积极开发中。API、配置和行为可能在未来版本中发生变化。

## 概述

检索器（Retriever）是 Wegent 中用于 RAG（检索增强生成）功能的存储后端配置。它们定义了如何使用 Elasticsearch 等向量数据库对文档进行索引、存储和检索。

## 前置条件

- 已安装并运行 Wegent 平台
- 已启用 Elasticsearch 服务（可选，仅在使用 RAG 功能时需要）
  ```bash
  docker compose --profile rag up -d
  ```

## 什么是检索器？

检索器是一个 CRD（自定义资源定义），用于配置：
- **存储后端**：向量数据库连接（Elasticsearch、Qdrant）
- **索引策略**：文档在数据库中的组织方式
- **检索方法**：搜索模式（向量、关键词、混合）
- **嵌入配置**：文本如何转换为向量

## 创建检索器

### 通过 Web UI

1. 导航到 **设置** → **检索器**
2. 点击 **添加检索器**
3. 填写配置：
   - **名称**：唯一标识符（例如 `my-es-retriever`）
   - **显示名称**：人类可读的名称
   - **存储类型**：选择 `elasticsearch` 或 `qdrant`
   - **URL**：存储后端 URL（例如 `http://elasticsearch:9200`）
   - **认证**：用户名/密码或 API 密钥（可选）
   - **索引策略**：选择索引模式
   - **检索方法**：启用向量、关键词或混合搜索
4. 点击 **测试连接** 验证设置
5. 点击 **创建** 保存

### 通过 API

```bash
POST /api/retrievers
Content-Type: application/json

{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "Retriever",
  "metadata": {
    "name": "my-es-retriever",
    "namespace": "default",
    "displayName": "我的 Elasticsearch 检索器"
  },
  "spec": {
    "storageConfig": {
      "type": "elasticsearch",
      "url": "http://elasticsearch:9200",
      "username": "elastic",
      "password": "password",
      "indexStrategy": {
        "mode": "per_user",
        "prefix": "wegent"
      }
    },
    "retrievalMethods": {
      "vector": {
        "enabled": true,
        "defaultWeight": 0.7
      },
      "keyword": {
        "enabled": true,
        "defaultWeight": 0.3
      },
      "hybrid": {
        "enabled": true
      }
    },
    "description": "用于 RAG 的 Elasticsearch 检索器"
  }
}
```

## 索引策略

根据您的使用场景选择索引策略：

| 策略 | 描述 | 适用场景 |
|----------|-------------|----------|
| **per_user** | 每个用户一个索引 | Elasticsearch 部署，用户级隔离 |
| **per_dataset** | 每个知识库一个索引 | 多租户场景，数据集隔离 |
| **fixed** | 单个固定索引 | 小型数据集，简单设置 |
| **rolling** | 基于哈希的分片 | 大型数据集，负载分布 |

### 推荐：per_user 模式

对于 Elasticsearch，我们推荐使用 `per_user` 模式：

```json
{
  "indexStrategy": {
    "mode": "per_user",
    "prefix": "wegent"
  }
}
```

这将创建类似 `wegent_user_123` 的索引，提供更好的性能和隔离。

## 检索方法

### 向量搜索（语义）

纯向量相似度搜索，用于语义理解：

```json
{
  "retrieval_mode": "vector",
  "top_k": 5,
  "score_threshold": 0.7
}
```

**使用场景**：概念匹配、理解性问题、语义搜索

### 混合搜索（向量 + 关键词）

结合向量相似度和 BM25 关键词匹配：

```json
{
  "retrieval_mode": "hybrid",
  "hybrid_weights": {
    "vector_weight": 0.7,
    "keyword_weight": 0.3
  },
  "top_k": 5,
  "score_threshold": 0.7
}
```

**权重推荐**：
- **概念性查询** (0.8/0.2)：理解、解释
- **平衡** (0.7/0.3)：通用目的（默认）
- **精确匹配** (0.3/0.7)：代码搜索、API 名称、精确术语

## 使用检索器进行 RAG

### 1. 上传和索引文档

```bash
POST /api/rag/documents/upload
Content-Type: multipart/form-data

- knowledge_id: "kb_001"
- retriever_name: "my-es-retriever"
- retriever_namespace: "default"
- file: <document.pdf>
- embedding_config: {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "api_key": "sk-..."
  }
```

**支持的文件类型**：MD、PDF、TXT、DOCX 和代码文件

### 2. 检索相关片段

```bash
POST /api/rag/retrieve
Content-Type: application/json

{
  "query": "如何配置机器人？",
  "knowledge_id": "kb_001",
  "retriever_ref": {
    "name": "my-es-retriever",
    "namespace": "default"
  },
  "embedding_config": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "api_key": "sk-..."
  },
  "top_k": 5,
  "score_threshold": 0.7,
  "retrieval_mode": "hybrid",
  "hybrid_weights": {
    "vector_weight": 0.7,
    "keyword_weight": 0.3
  }
}
```

### 3. 管理文档

```bash
# 列出文档
GET /api/rag/documents?knowledge_id=kb_001&retriever_name=my-es-retriever&page=1&page_size=20

# 获取文档详情
GET /api/rag/documents/{doc_ref}?knowledge_id=kb_001&retriever_name=my-es-retriever

# 删除文档
DELETE /api/rag/documents/{doc_ref}?knowledge_id=kb_001&retriever_name=my-es-retriever
```

## 嵌入提供商

### OpenAI

```json
{
  "provider": "openai",
  "model": "text-embedding-3-small",
  "api_key": "sk-...",
  "base_url": "https://api.openai.com/v1"  // 可选
}
```

### 自定义 API（OpenAI 兼容）

```json
{
  "provider": "custom",
  "model": "your-model-name",
  "api_key": "your-api-key",
  "base_url": "https://your-api-endpoint.com/v1"
}
```

## 资源范围

检索器支持三种范围：

| 范围 | 描述 | 访问权限 |
|-------|-------------|--------|
| **个人** | 您的私有检索器 | 仅您自己 |
| **组** | 在组内共享 | 组成员 |
| **公共** | 系统提供的检索器 | 所有用户 |

## 最佳实践

### 1. 索引策略选择

- **使用 `per_user`** 用于 Elasticsearch（推荐）
- **使用 `per_dataset`** 用于需要数据集隔离的多租户场景
- **避免 `fixed`** 用于生产环境（仅适用于小型单租户部署）

### 2. 检索模式选择

- **向量模式**：语义理解、概念匹配
- **混合模式**：平衡语义和精确匹配（推荐用于大多数场景）
- **调整权重**：根据查询类型（概念性 vs 精确性）

### 3. 安全性

- 安全存储凭据（使用环境变量或密钥管理）
- 尽可能使用 API 密钥而不是用户名/密码
- 使用命名空间和组限制访问

### 4. 性能

- 根据数据集大小选择适当的索引策略
- 监控存储后端性能
- 使用 `per_user` 模式避免 Elasticsearch 索引爆炸
- 设置适当的 `top_k` 和 `score_threshold` 值

### 5. 文档管理

- 使用有意义的 `knowledge_id` 值进行组织
- 定期清理未使用的文档
- 监控存储使用情况

## 故障排除

### 连接失败

**问题**：无法连接到 Elasticsearch

**解决方案**：
1. 验证 Elasticsearch 正在运行：`docker ps | grep elasticsearch`
2. 检查 URL 是否正确：`http://elasticsearch:9200`（内部）或 `http://localhost:9200`（外部）
3. 测试连接：使用 UI 中的 **测试连接** 按钮
4. 检查凭据：验证用户名/密码或 API 密钥

### 索引失败

**问题**：文档上传失败

**解决方案**：
1. 检查文件格式是否支持（MD、PDF、TXT、DOCX、代码文件）
2. 验证嵌入提供商凭据
3. 检查 Elasticsearch 存储容量
4. 查看后端日志获取详细错误信息

### 检索质量低

**问题**：检索到的片段不相关

**解决方案**：
1. 尝试混合模式而不是纯向量模式
2. 根据查询类型调整混合权重
3. 降低 `score_threshold` 以获取更多结果
4. 使用更好的嵌入模型（例如 `text-embedding-3-large`）
5. 改进文档分块（使用自动语义分块）

## API 参考

完整的 API 文档，请参阅：
- 后端 API 文档：`http://localhost:8000/api/docs`
- AGENTS.md：RAG 服务部分

## 相关文档

- [创建机器人](creating-bots.md)
- [创建智能体](creating-teams.md)
- [管理任务](managing-tasks.md)
- [YAML 规范](../../reference/yaml-specification.md)

## 反馈

由于 RAG 功能是实验性的，我们欢迎您的反馈：
- 在 GitHub 上报告问题
- 提出改进建议
- 分享您的使用案例

---

**注意**：此功能正在积极开发中。请查看 [更新日志](../../../README_zh.md) 获取更新信息。

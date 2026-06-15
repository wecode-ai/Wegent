---
sidebar_position: 2
---

# 知识库开放接口

本文档描述 `/api/knowledge/*` 知识库开放接口，用于外部系统管理知识库文档、目录，并直接发起知识库检索。

如果你希望在 `/api/v1/responses` 中让智能体使用知识库，请参考 [OpenAPI v1/responses API](./openapi-responses-api.md) 中的 `knowledge_base` tool 配置。

## 认证

所有接口都需要通过以下方式之一认证：

- `Authorization: Bearer <access_token>`
- `X-API-Key: <api_key>`

使用服务 API Key 时，需要通过 `wegent-username` 请求头指定目标用户。

## 基础 URL

```text
/api/knowledge
```

## 通用约定

- `knowledge_base_id` 是知识库 ID。
- `document_id` 是知识库文档 ID。
- `folder_id=0` 表示根目录。
- 不传 `folder_id` 表示不按目录过滤。
- `folder_ids=[0]` 表示根目录直接文档，不表示整库。
- 整库检索时不要传 `folder_ids` 或 `document_ids`。
- `folder_ids=[]` 和 `document_ids=[]` 是非法参数。

## 知识库列表

### 列出可访问知识库

```http
GET /api/knowledge/list
```

查询参数：

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `scope` | string | 否 | `personal` 仅返回个人可访问知识库；`all` 返回个人、群组、组织可访问知识库。默认 `all` |

响应：

```json
{
  "total": 1,
  "items": [
    {
      "id": 1,
      "name": "产品知识库",
      "namespace": "default",
      "document_count": 12
    }
  ]
}
```

## 文档管理

### 列出文档

```http
GET /api/knowledge/documents
```

查询参数：

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `knowledge_base_id` | integer | 是 | 知识库 ID |
| `folder_id` | integer | 否 | 目录过滤。`0` 表示根目录直接文档；不传表示全部文档；大于 `0` 时只返回该目录直接文档，不递归 |

响应：

```json
{
  "total": 1,
  "items": [
    {
      "id": 101,
      "kind_id": 1,
      "name": "设计方案.md",
      "file_extension": "md",
      "status": "enabled",
      "index_status": "success",
      "folder_id": 0
    }
  ]
}
```

### 读取文档内容

```http
GET /api/knowledge/documents/{document_id}/content
```

查询参数：

| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `offset` | integer | 否 | 起始字符偏移，默认 `0` |
| `limit` | integer | 否 | 返回字符数上限，默认和最大值均由服务端限制 |

响应：

```json
{
  "document_id": 101,
  "name": "设计方案.md",
  "content": "文档内容片段",
  "total_length": 12000,
  "offset": 0,
  "returned_length": 2000,
  "has_more": true,
  "kb_id": 1,
  "index_status": "success"
}
```

### 创建文档

```http
POST /api/knowledge/documents
```

请求体字段：

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `knowledge_base_id` | integer | 是 | 目标知识库 ID |
| `name` | string | 是 | 文档名称 |
| `source_type` | string | 否 | `text`、`file`、`web`、`attachment`，默认 `text` |
| `content` | string | 条件必填 | `source_type=text` 时的文本内容 |
| `file_base64` | string | 条件必填 | `source_type=file` 时的 Base64 文件内容，解码后最大 10 MB |
| `file_extension` | string | 条件必填 | 文件扩展名，不带点。`source_type=file` 时必填，`text` 时可选 |
| `url` | string | 条件必填 | `source_type=web` 时的网页 URL |
| `attachment_id` | integer | 条件必填 | `source_type=attachment` 时的附件 ID |
| `folder_id` | integer | 否 | 目标目录 ID，`0` 表示根目录，默认 `0` |
| `splitter_config` | object | 否 | 自定义分块配置 |

文本示例：

```json
{
  "knowledge_base_id": 1,
  "name": "设计方案.md",
  "source_type": "text",
  "content": "# 设计方案\n\n正文",
  "file_extension": "md",
  "folder_id": 0
}
```

网页示例：

```json
{
  "knowledge_base_id": 1,
  "name": "官网文档",
  "source_type": "web",
  "url": "https://example.com/docs",
  "folder_id": 10
}
```

### 更新文档元数据

```http
PUT /api/knowledge/documents/{document_id}
```

请求体字段：

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `name` | string | 否 | 新文档名称 |
| `status` | string | 否 | `enabled` 或 `disabled` |
| `splitter_config` | object | 否 | 分块配置 |

该接口只更新文档元数据，不会更新文档文本内容。

### 更新文档内容

```http
PUT /api/knowledge/documents/{document_id}/content
```

请求体：

```json
{
  "content": "新的 Markdown 内容"
}
```

仅支持文本类文档和纯文本文件文档。更新后会触发重新索引。

### 移动文档

```http
PUT /api/knowledge/documents/{document_id}/move
```

请求体：

```json
{
  "folder_id": 10
}
```

`folder_id=0` 表示移动到根目录。

## 目录管理

目录是知识库文档属性，不是附件属性；通用附件上传接口不会接收 `folder_id`。

### 获取目录树

```http
GET /api/knowledge/folders?knowledge_base_id=1
```

响应包含完整目录树，包括空目录：

```json
[
  {
    "id": 10,
    "kind_id": 1,
    "parent_id": 0,
    "name": "产品",
    "document_count": 3,
    "children": []
  }
]
```

### 创建目录

```http
POST /api/knowledge/folders
```

请求体：

```json
{
  "knowledge_base_id": 1,
  "name": "产品",
  "parent_id": 0
}
```

### 更新目录

```http
PUT /api/knowledge/folders/{folder_id}
```

请求体：

```json
{
  "knowledge_base_id": 1,
  "name": "产品资料",
  "parent_id": 0
}
```

`name` 和 `parent_id` 都是可选字段，但请求体必须包含 `knowledge_base_id` 用于归属校验。

### 删除目录

```http
DELETE /api/knowledge/folders/{folder_id}?knowledge_base_id=1
```

删除目录及其子目录，目录下文档会移动到根目录。

## 知识库检索

### 检索文档片段

```http
POST /api/knowledge/search
```

请求体字段：

| 字段 | 类型 | 必填 | 描述 |
|------|------|------|------|
| `knowledge_base_id` | integer | 是 | 知识库 ID |
| `query` | string | 是 | 检索问题，最大 2000 字符 |
| `top_k` | integer | 否 | 返回结果数量，默认 `5`，范围 `1` 到 `100` |
| `score_threshold` | number | 否 | 最低相似度分数，默认 `0.7` |
| `route_mode` | string | 否 | `auto`、`direct_injection` 或 `rag_retrieval`，默认 `auto` |
| `folder_ids` | integer[] | 否 | 限定目录范围。`[0]` 表示根目录直接文档 |
| `document_ids` | integer[] | 否 | 限定指定文档 |
| `include_subfolders` | boolean | 否 | `folder_ids` 是否包含子目录，默认 `true` |
| `context_window` | integer | 否 | 直接注入模式的上下文窗口大小 |
| `used_context_tokens` | integer | 否 | 已使用上下文 token 数 |
| `reserved_output_tokens` | integer | 否 | 预留输出 token 数 |
| `context_buffer_ratio` | number | 否 | 上下文安全缓冲比例 |
| `max_direct_chunks` | integer | 否 | 直接注入最多片段数 |

整库检索：

```json
{
  "knowledge_base_id": 1,
  "query": "范围过滤方案",
  "top_k": 5
}
```

目录范围检索：

```json
{
  "knowledge_base_id": 1,
  "query": "范围过滤方案",
  "folder_ids": [10],
  "include_subfolders": true,
  "top_k": 5
}
```

指定文档检索：

```json
{
  "knowledge_base_id": 1,
  "query": "范围过滤方案",
  "document_ids": [101, 102]
}
```

范围规则：

- 整库搜索：不要传 `folder_ids` 或 `document_ids`。
- 根目录搜索：传 `folder_ids: [0]`。
- 子目录搜索：传 `folder_ids: [10]`，并用 `include_subfolders` 控制是否包含子目录。
- `folder_ids` 与 `document_ids` 同时传时，范围取并集。
- `folder_ids=[]` 或 `document_ids=[]` 是非法参数。
- 指定范围内没有文档时返回空结果，不会退化为整库搜索。

响应：

```json
{
  "records": [
    {
      "content": "命中的片段内容",
      "score": 0.86,
      "title": "设计方案.md"
    }
  ]
}
```

## 错误码

| 状态码 | 含义 |
|--------|------|
| `400` | 参数语义错误，例如目录不属于该知识库、检索配置不完整 |
| `403` | 当前用户无权访问目标知识库、目录或文档 |
| `404` | 知识库、目录或文档不存在 |
| `422` | 请求体字段校验失败，例如空数组、缺少条件必填字段、字段范围非法 |
| `502` | 上游网页抓取或 RAG 网关错误 |

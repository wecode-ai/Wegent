# 外部数据导入

本指南说明如何将外部服务收集的内容（例如微博 `@` 提及）导入到 Wegent 的知识库中。

## 功能概述

外部导入接口接收纯文本内容，保存为附件并创建知识库文档。如果知识库配置了检索能力，会自动安排索引任务。

## 身份认证

请在请求头中使用 API Key：

- `X-API-Key: wg-...`
- `Authorization: Bearer wg-...`

如果使用服务密钥并需要指定用户，可提供 `wegent-username`，或使用 `api_key#username` 格式。

## 接口地址

`POST /api/knowledge-bases/{knowledge_base_id}/external-imports`

## 请求体示例

```json
{
  "title": "微博收藏",
  "content": "Hello Wegent external import.",
  "source": "weibo",
  "source_url": "https://weibo.com/example",
  "external_id": "weibo-123",
  "author": "alice",
  "tags": ["social", "clip"],
  "metadata": { "channel": "mentions" }
}
```

## 调用示例

```bash
curl -X POST "http://localhost:8000/api/knowledge-bases/42/external-imports" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: wg-your-key" \
  -d '{
    "title": "微博收藏",
    "content": "Hello Wegent external import.",
    "source": "weibo",
    "source_url": "https://weibo.com/example",
    "external_id": "weibo-123",
    "author": "alice",
    "tags": ["social", "clip"],
    "metadata": { "channel": "mentions" }
  }'
```

## 响应字段说明

- `knowledge_base_id`: 目标知识库 ID。
- `attachment_id`: 内容对应的附件记录 ID。
- `index_scheduled`: 是否已安排索引。
- `truncation_info`: 如果内容被截断，会包含截断信息。
- `document`: 新建的知识库文档信息。

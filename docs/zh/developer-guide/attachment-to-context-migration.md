# Attachment to Context Migration

## 概述

从 `subtask_attachments` 表迁移到统一的 `subtask_contexts` 表，以支持多种上下文类型（附件、知识库等）。

## 架构变更

### 旧架构（已废弃）

```
subtask_attachments 表
├── id
├── subtask_id
├── user_id
├── original_filename
├── file_extension
├── file_size
├── mime_type
├── binary_data
├── storage_key
├── storage_backend
├── image_base64
├── extracted_text
├── text_length
├── status
├── error_message
├── created_at
└── updated_at
```

### 新架构（当前）

```
subtask_contexts 表
├── id
├── subtask_id
├── user_id
├── context_type          # 'attachment' | 'knowledge_base' | ...
├── name                  # 统一的名称字段
├── status                # 'pending' | 'uploading' | 'parsing' | 'ready' | 'failed'
├── error_message
├── binary_data           # 二进制数据（MySQL 存储）
├── image_base64          # Base64 编码的图片
├── extracted_text        # 提取的文本内容
├── text_length           # 文本长度
├── type_data             # JSON 字段，存储类型特定数据
├── created_at
└── updated_at
```

## 数据迁移

### type_data 字段映射

对于 `context_type = 'attachment'`，`type_data` JSON 包含：

```json
{
  "original_filename": "example.pdf",
  "file_extension": ".pdf",
  "file_size": 1024000,
  "mime_type": "application/pdf",
  "storage_key": "s3://bucket/key",
  "storage_backend": "mysql" | "s3" | "minio"
}
```

对于 `context_type = 'knowledge_base'`，`type_data` JSON 包含：

```json
{
  "document_count": 42
}
```

**注意**：知识库的 `retriever_name` 和 `retriever_namespace` 等信息存储在知识库表中，不在 `type_data` 中。`SubtaskContextBrief` 只包含用于显示的 `document_count` 字段。

### 迁移脚本

数据库迁移由 Alembic 自动处理：

```bash
# 升级到新架构
alembic upgrade head

# 回滚到旧架构（如需要）
alembic downgrade -1
```

迁移文件：`backend/alembic/versions/o5p6q7r8s9t0_add_subtask_contexts_table.py`

## 代码变更

### 后端

#### 模型层

- **新增**: `app/models/subtask_context.py` - `SubtaskContext` 模型
- **更新**: `app/models/subtask.py` - 关系从 `attachments` 改为 `contexts`

#### Schema 层

- **新增**: `app/schemas/subtask_context.py` - 统一的上下文 schema
  - `SubtaskContextBrief` - 消息列表显示的简要信息
  - `SubtaskContextResponse` - 完整上下文响应
  - `AttachmentResponse` - 附件响应（向后兼容）
- **更新**: `app/schemas/subtask.py`
  - `SubtaskAttachment` 标记为 deprecated
  - 新增 `contexts: List[SubtaskContextBrief]` 字段
  - 保留 `attachments` 字段用于向后兼容

#### 服务层

- **新增**: `app/services/context/context_service.py` - 统一的上下文服务
  - 处理所有上下文类型（附件、知识库等）
  - 支持多种存储后端（MySQL、S3、MinIO）
- **重构**: `app/services/attachment/` - 附件服务现在使用 `SubtaskContext`
  - `attachment_service.py` - 附件上传、解析
  - `parser.py` - 文件解析（PDF、Word、图片等）
  - `mysql_storage.py` - MySQL 存储后端
  - `s3_storage.py` - S3/MinIO 存储后端

#### API 层

- **保持兼容**: `/api/attachments/*` 端点继续工作
- **新增**: `/api/contexts/*` 端点（未来扩展）

### 前端

#### 类型定义

- **更新**: `frontend/src/types/api.ts`
  - `Attachment` 类型保留（向后兼容）
  - 新增 `SubtaskContextBrief` 类型
  - `Subtask` 接口新增 `contexts` 字段
- **新增**: `frontend/src/types/context.ts`
  - `ContextItem` - 输入框中的上下文项
  - `KnowledgeBaseContext` - 知识库上下文类型

#### 组件层

- **更新**: `MessageBubble.tsx`
  - `Message` 接口中 `attachments` 标记为 `@deprecated`
  - 新增 `contexts?: SubtaskContextBrief[]` 字段
  - 删除未使用的 `renderAttachments` 函数
  - 使用 `ContextBadgeList` 组件显示上下文

- **新增**: `ContextBadgeList.tsx` - 统一显示所有上下文类型
  - 支持 `attachment` 和 `knowledge_base` 类型
  - 使用 `ContextPreviewBase` 提供一致的样式
  - **i18n 支持**: 使用 `formatDocumentCount` 工具函数处理文档数量的单复数显示

- **新增**: `ContextBadge.tsx` - 输入框中的上下文 badge
  - 显示已选择的知识库
  - **i18n 支持**: 文档数量支持中英文单复数

- **新增**: `ContextSelector.tsx` - 知识库选择器
  - 下拉列表选择知识库
  - **i18n 支持**: 文档数量显示支持单复数

- **新增**: `ChatContextInput.tsx` - 统一的上下文输入组件
  - 支持选择知识库等上下文

- **保留**: `AttachmentPreview.tsx` - 附件预览组件（仍在使用）

#### 工具函数

- **新增**: `frontend/src/lib/i18n-helpers.ts`
  - `formatDocumentCount()` - 格式化文档数量，支持单复数
  - 统一处理中英文的文档数量显示

#### 国际化

- **更新**: `frontend/src/i18n/locales/*/knowledge.json`
  - 新增 `document_count` - 单数形式（"1 document" / "1 篇文档"）
  - 新增 `documents_count` - 复数形式（"5 documents" / "5 篇文档"）

## 向后兼容性

### API 兼容性

✅ **完全兼容** - 所有现有的附件 API 端点继续工作：
- `POST /api/attachments/upload`
- `GET /api/attachments/{id}`
- `GET /api/attachments/{id}/download`
- `GET /api/attachments/{id}/preview`

### 数据兼容性

✅ **自动迁移** - 现有的 `subtask_attachments` 数据自动迁移到 `subtask_contexts`

### 代码兼容性

✅ **渐进式迁移** - 前端代码可以同时使用：
- `msg.attachments` - 旧字段（deprecated，但仍可用）
- `msg.contexts` - 新字段（推荐使用）

## 存储后端配置

### 环境变量

```bash
# 附件存储配置（可选）
# 默认: mysql（将文件存储在数据库中）
# 选项: mysql, s3, minio
ATTACHMENT_STORAGE_BACKEND=mysql

# S3/MinIO 配置（仅在使用 s3 或 minio 后端时需要）
ATTACHMENT_S3_ENDPOINT=https://s3.amazonaws.com  # 或 http://minio:9000
ATTACHMENT_S3_ACCESS_KEY=your_access_key
ATTACHMENT_S3_SECRET_KEY=your_secret_key
ATTACHMENT_S3_BUCKET=attachments
ATTACHMENT_S3_REGION=us-east-1
ATTACHMENT_S3_USE_SSL=true
```

### 存储后端选择

| 后端 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **MySQL** | 简单、无需额外配置 | 数据库体积增大 | 小规模部署、测试环境 |
| **S3** | 可扩展、成本低 | 需要 AWS 账号 | 生产环境、大规模部署 |
| **MinIO** | 自托管、S3 兼容 | 需要额外服务 | 私有云、企业部署 |

## 功能扩展

### 支持的上下文类型

当前支持：
- ✅ `attachment` - 文件附件（PDF、Word、图片等）
- ✅ `knowledge_base` - 知识库引用

未来计划：
- 🔄 `code_snippet` - 代码片段
- 🔄 `api_response` - API 响应数据

### 扩展新上下文类型

1. 在 `app/models/subtask_context.py` 中添加新的 `ContextType` 枚举值
2. 在 `app/services/context/context_service.py` 中实现处理逻辑
3. 在前端 `types/api.ts` 和 `types/context.ts` 中添加类型定义
4. 在 `ContextBadgeList.tsx` 中添加显示逻辑
5. 如需要，在 `i18n/locales/*/` 中添加翻译

## 国际化最佳实践

### 文档数量显示

使用统一的 `formatDocumentCount` 工具函数：

```typescript
import { formatDocumentCount } from '@/lib/i18n-helpers';
import { useTranslation } from '@/hooks/useTranslation';

function MyComponent() {
  const { t } = useTranslation('knowledge');
  const count = 5;
  
  // 自动处理单复数
  // 英文: "5 documents"
  // 中文: "5 篇文档"
  const text = formatDocumentCount(count, t);
}
```

### 添加新的 i18n 辅助函数

在 `frontend/src/lib/i18n-helpers.ts` 中添加新的通用函数，确保：
1. 函数名清晰描述用途
2. 添加 JSDoc 注释和使用示例
3. 支持 TypeScript 类型检查
4. 在多个组件中复用

## 测试

### 后端测试

```bash
cd backend
pytest tests/test_context_service.py
pytest tests/test_attachment_service.py
```

### 前端测试

```bash
cd frontend
npm test -- MessageBubble.test.tsx
npm test -- ContextBadgeList.test.tsx
```

## 故障排查

### 问题：附件无法显示

**原因**: 前端仍在使用 `msg.attachments` 而不是 `msg.contexts`

**解决方案**: 更新组件使用 `msg.contexts` 字段

### 问题：迁移后附件丢失

**原因**: 迁移脚本未正确执行

**解决方案**:
```bash
# 检查迁移状态
alembic current

# 重新运行迁移
alembic upgrade head
```

### 问题：S3 存储无法访问

**原因**: 环境变量配置错误

**解决方案**: 检查 `.env` 文件中的 S3 配置

### 问题：知识库文档数量显示不正确

**原因**: 未使用 `formatDocumentCount` 函数或翻译键缺失

**解决方案**:
1. 确保使用 `formatDocumentCount(count, t)` 函数
2. 检查 `knowledge.json` 中是否有 `document_count` 和 `documents_count` 键
3. 确保 `useTranslation('knowledge')` 使用正确的命名空间

## 相关文档

- [任务分享功能](../../../TASK_SHARING_FEATURE.md) - 包含附件复制逻辑
- [安装指南](../../getting-started/installation.md) - 存储后端配置
- [AGENTS.md](../../../../AGENTS.md) - 项目架构概述

## 变更历史

- **2025-12-29**: 初始迁移 - 从 `subtask_attachments` 到 `subtask_contexts`
- **2025-12-30**: 添加 i18n 支持 - 知识库文档数量支持单复数显示

---

**维护者**: Wegent Team  
**最后更新**: 2025-12-30

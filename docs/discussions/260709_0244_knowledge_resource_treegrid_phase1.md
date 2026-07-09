---
sidebar_position: 1
---

# 知识库资源 TreeGrid 一期落地说明

## 背景

知识库文档区已经从平铺文件列表演进为资源管理器：同一视图内同时存在文件夹、文档、搜索、排序、上传、移动、删除、转移、重命名和批量选择。继续把表格布局、递归树、选择状态和业务操作写在同一个组件里，会让分页、搜索、文件夹 scope 和批量操作的边界越来越不清晰。

一期目标是先把稳定的业务模型落地：资源树、可见行、选择 payload、桌面 TreeGrid 渲染。TanStack Table 和 TanStack Virtual 作为 headless 能力接入，但不接管业务语义。

## 一期架构

```text
DocumentList
  ├─ useDocuments / useFolders
  ├─ buildKnowledgeResourceTree
  ├─ useKnowledgeResourceSelection
  └─ KnowledgeDocumentTreeGrid
       ├─ TanStack Table row/column model
       ├─ TanStack Virtual fixed-height visible rows
       └─ DocumentItem / folder row rendering
```

## 语义决策

### 文件夹是 scope，不是当前页文档集合

分页和搜索开启时，前端拿到的 `documents` 只是当前查询结果，不等于某个文件夹下的完整文档集合。因此文件夹选择不能展开成当前页文档 ID。一期保留 `folderIds + documentIds` payload：

- `documentIds` 表示用户显式选择的文档。
- `folderIds` 表示后端可解析的完整文件夹 scope。
- 文件夹 scope 下的文档 checkbox 显示为已覆盖，避免重复选择。

### 文件夹 scope 一期只支持转移

删除和移动的现有 API 以文档 ID 为主。如果把文件夹 scope 直接套到删除或移动上，会产生“用户看到当前页，实际操作整个文件夹”的风险。一期规则：

- 转移：支持 `folderIds + documentIds`。
- 移动：仅支持显式文档选择。
- 删除：仅支持显式文档选择。

### 取消后代文档时解除祖先文件夹 scope

更完整的模型可以引入 `excludedDocumentIds`，表达“选择整个文件夹但排除某几个文档”。一期不引入这个复杂度。用户取消某个后代文档时，解除相关祖先文件夹 scope，避免 payload 再通过 `folderIds` 把该文档重新包含回来。

### 虚拟滚动固定行高起步

TreeGrid 先按固定行高接入 TanStack Virtual。当前文档行和文件夹行都保持单行展示，名称溢出用 tooltip。后续如果引入多行状态、复杂错误提示或动态高度，再单独引入测量逻辑。

## 后续问题

- 是否需要支持“选择当前搜索结果全集”，而不是只选择当前页。
- 是否需要支持 `folderIds + excludedDocumentIds`。
- 是否需要让移动、删除也支持文件夹 scope，并由后端提供明确的确认和预估数量。
- 是否需要把 compact/mobile 路径也迁移到同一个 TreeGrid 渲染层；一期只保证它复用同一选择模型。

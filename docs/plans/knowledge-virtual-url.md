---
sidebar_position: 3
---

# 知识库 URL 虚拟路径化重构方案

## 背景

当前知识库页面 URL 使用 `/knowledge/document/{kbId}` 格式，其中 `kbId` 是数据库内部自增 ID。这种格式存在以下问题：

1. **不可读**：URL 中的数字 ID 对用户没有语义
2. **跨环境不稳定**：开发/生产环境的 kbId 可能不同，链接无法跨环境使用
3. **LLM 生成的索引链接无法正确解析**：LLM 在 wiki 知识库中生成的文档间链接（如 `src/rag.md`）无法被前端正确路由

## 目标

将所有知识库 URL 改为虚拟路径格式：

```
/knowledge/{namespace}/{kbName}                    → KB 主页
/knowledge/{namespace}/{kbName}/{docPath}           → 打开特定文档（通过 ?doc= 参数）
```

示例：
- 旧：`/knowledge/document/42`
- 新：`/knowledge/default/ai-research-wiki`
- 新（带文档）：`/knowledge/personal/my-notes/src/rag.md`

## 影响范围

### 需要修改的文件

| 文件 | 当前用法 | 改造方式 |
|------|---------|---------|
| [`KnowledgeDocumentPageMobile.tsx`](../../frontend/src/features/knowledge/document/components/KnowledgeDocumentPageMobile.tsx) | `router.push('/knowledge/document/${kb.id}')` | 改为 `/knowledge/${kb.namespace}/${kb.name}`，kb 对象已有 namespace/name |
| [`KnowledgeBaseChatPageDesktop.tsx`](../../frontend/src/app/(tasks)/knowledge/document/[knowledgeBaseId]/KnowledgeBaseChatPageDesktop.tsx) | `window.location.href = '/knowledge/document/${knowledgeBaseId}'` | 改为新格式，knowledgeBase 对象已有 namespace/name |
| [`DocumentDetailDialog.tsx`](../../frontend/src/features/knowledge/document/components/DocumentDetailDialog.tsx) | `resolveWikiLink()` 内部生成 `/knowledge/document/${kbId}` | 改为 `/knowledge/${namespace}/${kbName}?doc=${docPath}` |
| [`app/shared/knowledge/page.tsx`](../../frontend/src/app/shared/knowledge/page.tsx) | `router.push('/knowledge/document/${kbData.id}')` | 改为新格式，kbData 有 namespace/name |

### 保留旧路由（兼容层）的文件

以下文件只有 `kbId`，没有 namespace/name，通过旧路由重定向兼容：

| 文件 | 原因 |
|------|------|
| [`TaskListSection.tsx`](../../frontend/src/features/tasks/components/sidebar/TaskListSection.tsx) | `task.knowledge_base_id` 只有 ID，无 namespace/name |
| [`useChatStreamHandlers.tsx`](../../frontend/src/features/tasks/components/chat/useChatStreamHandlers.tsx) | `knowledgeBaseId` 只有 ID |

## 架构设计

```
新路由 /knowledge/[namespace]/[kbName]/[...docPath]
  └── 查找 KB（listKnowledgeBases by namespace+name）
  └── 渲染 KB 页面组件（传入 kbId prop）
  └── 如有 docPath，自动打开对应文档

旧路由 /knowledge/document/[knowledgeBaseId]（兼容层）
  └── 获取 KB 详情（getKnowledgeBase by id）
  └── router.replace 到新格式 URL
  └── 保留 ?taskId= 等查询参数
```

## 实施步骤

### 步骤 1：重构 4 个 KB 页面组件，接受 `knowledgeBaseId` prop

**目标文件**：
- [`KnowledgeBaseChatPageDesktop.tsx`](../../frontend/src/app/(tasks)/knowledge/document/[knowledgeBaseId]/KnowledgeBaseChatPageDesktop.tsx)
- [`KnowledgeBaseChatPageMobile.tsx`](../../frontend/src/app/(tasks)/knowledge/document/[knowledgeBaseId]/KnowledgeBaseChatPageMobile.tsx)
- [`KnowledgeBaseClassicPageDesktop.tsx`](../../frontend/src/app/(tasks)/knowledge/document/[knowledgeBaseId]/KnowledgeBaseClassicPageDesktop.tsx)
- [`KnowledgeBaseClassicPageMobile.tsx`](../../frontend/src/app/(tasks)/knowledge/document/[knowledgeBaseId]/KnowledgeBaseClassicPageMobile.tsx)

**改动**：将 `useParams()` 读取 `knowledgeBaseId` 改为接受 prop：

```tsx
// 改前
export function KnowledgeBaseChatPageDesktop() {
  const params = useParams()
  const knowledgeBaseId = params.knowledgeBaseId
    ? parseInt(params.knowledgeBaseId as string, 10)
    : null
  // ...
}

// 改后
interface Props {
  knowledgeBaseId: number
  initialDocPath?: string  // 新增：初始打开的文档路径
}

export function KnowledgeBaseChatPageDesktop({ knowledgeBaseId, initialDocPath }: Props) {
  // 直接使用 prop，不再读取 useParams()
  // ...
}
```

同时，`KnowledgeBaseChatPageDesktop.handleNewTask` 中的硬编码 URL 也需要更新：

```tsx
// 改前
window.location.href = `/knowledge/document/${knowledgeBaseId}`

// 改后（knowledgeBase 对象已加载）
window.location.href = `/knowledge/${knowledgeBase.namespace}/${knowledgeBase.name}`
```

### 步骤 2：实现新路由页面

**文件**：[`/knowledge/[namespace]/[kbName]/[...docPath]/page.tsx`](../../frontend/src/app/(tasks)/knowledge/[namespace]/[kbName]/[...docPath]/page.tsx)

```tsx
'use client'

export default function KnowledgeVirtualPage() {
  const params = useParams()
  const namespace = decodeURIComponent(params.namespace as string)
  const kbName = decodeURIComponent(params.kbName as string)
  const docPath = params.docPath
    ? (params.docPath as string[]).map(decodeURIComponent).join('/')
    : undefined

  // 1. 查找 KB
  const [kbId, setKbId] = useState<number | null>(null)
  useEffect(() => {
    listKnowledgeBases('all').then(res => {
      const kb = res.items.find(
        item =>
          item.name.toLowerCase() === kbName.toLowerCase() &&
          item.namespace.toLowerCase() === namespace.toLowerCase()
      )
      setKbId(kb?.id ?? null)
    })
  }, [namespace, kbName])

  // 2. 加载 KB 详情，判断类型
  const { knowledgeBase, loading } = useKnowledgeBaseDetail({
    knowledgeBaseId: kbId || 0,
    autoLoad: !!kbId,
  })

  // 3. 渲染对应组件，传入 kbId prop 和 initialDocPath
  if (knowledgeBase?.kb_type === 'classic') {
    return isMobile
      ? <KnowledgeBaseClassicPageMobile knowledgeBaseId={kbId} initialDocPath={docPath} />
      : <KnowledgeBaseClassicPageDesktop knowledgeBaseId={kbId} initialDocPath={docPath} />
  }
  return isMobile
    ? <KnowledgeBaseChatPageMobile knowledgeBaseId={kbId} initialDocPath={docPath} />
    : <KnowledgeBaseChatPageDesktop knowledgeBaseId={kbId} initialDocPath={docPath} />
}
```

**`initialDocPath` 处理**：在 `DocumentList` 或 `DocumentPanel` 中，当 `initialDocPath` 存在时，自动查找并打开对应文档（复用现有的 `DocAutoOpener` 逻辑，或通过 `?doc=` URL 参数传递）。

> 注意：`initialDocPath` 最简单的实现方式是将其转换为 `?doc=` 查询参数，这样可以复用 `DocAutoOpener` 组件的现有逻辑，无需修改 `DocumentList`。

### 步骤 3：旧路由改为兼容重定向层

**文件**：[`/knowledge/document/[knowledgeBaseId]/page.tsx`](../../frontend/src/app/(tasks)/knowledge/document/[knowledgeBaseId]/page.tsx)

```tsx
'use client'

export default function KnowledgeBaseCompatPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()

  const knowledgeBaseId = parseInt(params.knowledgeBaseId as string, 10)
  const { knowledgeBase, loading } = useKnowledgeBaseDetail({
    knowledgeBaseId,
    autoLoad: true,
  })

  useEffect(() => {
    if (!knowledgeBase) return
    // Build new virtual URL
    const newPath = `/knowledge/${knowledgeBase.namespace}/${knowledgeBase.name}`
    // Preserve query params (taskId, doc, etc.)
    const query = searchParams.toString()
    router.replace(query ? `${newPath}?${query}` : newPath)
  }, [knowledgeBase, router, searchParams])

  // Show loading while redirecting
  return <PageLoadingFallback />
}
```

### 步骤 4：更新有 KB 对象可用的导航代码

**`KnowledgeDocumentPageMobile.tsx`**：
```tsx
// 改前
router.push(`/knowledge/document/${kb.id}`)

// 改后
router.push(`/knowledge/${kb.namespace}/${kb.name}`)
```

**`app/shared/knowledge/page.tsx`**（3 处）：
```tsx
// 改前
router.push(`/knowledge/document/${kbData.id}`)

// 改后
router.push(`/knowledge/${kbData.namespace}/${kbData.name}`)
```

### 步骤 5：更新 DocumentDetailDialog 中的链接生成

**`resolveWikiLink()` 函数**：将内部导航 URL 从 `/knowledge/document/{kbId}?doc={path}` 改为 `/knowledge/{namespace}/{kbName}?doc={path}`：

```tsx
// 改前
const base = `/knowledge/document/${currentKbId}`
return docPath ? `${base}?doc=${encodeURIComponent(docPath)}` : base

// 改后
const base = `/knowledge/${currentNamespace}/${currentKbName}`
return docPath ? `${base}?doc=${encodeURIComponent(docPath)}` : base
```

对于跨 KB 链接，`findKnowledgeBaseIdByNameAndNamespace` 已经有 namespace/name，直接构造新格式 URL，无需查找 kbId：

```tsx
// 改前
const kbId = await findKnowledgeBaseIdByNameAndNamespace(targetKbName, targetNamespace)
if (kbId === null) return null
const base = `/knowledge/document/${kbId}`

// 改后（无需 API 调用，直接构造 URL）
// 先验证 KB 是否存在（可选，保持现有行为）
const exists = await checkKnowledgeBaseExists(targetKbName, targetNamespace)
if (!exists) return null
const base = `/knowledge/${targetNamespace}/${targetKbName}`
```

> 优化：跨 KB 链接不再需要查找 kbId，可以直接构造 URL，减少一次 API 调用。但需要保留存在性验证（避免导航到不存在的 KB）。

## 路由冲突分析

新路由 `/knowledge/[namespace]/[kbName]` 与现有路由的冲突检查：

| 现有路由 | 是否冲突 |
|---------|---------|
| `/knowledge` | 无冲突（精确匹配） |
| `/knowledge/[projectId]` | **有冲突**：`[projectId]` 是数字，`[namespace]` 是字符串，Next.js 无法区分 |
| `/knowledge/document/[knowledgeBaseId]` | 无冲突：`document` 是固定段 |
| `/knowledge/share/[id]` | 无冲突：`share` 是固定段 |

**`/knowledge/[projectId]` 冲突解决**：

查看 [`/knowledge/[projectId]/page.tsx`](../../frontend/src/app/(tasks)/knowledge/[projectId]/page.tsx) 的用途：

```tsx
// 用于代码项目关联知识库的导航
const navigateToKnowledgeDetail = (projectId: number) => {
  router.push(`/knowledge/${projectId}?from=code`)
}
```

这个路由使用数字 projectId，与新路由的字符串 namespace 冲突。解决方案：

**方案 A**：将 `[projectId]` 路由移到 `/knowledge/project/[projectId]`（推荐，语义更清晰）

**方案 B**：在新路由中检测第一段是否为纯数字，如果是则按旧 projectId 逻辑处理

推荐方案 A，同时更新 [`/knowledge/page.tsx`](../../frontend/src/app/(tasks)/knowledge/page.tsx) 中的导航代码。

## 新路由目录结构

```
app/(tasks)/knowledge/
├── page.tsx                              # KB 列表页（不变）
├── [namespace]/
│   └── [kbName]/
│       ├── page.tsx                      # KB 主页（新）
│       └── [...docPath]/
│           └── page.tsx                  # 带文档路径（新，合并到上面或单独）
├── document/
│   └── [knowledgeBaseId]/
│       └── page.tsx                      # 兼容重定向层（改）
├── project/
│   └── [projectId]/
│       └── page.tsx                      # 项目关联 KB（从 [projectId] 移过来）
└── share/
    └── [id]/
        └── page.tsx                      # 分享链接（不变）
```

> 注意：`[namespace]/[kbName]/page.tsx` 和 `[namespace]/[kbName]/[...docPath]/page.tsx` 可以合并为一个路由，通过 `[...docPath]` 的可选性（`[[...docPath]]`）实现。

## 实施顺序建议

1. **先解决路由冲突**：将 `[projectId]` 移到 `project/[projectId]`
2. **重构页面组件**：添加 prop 支持，保持向后兼容（旧路由仍可用）
3. **实现新路由**：新路由页面
4. **旧路由改重定向**：确保所有旧链接自动跳转
5. **更新导航代码**：有 KB 对象的地方直接用新格式
6. **更新 DocumentDetailDialog**：内部链接改为新格式

## 注意事项

- **URL 编码**：namespace 和 kbName 可能包含中文（如 `AI资讯`），需要 `encodeURIComponent`，路由解析时需要 `decodeURIComponent`
- **大小写**：KB 名称匹配时使用 `toLowerCase()` 进行不区分大小写比较
- **`?doc=` 参数**：文档路径通过查询参数传递，`DocAutoOpener` 组件已支持此机制
- **`?taskId=` 参数**：旧路由重定向时需保留此参数，确保任务上下文不丢失

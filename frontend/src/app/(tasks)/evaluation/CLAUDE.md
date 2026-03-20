# Evaluation Pages Development Guide

## 开发经验总结

### 1. 页面路由结构

```
evaluation/
├── author/                  # 出题人页面
│   └── topics/
│       └── [id]/
│           ├── page.tsx           # 专题详情页
│           ├── questions/         # 题目管理
│           ├── exam-sessions/     # 考试会话
│           └── grading-config/    # 评分配置
├── grader/                  # 评分人页面
│   ├── page.tsx                   # 评分任务列表
│   ├── answers/
│   │   └── [id]/
│   │       └── page.tsx           # 评分详情页
│   └── topics/
│       └── [id]/
│           └── page.tsx           # 专题评分任务
└── respondent/              # 答题人页面
    └── topics/
        └── [id]/
            ├── page.tsx           # 专题详情
            └── exam/
                └── page.tsx       # 考试页面
```

### 2. 动态导入模式

**路由页面使用动态导入**:

```typescript
'use client'

import { useParams } from 'next/navigation'

export default function TopicPage() {
  const params = useParams()
  const topicId = parseInt(params.id as string)

  // 使用动态导入加载组件
  const TopicDetail = dynamic(() => import('@wecode/components/evaluation/author/TopicDetail'), {
    ssr: false
  })

  return <TopicDetail topicId={topicId} />
}
```

### 3. 模型选择对话框模式（推荐方式）

**使用 useModelSelection hook 管理状态**:

```typescript
// 1. 导入 hook 和组件
import { useRef } from 'react'
import ModelSelector from '@/features/tasks/components/selector/ModelSelector'
import { useModelSelection, type Model } from '@/features/tasks/hooks/useModelSelection'
import { getAuthorGradingConfig } from '@wecode/api/evaluation-author'

// 2. 使用 hook 管理模型状态
const modelSelection = useModelSelection({
  teamId: null,
  taskId: null,
  selectedTeam: null,
  disabled: false,
})

// 3. 追踪是否已完成本次自动选择（防止重复选择）
const hasAutoSelectedRef = useRef(false)

// 4. 对话框打开后的自动选择（核心逻辑）
useEffect(() => {
  if (!modelDialogOpen) return
  if (hasAutoSelectedRef.current) return
  if (modelSelection.isLoading) return

  hasAutoSelectedRef.current = true

  const autoSelectModel = async () => {
    if (!question?.topic_id) return

    try {
      const config = await getAuthorGradingConfig(question.topic_id)

      if (!config.model_id) {
        modelSelection.selectModel(null)
        modelSelection.setForceOverride(config.force_override_bot_model || false)
        return
      }

      const foundModel = modelSelection.models.find((m: Model) => m.name === config.model_id)
      if (foundModel) {
        modelSelection.selectModel(foundModel)
      } else if (config.model_id) {
        modelSelection.selectModel({
          name: config.model_id,
          displayName: config.model_id,
          provider: '',
          modelId: config.model_id,
        } as Model)
      }
      modelSelection.setForceOverride(config.force_override_bot_model || false)
    } catch (_error) {
      modelSelection.selectModel(null)
      modelSelection.setForceOverride(false)
    }
  }

  autoSelectModel()
}, [modelDialogOpen, modelSelection.isLoading])

// 5. 触发对话框（重置状态以允许自动选择）
const handleExecute = () => {
  if (!gradingTask) return
  setPendingAction('execute')
  // 重置模型选择以允许从专题配置自动选择
  modelSelection.selectModel(null)
  hasAutoSelectedRef.current = false
  setModelDialogOpen(true)
}

// 6. 渲染 ModelSelector
<ModelSelector
  selectedModel={modelSelection.selectedModel}
  setSelectedModel={modelSelection.selectModel}
  forceOverride={modelSelection.forceOverride}
  setForceOverride={modelSelection.setForceOverride}
  selectedTeam={null}
  disabled={false}
/>

// 7. 执行操作
const handleExecuteWithModel = async () => {
  const requestData = {
    model_id: modelSelection.selectedModel?.name || undefined,
    force_override_bot_model: modelSelection.forceOverride,
  }
  await executeGraderTask(taskId, requestData)
}
```

**核心要点**:

1. **必须使用 `useModelSelection` hook** 而不是单独的 useState
2. **打开对话框前重置状态** - `useModelSelection` 初始化可能自动选择模型，需要在打开前手动重置
3. **使用 `useRef` 追踪自动选择状态** - 确保每个对话框周期只执行一次
4. **只监听必要的依赖** - `modelDialogOpen` 和 `modelSelection.isLoading`
5. **立即标记状态防止竞态** - 在检查通过后立即设置 `hasAutoSelectedRef.current = true`

**正确的执行流程**:

```typescript
// 1. 打开对话框前重置状态
const handleExecute = () => {
  modelSelection.selectModel(null)    // 重置模型选择
  hasAutoSelectedRef.current = false  // 重置自动选择标志
  setModelDialogOpen(true)
}

// 2. useEffect 监听对话框打开和加载状态
useEffect(() => {
  if (!modelDialogOpen) return        // 对话框未打开
  if (hasAutoSelectedRef.current) return  // 已经执行过
  if (modelSelection.isLoading) return    // 还在加载中

  hasAutoSelectedRef.current = true   // 立即标记，防止重复

  // 执行自动选择
  autoSelectModel()
}, [modelDialogOpen, modelSelection.isLoading])

// ❌ 错误 - 不在打开前重置
setModelDialogOpen(true)  // useModelSelection 可能已有默认选择

// ❌ 错误 - 监听过多依赖导致竞态
useEffect(() => { ... }, [modelDialogOpen, modelSelection.isLoading, modelSelection.selectedModel, modelSelection.models])
```

**常见陷阱**:

- `useModelSelection` hook 初始化时会尝试自动选择模型（从偏好设置、团队默认等），必须在打开对话框前重置
- 不需要监听 `models` 数组，`isLoading` 从 true 变为 false 时说明加载完成
- 不需要在 useEffect 内检查 `models.length`，只要 `isLoading` 为 false 即可

### 4. Tab 导航模式

**URL 参数控制 Tab**:

```typescript
// 页面: /evaluation/author/topics/2?tab=grading
import { useSearchParams, useRouter } from 'next/navigation'

const searchParams = useSearchParams()
const router = useRouter()
const activeTab = searchParams.get('tab') || 'basic'

const handleTabChange = (tab: string) => {
  const params = new URLSearchParams(searchParams)
  params.set('tab', tab)
  router.push(`?${params.toString()}`)
}
```

### 5. 数据加载模式

**使用 useCallback + useEffect**:

```typescript
const loadData = useCallback(async () => {
  setLoading(true)
  try {
    const [configData, teamsData] = await Promise.all([
      getAuthorGradingConfig(topicId),
      teamApis.getTeams({ page: 1, limit: 100 }, 'group'),
    ])
    setConfig(configData)
    // 初始化表单状态
    setTeamId(configData.team_id?.toString() || '')
    setPromptTemplate(configData.prompt_template || '')
  } catch (error) {
    toast({ title: t('errors.load_failed'), variant: 'destructive' })
  } finally {
    setLoading(false)
  }
}, [topicId])

useEffect(() => {
  loadData()
}, [loadData])
```

### 6. i18n 使用规范

**始终使用 evaluation 命名空间**:

```typescript
const { t } = useTranslation('evaluation')

// 访问键值
t('grading.model_config')
t('exam.intro_duration')

// 访问其他命名空间
t('common:actions.save')
```

### 7. 错误处理

**统一错误处理模式**:

```typescript
try {
  await updateAuthorGradingConfig(topicId, data)
  toast({ title: t('grading.config_saved') })
  loadData() // 刷新数据
} catch (error) {
  toast({
    title: t('errors.save_failed'),
    description: error instanceof Error ? error.message : '',
    variant: 'destructive',
  })
}
```

## 性能优化

### 1. 组件懒加载

```typescript
import dynamic from 'next/dynamic'

const GradingConfigTab = dynamic(
  () => import('@wecode/components/evaluation/author/GradingConfigTab'),
  { ssr: false, loading: () => <Skeleton className="h-48" /> }
)
```

### 2. 避免不必要的状态更新

```typescript
// 使用 useMemo 缓存计算结果
const selectedTeam = useMemo(() => {
  if (!teamId) return null
  return availableTeams.find(t => t.id?.toString() === teamId) || null
}, [teamId, availableTeams])
```

## 常见错误

1. **Hydration mismatch** - 确保动态组件设置 `ssr: false`
2. **Missing params** - 使用 `useParams()` 时确保在 Client Component 中
3. **i18n namespace not loaded** - 确保键值添加到 evaluation.json
4. **State not synchronized** - 加载数据后正确初始化表单状态
5. **Missing import after refactoring** - 重构后遗漏导入：
   - 重构时如果复制/移动代码到新文件，必须同步检查所有依赖导入
   - 常见遗漏：`Link`, `ArrowRight`, `Calendar` 等图标组件
   - **验证方法**：重构后运行 `npx eslint src/path/to/file.tsx` 检查未定义变量
6. **useModelSelection 依赖导致的无限循环** - 不要在 useEffect/useCallback 中依赖整个 `modelSelection` 对象：

   ```typescript
   // ❌ 错误 - 会导致无限循环
   useEffect(() => { ... }, [modelSelection])
   const fn = useCallback(() => { ... }, [modelSelection])

   // ✅ 正确 - 依赖具体属性
   useEffect(() => { ... }, [modelSelection.isLoading, modelSelection.models])
   const fn = useCallback(() => { ... }, [modelSelection.selectModel])
   ```

7. **ModelSelector 组件状态不同步** - ModelSelector 内部使用 `useModelSelection` hook，只从内向外同步，不会从外向内同步！

   ```typescript
   // ❌ 错误 - ModelSelector 只把内部状态同步到外部
   useEffect(() => {
     if (modelSelection.selectedModel !== externalSelectedModel) {
       if (modelSelection.selectedModel) {
         externalSetSelectedModel(modelSelection.selectedModel) // 单向同步！
       }
     }
   }, [])

   // ✅ 正确 - 需要双向同步：添加从外部到内部的同步
   useEffect(() => {
     if (externalSelectedModel !== modelSelection.selectedModel) {
       if (externalSelectedModel) {
         modelSelection.selectModel(externalSelectedModel)
       }
     }
   }, [externalSelectedModel, modelSelection.selectedModel, modelSelection.selectModel])
   ```

8. **模型自动选择不生效** - `useModelSelection` 初始化时会自动选择模型，必须在打开对话框前重置：

   ```typescript
   // ❌ 错误 - 直接打开对话框，useModelSelection 可能已有默认选择
   const handleExecute = () => {
     setModelDialogOpen(true) // 可能显示的是团队默认模型，而非专题配置
   }

   // ✅ 正确 - 打开前重置模型选择
   const handleExecute = () => {
     modelSelection.selectModel(null) // 重置
     hasAutoSelectedRef.current = false // 重置标志
     setModelDialogOpen(true)
   }
   ```

9. **useEffect 依赖过多导致竞态** - 需要监听 `modelDialogOpen`、`isLoading` 和 `models`：

   ```typescript
   // ❌ 错误 - 只监听 isLoading，models 加载完成后不会触发
   useEffect(() => { ... }, [modelDialogOpen, modelSelection.isLoading])

   // ✅ 正确 - 同时监听 models，确保模型列表加载完成后触发
   useEffect(() => { ... }, [modelDialogOpen, modelSelection.isLoading, modelSelection.models])
   ```

## 代码检查与格式化

### Frontend Lint 检查（正确方式）

```bash
# 方式1：在项目根目录运行（推荐）
cd frontend && npm run lint

# 方式2：直接运行 next lint（需要在前端目录）
cd frontend && npx next lint

# 方式3：直接运行 eslint（需要在前端目录，且 ESLint v9 需要 flat config）
cd frontend && npx eslint src/path/to/file.tsx

# 自动修复
cd frontend && npm run lint -- --fix
```

**常见问题：**

- ESLint v9+ 使用 `eslint.config.mjs` 而非 `.eslintrc.*`
- 必须在 `frontend/` 目录下运行，因为配置文件在该目录
- `next lint` 在 Next.js 16 中将被移除，建议使用 `npx eslint`

### Frontend 代码格式化

```bash
cd frontend && npm run format
```

## 批量重构规范

### 目录探索优先原则

**重构前必须完整探索目录结构，确保不遗漏文件。**

```bash
# 重构前执行 - 列出所有相关页面
find frontend/src/app/(tasks)/evaluation/TARGET_DIR -name "*.tsx" -type f

# 示例：重构 grader 页面前先查看完整结构
tree frontend/src/app/(tasks)/evaluation/grader
```

**常见嵌套路径容易被遗漏：**

- `[id]/page.tsx` - 动态路由页面
- `answers/[id]/page.tsx` - 嵌套动态路由
- `topics/[id]/page.tsx` - 专题详情页
- `reports/page.tsx` - 子目录页面

### 统一设计系统重构步骤

重构页面样式时按以下顺序执行：

1. **探索阶段** - 列出所有目标文件
2. **提取公共组件** - 创建可复用的 Header/Stats 组件
3. **更新主页面** - 先重构入口页面验证设计
4. **更新子页面** - 逐个更新嵌套目录下的页面
5. **验证阶段** - 检查所有页面渲染正常

**示例：重构 grader 模块**

```
Step 1: find frontend/src/app/(tasks)/evaluation/grader -name "*.tsx"
Step 2: 创建 GraderHeader.tsx, GraderStats.tsx
Step 3: 更新 grader/page.tsx
Step 4: 更新 grader/tasks/page.tsx
Step 5: 更新 grader/reports/page.tsx
Step 6: 更新 grader/topics/[id]/page.tsx
Step 7: 更新 grader/answers/[id]/page.tsx  <-- 最容易遗漏
Step 8: 验证所有页面
```

### 样式统一检查清单

- [ ] 背景色：`bg-[#fafbfc]`
- [ ] 主容器：`max-w-7xl mx-auto px-4 sm:px-8 py-8`
- [ ] 卡片样式：`bg-white rounded-2xl shadow-sm border border-gray-100`
- [ ] 卡片头部：`px-6 py-4 border-b border-gray-100`
- [ ] 卡片内容：`p-6`
- [ ] 粘性头部：`sticky top-0 z-50 bg-white/95 backdrop-blur-md`

## 检查清单

添加新功能时:

- [ ] 创建/更新页面组件
- [ ] 添加 i18n 翻译键值
- [ ] 实现数据加载和状态管理
- [ ] 添加错误处理
- [ ] 测试 Tab/路由切换
- [ ] 验证模型选择对话框

批量重构时:

- [ ] 完整探索目录结构（使用 find/tree 命令）
- [ ] 列出所有需要修改的文件
- [ ] 按依赖顺序更新（公共组件 → 主页面 → 子页面）
- [ ] 每个文件修改后检查 ESLint 错误（特别是未定义变量）
- [ ] 验证所有相关页面渲染正常

重构后代码质量检查:

- [ ] 运行 ESLint 检查未导入变量：`npx eslint src/path/to/file.tsx`
- [ ] 检查图标导入是否完整（常用：Link, ArrowRight, Calendar, Clock 等）
- [ ] 移除未使用的导入（如替换为 GraderHeader 后移除 ArrowLeft）
- [ ] 验证组件 props 类型匹配
- [ ] 检查 JSX 标签是否正确闭合

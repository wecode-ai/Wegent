# Evaluation Frontend Components Guide

## 开发经验总结

### 1. i18n 命名空间使用

**问题**: 组件使用了错误的命名空间（如 `grading:`），导致翻译缺失。

**正确做法**:

```typescript
// 使用 evaluation 命名空间
const { t } = useTranslation('evaluation')

// 访问键值
t('grading.model_config') // 当前命名空间
t('common:actions.save') // 其他命名空间
```

**翻译文件位置**:

- `src/i18n/locales/zh-CN/evaluation.json`
- `src/i18n/locales/en/evaluation.json`

**添加新键值时**:

1. 先检查 evaluation.json 是否已存在
2. 同时在 zh-CN 和 en 中添加
3. 键值格式: `"grading.subkey"` 或 `"exam.subkey"`

### 1.1 避免 i18n 错误的最佳实践

**开发前检查清单（必做）**:

```typescript
// ✅ 1. 使用 useTranslation 时指定正确的命名空间
const { t } = useTranslation('evaluation')  // 当前功能命名空间

// ✅ 2. 添加新键值前，先在 locales 文件中搜索确认不存在
// 搜索: 在 zh-CN/evaluation.json 和 en/evaluation.json 中搜索键值

// ✅ 3. 同时更新两个语言文件
// - src/i18n/locales/zh-CN/evaluation.json
// - src/i18n/locales/en/evaluation.json

// ✅ 4. 按功能模块组织键值
{
  "grading": {
    "model": "Model",
    "model_config": "Model Configuration",
    "select_model": "Select Model"
  }
}

// ❌ 常见错误: 使用数组形式导入多个命名空间
const { t } = useTranslation(['common', 'evaluation'])  // 会导致当前命名空间键值失效
```

**调试技巧**:

```typescript
// 在浏览器控制台捕获缺失的键值
i18n.on('missingKey', (lng, ns, key) => {
  console.warn(`Missing i18n key: ${ns}:${key} for language ${lng}`)
})
```

**命名规范**:
| 场景 | 正确示例 | 说明 |
|------|---------|------|
| 功能模块键值 | `grading.model_config` | 使用小写 + 下划线 |
| 跨命名空间引用 | `t('common:actions.save')` | 使用冒号分隔 |
| 布尔/状态键值 | `grading.auto_trigger_enabled` | 语义清晰明确 |

### 2. 复用现有组件

**ModelSelector 组件复用**:

```typescript
import ModelSelector from '@/features/tasks/components/selector/ModelSelector'
import type { Model, TeamWithBotDetails } from '@/features/tasks/components/selector/ModelSelector'

// 使用
<ModelSelector
  selectedModel={selectedModel}
  setSelectedModel={setSelectedModel}
  forceOverride={forceOverride}
  setForceOverride={setForceOverride}
  selectedTeam={selectedTeam as TeamWithBotDetails | null}
  disabled={false}
  teamId={teamId}
/>
```

**注意**: 不要重新定义 Model 类型，从组件导入。

### 3. 类型定义同步

**问题**: 前端类型与后端 Schema 不同步。

**必须同步的文件**:

1. `wecode/types/evaluation.ts` - 基础类型定义
2. `wecode/api/evaluation*.ts` - API 参数类型

**示例**:

```typescript
// GradingConfigUpdate 必须包含后端所有可配置字段
export interface GradingConfigUpdate {
  team_id?: number
  auto_trigger?: boolean
  trigger_condition?: string
  grading_timeout?: number
  prompt_template?: string
  model_id?: string
  force_override_bot_model?: boolean
}
```

### 4. 表单状态管理

**模式**:

```typescript
// 1. 定义状态
const [teamId, setTeamId] = useState<string>('')
const [selectedModel, setSelectedModel] = useState<Model | null>(null)
const [forceOverride, setForceOverride] = useState(false)

// 2. 加载数据时初始化
useEffect(() => {
  setTeamId(configData.team_id?.toString() || '')
  if (configData.model_id) {
    setSelectedModel({
      name: configData.model_id,
      displayName: configData.model_id,
    } as Model)
  }
}, [configData])

// 3. 保存时提交
await updateAuthorGradingConfig(topicId, {
  team_id: teamId ? parseInt(teamId) : undefined,
  model_id: selectedModel?.name || undefined,
  force_override_bot_model: forceOverride,
})
```

### 5. 对话框模式

**模型选择对话框 (推荐使用 ModelSelectionDialog 组件)**:

```typescript
import { ModelSelectionDialog } from '@wecode/components/evaluation/grader/ModelSelectionDialog'

// 状态
const [modelDialogOpen, setModelDialogOpen] = useState(false)
const [pendingAction, setPendingAction] = useState<'execute' | 'retry' | null>(null)

// 触发
const handleExecute = () => {
  setPendingAction('execute')
  setModelDialogOpen(true)
}

// 确认执行
const handleExecuteWithModel = async (modelId?: string, forceOverride?: boolean) => {
  await executeTask(gradingTask.id, modelId, forceOverride)
}

// 渲染
<ModelSelectionDialog
  open={modelDialogOpen}
  onOpenChange={setModelDialogOpen}
  topicId={question?.topic_id || null}
  onConfirm={handleExecuteWithModel}
  title={t('grading.select_model_title')}
  confirmText={pendingAction === 'execute' ? t('grading.start_grading') : t('grading.retry_grading')}
  loading={executing}
/>
```

**优势**:
- 自动从 topic config 中选择模型
- 显示默认配置模型信息
- 提示用户可直接确认使用默认模型
- 内置 modelSelection hook 管理
- 统一的 UI 和交互
- 减少页面代码量 (~100 行)

**对话框展示内容**:
- 默认配置模型名称（从 topic config 读取）
- 提示信息：可直接确认使用默认模型，或选择其他模型覆盖
- ModelSelector 组件供用户选择覆盖模型
- 强制覆盖选项（force_override_bot_model）

### 5.1 Grading Actions Hook

**useGradingActions - 统一管理评分操作**:

```typescript
import { useGradingActions } from '@wecode/components/evaluation/grader/useGradingActions'

const { executing, publishing, executeTask, retryTask, publishTask, batchExecute, batchPublish } =
  useGradingActions({
    onSuccess: () => {
      loadData() // 刷新数据
    },
  })

// 使用
await executeTask(taskId, modelId, forceOverride)
await retryTask(taskId, modelId, forceOverride)
await publishTask(taskId)
await batchExecute([taskId1, taskId2])
```

### 6. 组件目录结构

```
evaluation/
├── author/               # 出题人相关组件
│   ├── GradingConfigTab.tsx
│   ├── ConfigDrawer.tsx
│   └── ...
├── grader/               # 评分人相关组件
│   ├── GradingTaskCard.tsx
│   ├── ModelSelectionDialog.tsx   # 模型选择对话框
│   └── useGradingActions.ts       # 评分操作 Hook
├── respondent/           # 答题人相关组件
├── common/               # 通用组件
│   ├── AttachmentList.tsx
│   └── StatusBadge.tsx
└── exam/                 # 考试模式组件
```

### 7. API 客户端更新

**添加新参数时**:

```typescript
// 更新 API 函数签名
export async function graderRetryTask(
  taskId: number,
  data?: GradingTaskExecuteRequest // 新增可选参数
): Promise<GradingTask> {
  return fetchJson<GradingTask>(getGraderUrl(`/tasks/${taskId}/retry`), {
    method: 'POST',
    body: data ? JSON.stringify(data) : undefined,
  })
}
```

## 调试技巧

### 检查 i18n 键值

```typescript
// 在浏览器控制台查看缺失的键值
i18n.on('missingKey', (lng, ns, key) => {
  console.log(`Missing key: ${ns}:${key}`)
})
```

### 检查 API 请求

```typescript
// 浏览器 Network 面板检查请求体
// 确保 model_id 和 force_override_bot_model 正确发送
```

## 常见错误

1. **TypeError: Cannot read property 'name' of null** - 未检查空值
2. **i18next::translator: missingKey** - 翻译键值未添加
3. **Object literal may only specify known properties** - 类型定义不同步
4. **Unexpected any** - 需要正确指定类型而非使用 any
5. **高级模型不显示** - ModelSelector 默认过滤高级模型，需额外显示选中状态

## 高级模型显示问题

**问题**: 在 GradingConfigTab 中，配置了高级模型后刷新页面，ModelSelector 不显示已选中的模型。

**原因**:
- `useModelSelection` hook 默认 `showAdvancedModels = false`
- 高级模型被 `filteredModels` 过滤掉
- 外部传入的 `selectedModel` 无法在列表中匹配到

**解决方案**: 在 ModelSelector 上方直接显示已选中的模型信息，绕过列表过滤限制：

```tsx
{selectedModel && (
  <div className="px-3 py-2 bg-surface border border-border rounded-lg">
    <div className="text-sm font-medium text-text-primary">
      {selectedModel.displayName || selectedModel.name}
    </div>
    {selectedModel.name !== '__default__' && (
      <div className="text-xs text-text-muted">{selectedModel.name}</div>
    )}
  </div>
)}
<ModelSelector ... />
```

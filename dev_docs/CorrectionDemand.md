
## 🔍 AI 纠错模式实现架构分析

我已经完成了对前端 AI 纠错模式的实现分析。以下是完整的技术架构：

---

### 📋 功能概述

AI 纠错模式是一个**自动评估和改进 AI 回答质量**的功能。当用户启用此模式后，系统会使用另一个 AI 模型来评估每个 AI 回答，并提供：
- 评分（准确性、逻辑性、完整性，1-10分）
- 发现的问题和改进建议
- 改进后的完整答案

---

### 🏗️ 核心组件架构

#### **1. 前端组件层**

##### [`CorrectionModeToggle.tsx`](frontend/src/features/tasks/components/CorrectionModeToggle.tsx:32)
**职责：** 纠错模式开关组件

**核心功能：**
- 显示圆形按钮（CheckCircle 图标），启用时高亮显示
- 点击启用时弹出模型选择对话框，支持搜索过滤
- 从 localStorage 自动恢复上次选择的纠错模型
- 状态持久化到 localStorage

**关键实现：**
```typescript
// 状态恢复（第52-58行）
useEffect(() => {
  const savedState = correctionApis.getCorrectionModeState()
  if (savedState.enabled && savedState.correctionModelId) {
    onToggle(true, savedState.correctionModelId, savedState.correctionModelName)
  }
}, [])

// 模型选择（第84-98行）
const handleModelSelect = (model: UnifiedModel) => {
  onToggle(true, model.name, displayName)
  correctionApis.saveCorrectionModeState({
    enabled: true,
    correctionModelId: model.name,
    correctionModelName: displayName,
  })
}
```

---

##### [`ChatArea.tsx`](frontend/src/features/tasks/components/ChatArea.tsx:141)
**职责：** 聊天区域主组件，管理纠错模式状态

**核心状态：**
```typescript
const [enableCorrectionMode, setEnableCorrectionMode] = useState(false)
const [correctionModelId, setCorrectionModelId] = useState<string | null>(null)
const [correctionModelName, setCorrectionModelName] = useState<string | null>(null)
```

**UI 集成（第1710-1714行）：**
- 仅在 Chat Shell 类型的 Team 中显示（`isChatShell(selectedTeam)`）
- 在加载或流式传输时禁用切换

---

##### [`MessagesArea.tsx`](frontend/src/features/tasks/components/MessagesArea.tsx:165)
**职责：** 消息展示区域，触发纠错并显示结果

**自动触发纠错逻辑（第165-218行）：**
```typescript
useEffect(() => {
  if (!enableCorrectionMode || !correctionModelId) return

  // 遍历所有消息，找到已完成但未纠错的 AI 消息
  messages.forEach((msg, index) => {
    if (msg.type !== 'ai' || msg.status === 'streaming') return
    if (correctionResults.has(msg.subtaskId) || correctionLoading.has(msg.subtaskId)) return

    // 找到对应的用户问题（前一条消息）
    const userMsg = index > 0 ? messages[index - 1] : null
    if (!userMsg || userMsg.type !== 'user') return

    // 调用纠错 API
    correctionApis.correctResponse({
      task_id: selectedTaskDetail.id,
      message_id: subtaskId,
      original_question: userMsg.content,
      original_answer: msg.content,
      correction_model_id: correctionModelId,
    })
  })
}, [enableCorrectionMode, correctionModelId, messages, ...])
```

**双栏显示（第684-719行）：**
```typescript
// 对于启用纠错模式的 AI 消息，使用双栏布局
if (msg.type === 'ai' && enableCorrectionMode && (hasCorrectionResult || isCorrecting)) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <MessageBubble msg={convertToMessage(msg)} ... />
      <CorrectionResultPanel result={correctionResult} isLoading={isCorrecting} />
    </div>
  )
}
```

---

##### [`CorrectionResultPanel.tsx`](frontend/src/features/tasks/components/CorrectionResultPanel.tsx:42)
**职责：** 显示纠错结果的 UI 面板

**显示内容：**
1. **评分条（第20-39行）：** 准确性、逻辑性、完整性（1-10分，带颜色编码）
2. **问题列表（第88-116行）：** 发现的问题及改进建议
3. **总结评价（第129-135行）：** 整体评价摘要
4. **改进答案（第138-148行）：** 使用 Markdown 渲染的改进版答案

---

#### **2. API 层**

##### [`frontend/src/apis/correction.ts`](frontend/src/apis/correction.ts:66)
**核心接口：**
```typescript
export interface CorrectionRequest {
  task_id: number
  message_id: number
  original_question: string
  original_answer: string
  correction_model_id: string
}

export interface CorrectionResponse {
  message_id: number
  scores: { accuracy: number, logic: number, completeness: number }
  corrections: Array<{ issue: string, suggestion: string }>
  summary: string
  improved_answer: string
  is_correct: boolean
}

// API 方法
correctionApis.correctResponse(request): Promise<CorrectionResponse>
correctionApis.getCorrectionModeState(): CorrectionModeState
correctionApis.saveCorrectionModeState(state): void
correctionApis.clearCorrectionModeState(): void
```

---

#### **3. 后端服务层**

##### [`backend/app/services/correction_service.py`](backend/app/services/correction_service.py:70)
**核心方法：**
```python
async def evaluate_response(
    self,
    original_question: str,
    original_answer: str,
    model_config: dict[str, Any],
) -> dict[str, Any]:
    # 1. 构建纠错提示词
    prompt = CORRECTION_PROMPT_TEMPLATE.format(...)
    
    # 2. 调用纠错模型（流式）
    provider = get_provider(model_config, client)
    async for chunk in provider.stream_chat(messages, cancel_event):
        accumulated_content += chunk.content
    
    # 3. 解析 JSON 响应
    return self._parse_correction_response(accumulated_content)
```

**提示词模板（第23-64行）：**
- 假设用户不满意，主动寻找问题
- 从 4 个维度分析：用户不满原因、事实验证、逻辑错误、遗漏考虑
- 要求返回纯 JSON 格式（评分、问题列表、总结、改进答案）

---

##### [`backend/app/api/endpoints/adapter/chat.py`](backend/app/api/endpoints/adapter/chat.py:1745)
**REST API 端点：**
```python
@router.post("/correct", response_model=CorrectionResponse)
async def correct_response(request: CorrectionRequest, ...):
    # 1. 验证任务权限
    # 2. 获取纠错模型配置（支持公共模型和用户自定义模型）
    # 3. 调用 correction_service.evaluate_response()
    # 4. 返回纠错结果
```

---

### 🔄 完整工作流程

```
1. 用户点击纠错按钮 → 选择纠错模型 → 保存到 localStorage
2. 用户发送消息 → AI 回答完成
3. MessagesArea.useEffect 自动检测到新的 AI 消息
4. 调用 POST /chat/correct API
5. 后端 CorrectionService 调用纠错模型评估
6. 解析 JSON 响应（评分、问题、改进建议）
7. 前端双栏显示：左侧原答案，右侧纠错结果
```

---

### ✨ 关键设计亮点

1. **自动触发：** 使用 `useEffect` 监听消息变化，AI 回答完成后自动触发纠错，无需用户手动操作
2. **状态持久化：** 纠错模式和模型选择保存到 localStorage，刷新页面后保持
3. **双栏对比：** 使用 CSS Grid 实现响应式布局（桌面端并排，移动端堆叠）
4. **加载状态：** 使用 `correctionLoading` Set 跟踪正在纠错的消息，显示加载动画
5. **防重复调用：** 使用 `correctionResults` Map 缓存结果，避免重复纠错同一消息
6. **仅限 Chat Shell：** 只在 Chat 类型的 Team 中显示纠错按钮
7. **模型灵活性：** 支持公共模型和用户自定义模型作为纠错模型

---

### 📊 数据结构

**CorrectionResponse 结构：**
```json
{
  "message_id": 123,
  "scores": {
    "accuracy": 8,
    "logic": 7,
    "completeness": 6
  },
  "corrections": [
    {
      "issue": "回答中提到的数据已过时",
      "suggestion": "应使用最新的 2024 年数据"
    }
  ],
  "summary": "回答整体逻辑清晰，但部分数据需要更新",
  "improved_answer": "改进后的完整答案...",
  "is_correct": false
}
```

这个实现通过组件化设计和自动化触发机制，为用户提供了无缝的 AI 回答质量评估体验

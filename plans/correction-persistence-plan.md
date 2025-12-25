# AI 纠错数据持久化方案

## 📋 概述

本方案旨在将 AI 纠错功能的评估结果持久化到数据库，实现：
- 纠错结果长期保存，刷新页面后不丢失
- 支持查看历史纠错记录
- 分享任务时包含纠错结果
- 避免重复调用纠错 API，节省成本

---

## 🏗️ 架构设计

### 方案选择：扩展 subtasks.result JSON 字段

**选择理由：**
1. **零迁移成本**：`subtasks` 表已有 `result` JSON 字段，无需新建表
2. **数据内聚**：纠错数据与 AI 消息存储在一起，查询更简单
3. **自动加载**：获取任务详情时自动包含纠错数据，无需额外 API
4. **实现简单**：只需修改后端保存逻辑和前端读取逻辑

---

## 📊 数据结构设计

### 扩展 `subtasks.result` JSON 字段

现有的 `result` 字段已经是 JSON 类型，我们在其中添加 `correction` 子对象：

```json
{
  // 现有字段（AI 回答内容等）
  "content": "AI 的回答内容...",
  "shell_type": "chat",
  // ... 其他现有字段
  
  // 新增：纠错数据
  "correction": {
    "model_id": "gpt-4",
    "model_name": "GPT-4",
    "scores": {
      "accuracy": 8,
      "logic": 7,
      "completeness": 6
    },
    "corrections": [
      {
        "issue": "回答中提到的数据已过时",
        "suggestion": "应使用最新的 2024 年数据",
        "category": "fact_error"
      }
    ],
    "summary": "回答整体逻辑清晰，但部分数据需要更新",
    "improved_answer": "改进后的完整答案...",
    "is_correct": false,
    "corrected_at": "2024-12-25T13:45:00Z"
  }
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `correction.model_id` | string | 使用的纠错模型 ID |
| `correction.model_name` | string | 纠错模型显示名称 |
| `correction.scores` | object | 评分：accuracy, logic, completeness (1-10) |
| `correction.corrections` | array | 问题列表：`[{issue, suggestion, category}]` |
| `correction.summary` | string | 总结评价 |
| `correction.improved_answer` | string | 改进后的完整答案 |
| `correction.is_correct` | boolean | 是否无需纠正 |
| `correction.corrected_at` | string | 纠错时间 (ISO 8601) |

---

## 🔧 后端实现

### 1. 无需数据库迁移

由于使用现有的 `result` JSON 字段，**不需要任何数据库迁移**。

### 2. 修改 `/chat/correct` 端点

**文件：** `backend/app/api/endpoints/adapter/chat.py`

```python
@router.post("/correct", response_model=CorrectionResponse)
async def correct_response(
    request: CorrectionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Evaluate and correct an AI response, then save to subtask.result.
    
    Changes:
    1. Check if correction already exists in subtask.result
    2. If exists, return cached result
    3. If not, call LLM and save result to subtask.result.correction
    """
    # Get the subtask (AI message)
    subtask = db.query(Subtask).filter(
        Subtask.id == request.message_id,
        Subtask.role == SubtaskRole.ASSISTANT,
    ).first()
    
    if not subtask:
        raise HTTPException(status_code=404, detail="AI message not found")
    
    # Verify task access
    task = db.query(Task).filter(Task.id == request.task_id).first()
    if not task or (task.user_id != current_user.id):
        # Check group chat membership
        member = db.query(TaskMember).filter(
            TaskMember.task_id == request.task_id,
            TaskMember.user_id == current_user.id,
        ).first()
        if not member:
            raise HTTPException(status_code=403, detail="Access denied")
    
    # Check for existing correction in result
    result = subtask.result or {}
    existing_correction = result.get("correction")
    
    if existing_correction:
        # Return cached result
        return {
            "message_id": subtask.id,
            "scores": existing_correction.get("scores", {}),
            "corrections": existing_correction.get("corrections", []),
            "summary": existing_correction.get("summary", ""),
            "improved_answer": existing_correction.get("improved_answer", ""),
            "is_correct": existing_correction.get("is_correct", False),
        }
    
    # ... existing LLM call logic to get correction result ...
    
    # Get model display name
    model_display_name = get_model_display_name(request.correction_model_id, db)
    
    # Save correction to subtask.result
    result["correction"] = {
        "model_id": request.correction_model_id,
        "model_name": model_display_name,
        "scores": llm_result["scores"],
        "corrections": llm_result["corrections"],
        "summary": llm_result["summary"],
        "improved_answer": llm_result["improved_answer"],
        "is_correct": llm_result["is_correct"],
        "corrected_at": datetime.utcnow().isoformat() + "Z",
    }
    
    # Update subtask
    subtask.result = result
    db.commit()
    
    return {
        "message_id": request.message_id,
        "scores": llm_result["scores"],
        "corrections": llm_result["corrections"],
        "summary": llm_result["summary"],
        "improved_answer": llm_result["improved_answer"],
        "is_correct": llm_result["is_correct"],
    }
```

### 3. 新增删除纠错 API（可选）

```python
@router.delete("/subtasks/{subtask_id}/correction")
async def delete_correction(
    subtask_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Delete correction data from a subtask.
    Allows user to re-run correction with a different model.
    """
    subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
    if not subtask:
        raise HTTPException(status_code=404, detail="Subtask not found")
    
    # Verify access
    # ... permission check ...
    
    # Remove correction from result
    result = subtask.result or {}
    if "correction" in result:
        del result["correction"]
        subtask.result = result
        db.commit()
    
    return {"message": "Correction deleted"}
```

---

## 🎨 前端实现

### 1. 更新 API 客户端

**文件：** `frontend/src/apis/correction.ts`

```typescript
// 新增接口：从 subtask.result 中提取的纠错数据
export interface CorrectionData {
  model_id: string
  model_name?: string
  scores: CorrectionScores
  corrections: CorrectionItem[]
  summary: string
  improved_answer: string
  is_correct: boolean
  corrected_at?: string
}

export const correctionApis = {
  // 现有方法保持不变
  async correctResponse(request: CorrectionRequest): Promise<CorrectionResponse> {
    return apiClient.post('/chat/correct', request)
  },

  // 新增：删除纠错记录（允许重新纠错）
  async deleteCorrection(subtaskId: number): Promise<void> {
    return apiClient.delete(`/subtasks/${subtaskId}/correction`)
  },

  // localStorage 方法保持不变...
}

// 辅助函数：从 subtask.result 中提取纠错数据
export function extractCorrectionFromResult(result: any): CorrectionData | null {
  if (!result || !result.correction) return null
  return result.correction as CorrectionData
}
```

### 2. 修改 MessagesArea 组件

**文件：** `frontend/src/features/tasks/components/MessagesArea.tsx`

```typescript
// 关键改动：从 subtask.result 中读取已保存的纠错数据

// 1. 初始化时从 subtasks 加载已有纠错
useEffect(() => {
  if (!selectedTaskDetail?.subtasks) return
  
  const savedResults = new Map<number, CorrectionResponse>()
  
  selectedTaskDetail.subtasks.forEach(subtask => {
    if (subtask.role !== 'assistant') return
    
    // 从 result.correction 中提取纠错数据
    const correction = extractCorrectionFromResult(subtask.result)
    if (correction) {
      savedResults.set(subtask.id, {
        message_id: subtask.id,
        scores: correction.scores,
        corrections: correction.corrections,
        summary: correction.summary,
        improved_answer: correction.improved_answer,
        is_correct: correction.is_correct,
      })
    }
  })
  
  setCorrectionResults(savedResults)
}, [selectedTaskDetail?.subtasks])

// 2. 修改自动纠错逻辑 - 跳过已有纠错的消息
useEffect(() => {
  if (!enableCorrectionMode || !correctionModelId || !selectedTaskDetail?.id) return

  messages.forEach((msg, index) => {
    if (msg.type !== 'ai' || msg.status === 'streaming') return
    if (!msg.subtaskId) return
    
    // 检查是否已有纠错记录（从 subtask.result 加载的）
    if (correctionResults.has(msg.subtaskId)) return
    if (correctionLoading.has(msg.subtaskId)) return

    // 找到对应的用户问题
    const userMsg = index > 0 ? messages[index - 1] : null
    if (!userMsg || userMsg.type !== 'user' || !userMsg.content) return

    // 调用纠错 API（后端会自动保存到 subtask.result）
    const subtaskId = msg.subtaskId
    setCorrectionLoading(prev => new Set(prev).add(subtaskId))

    correctionApis
      .correctResponse({
        task_id: selectedTaskDetail.id,
        message_id: subtaskId,
        original_question: userMsg.content,
        original_answer: msg.content || '',
        correction_model_id: correctionModelId,
      })
      .then(result => {
        setCorrectionResults(prev => new Map(prev).set(subtaskId, result))
        // 刷新任务详情以获取更新后的 subtask.result
        refreshSelectedTaskDetail()
      })
      .catch(error => {
        console.error('Correction failed:', error)
        toast({
          variant: 'destructive',
          title: 'Correction failed',
          description: error?.message || 'Unknown error',
        })
      })
      .finally(() => {
        setCorrectionLoading(prev => {
          const next = new Set(prev)
          next.delete(subtaskId)
          return next
        })
      })
  })
}, [enableCorrectionMode, correctionModelId, messages, correctionResults, ...])
```

### 3. 可选：添加重新纠错功能

在 `CorrectionResultPanel` 中添加"重新纠错"按钮：

```typescript
// CorrectionResultPanel.tsx 中添加

interface CorrectionResultPanelProps {
  result: CorrectionResponse
  isLoading?: boolean
  className?: string
  subtaskId?: number  // 新增
  onRecorrect?: () => void  // 新增：重新纠错回调
}

// 在面板中添加重新纠错按钮
{subtaskId && onRecorrect && (
  <Button
    variant="outline"
    size="sm"
    onClick={async () => {
      await correctionApis.deleteCorrection(subtaskId)
      onRecorrect()
    }}
  >
    <RefreshCw className="h-4 w-4 mr-2" />
    {t('correction.recorrect')}
  </Button>
)}
```

---

## 📋 实施步骤

### 阶段 1：后端改动

| 步骤 | 任务 | 文件 |
|------|------|------|
| 1.1 | 修改 `/chat/correct` 端点，添加缓存检查和保存逻辑 | `backend/app/api/endpoints/adapter/chat.py` |
| 1.2 | 新增 `DELETE /subtasks/{id}/correction` 端点（可选） | 同上 |
| 1.3 | 编写单元测试 | `backend/tests/test_correction.py` |

### 阶段 2：前端改动

| 步骤 | 任务 | 文件 |
|------|------|------|
| 2.1 | 更新 API 客户端，添加辅助函数 | `frontend/src/apis/correction.ts` |
| 2.2 | 修改 MessagesArea，从 subtask.result 加载纠错数据 | `frontend/src/features/tasks/components/MessagesArea.tsx` |
| 2.3 | 可选：添加重新纠错功能 | `frontend/src/features/tasks/components/CorrectionResultPanel.tsx` |
| 2.4 | 更新 i18n 翻译 | `frontend/src/i18n/locales/*/chat.json` |

### 阶段 3：测试和部署

| 步骤 | 任务 |
|------|------|
| 3.1 | 后端单元测试 |
| 3.2 | 前端组件测试 |
| 3.3 | E2E 测试 |
| 3.4 | 部署 |

---

## 🔄 数据流变化

### 变更前（当前实现）

```
用户启用纠错 → 选择模型 → localStorage
                              ↓
AI 回答完成 → 调用 /chat/correct → LLM 评估 → 返回结果
                                                    ↓
                                            React state（内存）
                                                    ↓
                                            刷新页面后丢失
```

### 变更后（持久化方案）

```
用户启用纠错 → 选择模型 → localStorage
                              ↓
打开任务 → 获取任务详情 → subtasks[].result.correction 自动包含纠错数据
                                                    ↓
AI 回答完成 → 检查 result.correction 是否存在
                              ↓ 不存在
                    调用 /chat/correct
                              ↓
                    LLM 评估 → 保存到 subtask.result.correction
                              ↓
                    返回结果 → React state + 数据库
                              ↓
                    刷新页面 → 从 subtask.result 自动加载
```

---

## ⚠️ 注意事项

### 1. 向后兼容
- 现有的 `result` 字段结构不变，只是新增 `correction` 子对象
- 旧数据没有 `correction` 字段，前端需要处理 `null` 情况

### 2. 单次纠错限制
- 每条 AI 消息只保存一次纠错结果
- 如需使用不同模型重新纠错，需先删除现有纠错（调用 DELETE API）
- 这是设计选择，避免数据膨胀

### 3. 性能考虑
- 纠错数据随任务详情一起加载，无需额外 API 调用
- `improved_answer` 可能很长，但 JSON 字段可以存储大文本

### 4. 分享任务
- 分享任务时，纠错数据会自动包含在 subtask.result 中
- 被分享者可以看到纠错结果

---

## 📊 预期效果

| 功能 | 变更前 | 变更后 |
|------|--------|--------|
| 刷新页面后保留纠错结果 | ❌ | ✅ |
| 查看历史纠错记录 | ❌ | ✅ |
| 分享任务包含纠错结果 | ❌ | ✅ |
| 避免重复调用 API | ❌ | ✅ |
| 需要数据库迁移 | - | ❌（无需） |
| 实现复杂度 | - | 低 |

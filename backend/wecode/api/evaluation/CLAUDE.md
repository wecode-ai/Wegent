# Evaluation API Development Guide

## 开发经验总结

### 1. Schema 字段同步规则

**添加新配置字段时，必须同步更新以下位置**:

1. **Schema 定义** (`wecode/schemas/evaluation.py`)
```python
class GradingConfigUpdate(BaseModel):
    team_id: Optional[int] = None
    auto_trigger: bool = False
    trigger_condition: str = "manual"
    grading_timeout: int = 3600
    prompt_template: Optional[str] = None
    model_id: Optional[str] = None                    # 新增
    force_override_bot_model: bool = False            # 新增
```

2. **API 保存逻辑** (`wecode/api/evaluation/author.py`)
```python
# 读取新字段
if config_update.model_id is not None:
    updated_config["model_id"] = config_update.model_id

# 返回新字段
return GradingConfigResponse(
    ...
    model_id=config_update.model_id,
    force_override_bot_model=config_update.force_override_bot_model,
)
```

3. **API 读取逻辑**
```python
return GradingConfigResponse(
    ...
    model_id=config.get("model_id"),
    force_override_bot_model=config.get("force_override_bot_model", False),
)
```

### 2. JSON 字段更新

**SQLAlchemy JSON 字段必须显式标记为已修改**:
```python
from sqlalchemy.orm.attributes import flag_modified

# 更新配置
topic.grading_team_config = updated_config
flag_modified(topic, "grading_team_config")  # 关键！
db.commit()
```

### 3. 可选字段处理

**使用 `is not None` 判断字段是否显式提供**:
```python
# 正确 - 区分 "未提供" 和 "提供空值"
if config_update.prompt_template is not None:
    updated_config["prompt_template"] = config_update.prompt_template

# 错误 - 无法区分未提供和空字符串
if config_update.prompt_template:
    updated_config["prompt_template"] = config_update.prompt_template
```

### 4. 响应模型继承

**GradingConfigResponse 继承 GradingConfigUpdate**:
```python
class GradingConfigResponse(GradingConfigUpdate):
    """Response schema for grading configuration."""
    team_name: Optional[str] = None
    team_valid: bool = True
```

**好处**: 自动继承父类的所有字段，只需添加响应特有的字段。

### 5. Batch API 设计

**批量操作请求体**:
```python
class BatchExecuteRequest(BaseModel):
    task_ids: List[int] = Field(..., description="List of task IDs to execute")
    team_id: Optional[int] = Field(None, description="Override team ID")
    model_id: Optional[str] = Field(None, description="Optional model ID")
    force_override_bot_model: bool = Field(False, description="Force override")
```

### 6. 错误处理

**使用 HTTPException 返回详细错误**:
```python
from fastapi import HTTPException, status

if not team:
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Team not found",
    )
```

### 7. 返回纯文本内容 (PlainTextResponse)

**问题**: FastAPI 默认会 JSON 序列化返回值，字符串会被包装成 `"content"` 而不是原始内容。

**错误示例**:
```python
from fastapi import APIRouter

router = APIRouter()

@router.get("/files/content")
def get_file_content():
    content = "执行步骤：\n\n步骤一..."
    return content  # ❌ 客户端收到: "执行步骤：\n\n步骤一..." (带引号的 JSON 字符串)
```

**正确做法**:
```python
from fastapi import APIRouter
from fastapi.responses import PlainTextResponse

router = APIRouter()

@router.get("/files/content", response_class=PlainTextResponse)
def get_file_content():
    content = "执行步骤：\n\n步骤一..."
    return PlainTextResponse(content=content)  # ✅ 客户端收到原始文本
```

**关键要点**:
1. 导入 `PlainTextResponse`
2. 在路由装饰器中指定 `response_class=PlainTextResponse`
3. 返回 `PlainTextResponse(content=content)` 而不是裸字符串

**适用场景**:
- 读取文件内容返回给前端显示
- 需要保持原始格式（换行、缩进）的文本内容
- 非 JSON 格式的 API 响应

## 目录结构

```
wecode/api/evaluation/
├── __init__.py
├── author.py       # 出题人 API (配置、题目管理)
├── grader.py       # 评分人 API (评分任务执行)
├── respondent.py   # 答题人 API (提交答案)
└── ...
```

## 调试技巧

### 检查请求体
```python
# 在 API 函数开头打印请求体
@router.put("/topics/{topic_id}/grading-config")
def update_grading_config(...):
    print(f"Received: {config_update.model_dump()}")  # 调试用
    ...
```

### 检查数据库
```python
# 查看实际存储的配置
config = topic.grading_team_config
print(f"Stored config: {config}")
```

## 常见错误

1. **AttributeError: object has no attribute 'model_id'** - Schema 未添加字段
2. **保存成功但读取为空** - 读取 API 未返回新字段
3. **JSON 字段未持久化** - 忘记调用 `flag_modified()`
4. **字段被重置为空** - 未正确处理可选字段的 `None` 值
5. **ImportError** - 删除了仍在使用的 import
6. **ValueError: too many values to unpack** - 修改了函数返回值数量

## 重构经验教训

### 7. 删除 Import 前检查使用情况

**问题**: 删除了 `get_question_service` 和 `get_topic_service` 的 import，但它们仍在文件中被多处使用。

**教训**:
```bash
# 删除 import 前，先检查是否被使用
grep -n "get_question_service\|get_topic_service" grader.py
```

**原则**: 删除 import 前，必须确认该模块名在文件中不再被使用。

### 8. 修改函数返回值的影响

**问题**: 修改 `_get_task_for_grading` 的返回值（从 4 个改为 3 个），导致所有调用方报错 `ValueError: too many values to unpack`。

**错误代码**:
```python
# 修改前：返回 4 个值
return task, question, topic, team_id

# 调用方
task, question, topic, team_id = _get_task_for_grading(...)

# 修改后：返回 3 个值 - 破坏调用方
return task, topic, team_id
```

**正确做法**:
- 修改返回值前，查找并更新所有调用方
- 或者创建新函数，保留旧函数做兼容

### 9. 提取公共函数时的依赖关系

**经验**: 提取 `_validate_task_access` 辅助函数时，要注意它依赖的外部函数（如 `_check_grader_permission`）。

**原则**:
- 提取的函数应该接收所需的数据作为参数，而不是依赖外部闭包
- 辅助函数应该纯逻辑，不涉及外部状态

### 10. 人工报告（human_report）的设计原则

**设计**: `human_report` 是一个永久可编辑的草稿，与发布状态无关。

**允许的操作**:
- **编辑 (update_report)**: 除 RUNNING 状态外，任何状态都可以编辑人工草稿
- **发布 (publish)**: 可以首次发布，也可以重新发布（更新已发布的报告）
- **重新发布**: PUBLISHED 状态的任务可以再次发布，用人工草稿更新 final_report

**状态限制**:
```python
# 更新报告 - 只禁止 RUNNING 状态
if task.status == GradingTaskStatus.RUNNING:
    raise HTTPException(detail="Cannot update tasks that are currently running")

# 发布报告 - 允许 COMPLETED, PUBLISHED, 以及有人工报告的 PENDING/FAILED
allowed_statuses = [GradingTaskStatus.COMPLETED, GradingTaskStatus.PUBLISHED]
if has_human_report:
    allowed_statuses.extend([GradingTaskStatus.PENDING, GradingTaskStatus.FAILED])
```

**用户流程**:
1. AI 评分完成 → status=COMPLETED
2. 用户编辑人工草稿 → 更新 human_report
3. 用户发布 → status=PUBLISHED, 创建 final_report
4. 用户发现需要修改 → 编辑 human_report（PUBLISHED 状态下仍可编辑）
5. 用户重新发布 → 更新 final_report

## 检查清单

添加新配置字段时:
- [ ] Schema (`GradingConfigUpdate`) 添加字段
- [ ] Schema (`GradingConfigResponse`) 继承关系检查
- [ ] 保存 API 处理新字段
- [ ] 读取 API 返回新字段
- [ ] 使用 `flag_modified()` 标记 JSON 字段
- [ ] 使用 `is not None` 判断可选字段

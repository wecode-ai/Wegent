# Evaluation Service Development Guide

## 开发经验总结 (基于评分功能迭代)

### 1. JSON 字段处理

**问题**: `content_data` 字段是 JSON 类型，但在某些情况下可能是字符串。

**解决方案**:
```python
# 始终添加防御性代码处理 JSON 字段
content_data = answer.content_data
if isinstance(content_data, str):
    try:
        content_data = json.loads(content_data) if content_data else {}
    except json.JSONDecodeError:
        content_data = {}
if not isinstance(content_data, dict):
    content_data = {}
```

### 2. 嵌套数据结构处理

**问题**: Attachments 是嵌套字典结构，不是简单列表。

**数据结构**:
```python
attachments: {
    "main": [...],
    "interaction": [...],
    "bonusAgent": {"files": [...], "link": "..."},
    "bonusMultimodal": [...]
}
```

**通用处理逻辑**:
```python
def _collect_from_slot(slot_value: Any) -> None:
    """Collect attachments from a slot value (list or dict with files)."""
    if isinstance(slot_value, list):
        _collect_from_list(slot_value)
    elif isinstance(slot_value, dict) and isinstance(slot_value.get("files"), list):
        _collect_from_list(slot_value["files"])

# 遍历所有 slots
for slot_name, slot_value in attachments_data.items():
    _collect_from_slot(slot_value)
```

### 3. 可配置提示词模板

**设计原则**:
- 默认模板保持简洁，保护用户隐私（不包含 user_name）
- 从 `topic.grading_team_config` 读取自定义模板
- 支持变量: `{user_id}`, `{grading_task_id}`, `{topic_id}`, `{question_id}`, `{question_title}`

**实现**:
```python
DEFAULT_PROMPT_TEMPLATE = """评测 {user_id} 号用户提交的报告"""

# 读取自定义模板
prompt_template = topic.grading_team_config.get("prompt_template")
template = prompt_template or DEFAULT_PROMPT_TEMPLATE

# 构建变量
template_vars = {
    "user_id": task.respondent_id,
    "grading_task_id": task.id,
    "topic_id": topic_id,
    "question_id": task.question_id,
    "question_title": question_title,
}
prompt = template.format(**template_vars)
```

### 4. 模型选择传递

**接口规范**:
- 复用现有的 `TaskCreationParams` 接口
- 字段命名: `model_id` + `force_override_bot_model`
- 与 WebSocket chat:send 保持一致

**传递链**:
```
API Schema -> grading_service.execute() -> TaskCreationParams -> create_chat_task()
```

### 5. Schema 字段同步

**容易犯的错误**: 更新 API 时忘记同步所有相关 Schema。

**必须同步的地方**:
1. `GradingConfigUpdate` - 请求体 Schema
2. `GradingConfigResponse` - 响应体 Schema
3. `update_grading_config()` - 保存逻辑
4. `get_grading_config()` - 读取逻辑

**检查清单**:
- [ ] Schema 中添加了新字段
- [ ] API 处理函数中保存了新字段
- [ ] API 处理函数中返回了新字段
- [ ] 数据库 JSON 字段正确更新（使用 `flag_modified`）

### 6. 模块导入规则

**重要**: evaluation 模块内的导入必须在文件顶部，禁止在方法内导入。

**正确做法**:
```python
# 文件顶部导入
from wecode.service.evaluation.topic_service import TopicService

class GradingService:
    def execute(self, ...):
        topic_service = TopicService()  # 实例化在方法内
```

**错误做法**:
```python
class GradingService:
    def execute(self, ...):
        import json  # 禁止！
        from wecode.service.evaluation.topic_service import TopicService  # 禁止！
```

### 7. 代码文件组织

**要求**:
- 文件不超过 1000 行
- 函数不超过 50 行
- 相关功能放在同一模块

## 调试技巧

### 查看日志
```bash
# 后端日志
tail -f .pids/backend.log | grep -i evaluation

# 查找特定任务日志
tail -f .pids/backend.log | grep "task 30"
```

### 数据库查询
```bash
# 连接数据库
mysql -h <host> -P <port> -u <user> -p<pass> -D wegent

# 查看任务状态
SELECT id, kind, title, status FROM tasks WHERE id IN (70, 72);

# 查看子任务
SELECT t.id, s.id as subtask_id, s.role, s.status
FROM tasks t
LEFT JOIN subtasks s ON t.id = s.task_id
WHERE t.id IN (70, 72);
```

## 常见错误

1. **'str' object has no attribute 'get'** - JSON 字段未正确解析
2. **AttributeError: object has no attribute 'model_id'** - Schema 字段未同步
3. **i18n missingKey** - 翻译键值未添加到 evaluation.json
4. **保存成功但刷新为空** - 读取 API 未返回新字段
5. **Event loop is closed** - 后台线程中操作已关闭的事件循环
6. **Content truncated due to max_token limit** - max_tokens 配置未生效

## 重构经验教训

### 8. 禁止修改 app/services/ 目录

**红线**: 不要修改 `backend/app/services/` 下的任何文件。

**原因**:
- 该目录是核心服务层，修改可能产生不可预知的影响
- evaluation 模块应只依赖于自身的 service 层
- 如需修改核心逻辑，应该由用户明确指示

**正确做法**:
- 在 `wecode/service/evaluation/` 内实现功能
- 通过扩展或包装方式复用核心服务
- 遇到问题先询问用户，而不是直接修改核心代码

### 9. 方法删除前检查调用链

**问题**: 删除 `_get_topic_id_from_task` 和 `_get_question_title` 后，`_save_report_to_s3` 调用失败。

**教训**:
```bash
# 删除方法前，先检查所有调用点
grep -rn "_get_topic_id_from_task\|_get_question_title" /Users/jiangyang7/Developer/wegent/backend/wecode/service/evaluation/
```

**原则**: 删除方法前，必须确认所有调用点都被处理。

### 10. make_transient() 的正确使用

**问题**: 调用 `make_transient()` 后仍尝试 `db.refresh()` 导致错误。

**错误代码**:
```python
make_transient(assistant_subtask)
# ... 之后尝试 ...
db.refresh(assistant_subtask)  # 报错！对象已分离
```

**正确做法**:
```python
# 1. 先刷新确保最新状态
db.refresh(assistant_subtask)

# 2. 提取需要的值
subtask_id = assistant_subtask.id

# 3. 再标记为 transient
make_transient(assistant_subtask)

# 4. 之后通过 ID 重新查询
assistant_subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
```

### 11. 模型配置的字段位置

**问题**: `maxOutputTokens` 配置在 Model CRD spec 根级别，但代码从 `modelConfig` 内部读取 `max_output_tokens`。

**Model CRD 结构**:
```yaml
spec:
  modelConfig:
    env:
      model: claude-opus-4.5
      api_key: xxx
    max_output_tokens: 128000  # 代码实际读取的位置
    context_window: 200000
  maxOutputTokens: 128000  # 根级别，代码不读取
```

**教训**: 配置模型参数时，必须确认代码实际读取的字段路径。

### 12. 返回值变更的影响范围

**问题**: 修改 `_get_task_for_grading` 返回值（从 4 个值改为 3 个），导致所有调用方报错。

**教训**:
- 修改函数签名或返回值前，检查所有调用点
- 使用类型提示和文档字符串明确返回值
- 考虑新建函数而非修改现有函数

```python
# 修改前：返回 4 个值
def _get_task_for_grading(...) -> tuple[Task, Question, Topic, int]:
    return task, question, topic, team_id

# 修改后：返回 3 个值 - 这会破坏所有调用方
def _get_task_for_grading(...) -> tuple[Task, Topic, int]:
    return task, topic, team_id
```

### 13. 后台线程数据可见性问题 - SQLAlchemy flush vs commit

**问题**: 主线程创建评分任务并启动后台线程执行评分，但后台线程使用新的 Session 查询不到刚创建的任务。

**日志现象**:
```
[Evaluation] Starting grading execution for task 31
[Evaluation] Grading task 31 not found (attempt 1/5), retrying...
...
[Evaluation] Grading task 31 not found after retries
```

**根本原因**:
- `db.flush()` 只是将 SQL 语句发送到数据库，但**事务未提交**
- 其他数据库连接（新 Session）看不到未提交的数据
- `db.commit()` 才是真正的提交事务，使数据对其他连接可见

**错误代码**:
```python
def execute(self, db: Session, task: EvalGradingTask, ...):
    task.status = GradingTaskStatus.RUNNING
    db.flush()  # ❌ 只 flush 不 commit，事务未结束

    # 启动后台线程
    threading.Thread(target=run_in_thread).start()
    # 后台线程用新 Session 查询，看不到未提交的数据！
```

**正确做法**:
```python
def execute(self, db: Session, task: EvalGradingTask, ...):
    task.status = GradingTaskStatus.RUNNING
    db.flush()
    db.commit()  # ✅ 立即提交，使数据对其他连接可见

    # 启动后台线程
    threading.Thread(target=run_in_thread).start()
    # 后台线程可以正常查询到数据
```

**教训**:
- `flush()` ≠ `commit()`：`flush` 只是预执行 SQL，`commit` 才是真正的提交
- 跨线程访问数据时，必须确保主线程已提交事务
- 使用 `SessionLocal()` 创建的新 Session 是独立事务，只能看到已提交的数据
- 在需要数据立即可见的场景，要及时调用 `commit()`

### 14. 评分任务恢复时的报告内容提取

**问题**: 监控服务恢复 stuck 的评分任务时，显示 "AI grading completed (recovered)" 而不是实际的 AI 报告内容。

**原因**: `grading_monitor.py` 中的 `get_wegent_task_state` 方法只检查 `result_data.get("text", "")`，但实际的 AI 结果可能存储在其他字段（如 `content`、`result`、`value`）。

**修复前代码**:
```python
# grading_monitor.py:155
if isinstance(result_data, dict):
    result_content = result_data.get("text", "")  # 只检查 text 字段
```

**修复后代码**:
```python
if isinstance(result_data, dict):
    # 尝试多个可能的字段
    result_content = (
        result_data.get("text")
        or result_data.get("content")
        or result_data.get("result")
        or result_data.get("value")
        or result_data.get("message")
        or ""
    )
```

**前端处理**: 当检测到内容为 "AI grading completed (recovered)" 时，显示提示信息和跳转到聊天任务的按钮：
```tsx
{aiContent === 'AI grading completed (recovered)' ? (
  <div className="flex flex-col items-center gap-4 py-8">
    <p>{t('grading.ai_recovered_message')}</p>
    <Button onClick={() => router.push(`/chat?taskId=${gradingTask.task_id}`)}>
      {t('grading.view_chat_task')}
    </Button>
  </div>
) : (
  <EnhancedMarkdown source={aiContent} ... />
)}
```

**教训**:
- AI 返回的结果数据结构可能不固定，需要尝试多个字段
- 恢复任务时应该尽可能提取实际内容，而不是使用占位符
- 前端应该优雅处理异常情况，提供替代查看方式

### 15. 评分任务并发控制 - 防止旧任务覆盖新结果

**问题**: 用户多次点击重试时，旧任务的执行结果可能覆盖新任务的结果。

**解决方案**: 在写入 AI 报告前检查 task_id 是否匹配。

**核心逻辑**:
```python
# _monitor_and_finalize 方法在更新结果前检查
if grading_task.task_id != chat_task_id:
    logger.warning(
        f"Grading task {grading_task_id} has a newer chat task "
        f"({grading_task.task_id} != {chat_task_id}). Discarding stale result."
    )
    return  # 丢弃旧结果，不更新

# 只有 task_id 匹配才更新结果
self.complete(db, grading_task, full_response)
```

**设计原则**:
- AI 报告、人工报告、发布报告是三个独立的报告
- 重试评分只影响 AI 报告，不影响已发布的人工报告
- PUBLISHED 状态也可以重试 AI 评分（生成新的 AI 报告，但不自动发布）
- 前端根据 `team_id > 0` 判断是否显示评分按钮

**前端实现**:
```tsx
{gradingTask.team_id > 0 && (
  <Button variant="outline" onClick={handleRetry} disabled={executing}>
    <RotateCcw className="mr-2 h-4 w-4" />
    {t('grading.retry')}
  </Button>
)}
```

**教训**:
- 后台任务必须考虑并发和时序问题
- 使用 task_id 版本控制防止旧数据覆盖新数据
- UI 应根据配置状态（team_id）动态显示操作按钮

### 16. SQLAlchemy Session 跨线程传递问题（重构经验）

**问题**: 重构 GradingService 为 Strategy Pattern 后，评分任务卡在 "待处理" 或 "进行中" 状态，后台线程报数据库连接错误（"Packet sequence number wrong"、"Instance is not persistent within this Session"）。

**根本原因**: SQLAlchemy Session 不是线程安全的，不能跨线程传递。重构前代码在后台线程创建新 Session，重构后误将主线程的 Session 和 ORM 对象通过 Context 传递给后台线程。

**错误模式**:
```python
# ❌ 错误：将主线程的 db session 和 ORM 对象传给后台线程
ctx = GradingContext(
    db=db,  # 主线程的 session！
    task=task,  # 绑定到主线程 session 的 ORM 对象
    user=user,
    ...
)
# 后台线程使用 ctx.db 或访问 ctx.task.id 会触发懒加载，导致 session 冲突
```

**正确模式**:
```python
# ✅ 正确：Context 只传递基本类型（ID），后台线程自己查询
ctx = GradingContext(
    task_id=task.id,  # 只传 ID
    user_id=user_id,
    team_id=team.id,
    ...
)

# 后台线程创建自己的 session
db = SessionLocal()
task = db.query(EvalGradingTask).filter(...).first()  # 自己查询
```

**关键原则**:
- **绝不传递 Session**: GradingContext 不包含 `db` 字段
- **绝不传递 ORM 对象**: 只传递 `task_id` 而非 `task` 对象
- **每个并发任务独立 Session**: 多个 scorer 并行时，每个 scorer 创建自己的 Session
- **主线程负责状态更新**: 启动后台线程前，主线程完成状态更新并 commit

**检查清单**:
- [ ] Context 对象只包含基本类型（int, str, bool）
- [ ] 后台线程使用 `SessionLocal()` 创建自己的 session
- [ ] 并发任务（如多个 scorer）各自创建独立 session
- [ ] 主线程在启动后台线程前完成所有状态更新并 commit

### 17. SQLAlchemy Session 缓存导致轮询看不到数据更新

**问题**: `_wait_for_subtask_completion` 方法轮询 subtask 状态时，即使其他 session 已将 subtask 标记为 COMPLETED，当前 session 仍看到旧状态（PENDING/RUNNING），导致无限等待。

**根本原因**: SQLAlchemy Session 默认会缓存查询结果。在同一个 session 中重复查询同一对象时，返回的是缓存的实例，而非数据库最新数据。

**错误代码**:
```python
while elapsed < timeout:
    # 每次都返回缓存的实例，看不到其他 session 的更新
    subtask = db.query(Subtask).filter(Subtask.id == id).first()
    if subtask.status == SubtaskStatus.COMPLETED:  # 可能永远是旧状态
        break
    await asyncio.sleep(5)
```

**正确做法**:
```python
while elapsed < timeout:
    # 强制过期所有对象，下次查询从数据库重新加载
    db.expire_all()

    subtask = db.query(Subtask).filter(Subtask.id == id).first()
    if subtask.status == SubtaskStatus.COMPLETED:
        break
    await asyncio.sleep(5)
```

**其他解决方案**:
- `db.refresh(subtask)`: 刷新特定对象
- `db.expire(subtask)`: 过期特定对象
- 每次查询前 `db.rollback()`: 清除事务并重新开始

**教训**:
- 轮询数据库状态时，必须处理 SQLAlchemy 事务隔离问题
- MySQL 默认隔离级别是 `REPEATABLE READ`，同一事务内只能看到第一次查询时的数据快照
- 长时间运行的后台任务中，事务隔离是导致看不到其他 session 更新的常见原因

**正确做法**:

```python
# 在轮询开始前提交当前事务
# 这样后续查询能看到其他 session 的更新
db.commit()

while elapsed < timeout:
    db.expire_all()
    subtask = db.query(Subtask).filter(Subtask.id == id).first()
    if subtask.status == SubtaskStatus.COMPLETED:
        break
    await asyncio.sleep(5)
```

**原因**:
- MySQL 默认 `REPEATABLE READ`：同一事务中，第一次查询后创建数据快照
- 后续查询（即使 `expire_all()`）仍只能看到该快照，看不到其他 session 的新提交
- `db.commit()` 结束当前事务，下次查询开启新事务，能看到最新数据

**注意**: 如果当前 session 有未提交的修改，需要在此之前保存它们。

### 18. create_chat_task 的 should_trigger_ai 参数含义

**问题**: 误以为 `create_chat_task` 的 `should_trigger_ai=True` 会自动触发 AI 响应，结果聊天任务卡在 PENDING 状态。

**根本原因**: `should_trigger_ai` 参数只控制是否创建 ASSISTANT subtask，**不会**实际触发 AI 响应。真正触发 AI 需要调用 `trigger_ai_response_unified`。

**错误代码**:
```python
# 错误：只创建任务，不触发 AI
chat_result = await create_chat_task(
    db=db, user=user, team=team, message=prompt,
    params=task_params, task_id=None, should_trigger_ai=True, source="evaluation",
)
# AI 不会被触发，subtask 卡在 PENDING！
content, error = await self._wait_for_subtask_completion(db, assistant_subtask.id)
```

**正确做法**:
```python
# 正确：创建任务后手动触发 AI
chat_result = await create_chat_task(
    db=db, user=user, team=team, message=prompt,
    params=task_params, task_id=None, should_trigger_ai=True, source="evaluation",
)

# 必须手动触发 AI 响应
await self._trigger_ai_response(
    db, chat_result.task, chat_result.user_subtask,
    chat_result.assistant_subtask, team, user, prompt
)

# 然后等待 AI 完成
content, error = await self._wait_for_subtask_completion(
    db, chat_result.assistant_subtask.id, timeout=remaining_timeout
)
```

**教训**:
- `should_trigger_ai=True` 只创建 ASSISTANT subtask，不触发 AI
- 需要显式调用 `trigger_ai_response_unified` 来触发 AI
- 参考 `SingleModelStrategy._trigger_ai_response` 实现

---
最后更新：2026-03-19
经验版本：1.3

# 任务分享功能 (Task Sharing Feature)

## 功能概述

任务分享功能允许用户将自己的任务(包含完整的对话历史)分享给其他用户。其他用户可以：
1. **无需登录查看**：通过分享链接直接查看完整的对话历史（只读）
2. **登录后复制**：登录后可以将任务复制到自己的任务列表中，并继续对话

这个功能类似于 ChatGPT 的对话分享功能，让团队协作和知识共享更加便捷。

## 核心特性

### 两种分享模式

#### 🌐 公开只读分享（推荐）
- ✅ **无需登录**即可查看完整对话历史
- ✅ **只读模式**：不包含敏感信息（团队配置、Bot 详情等）
- ✅ **引导登录**：提供"登录并复制"按钮
- ✅ **安全可控**：独立 API 端点，只返回必要的公开数据
- ✅ **用户体验好**：清晰的页面提示和操作引导

#### 🔒 登录用户复制
- 🔑 **需要登录**才能访问
- ✅ **选择团队**：可以选择将任务复制到哪个团队
- ✅ **完整历史**：包含所有对话、附件和消息链
- ✅ **自动打开**：复制后自动打开新任务
- ✅ **列表刷新**：复制后任务列表自动更新

### 其他特性
- ✅ **生成加密分享链接** - 使用AES-256-CBC加密保护分享令牌
- ✅ **权限控制** - 只有持有分享链接的人才能访问
- ✅ **防重复复制** - 同一用户不能重复复制同一个任务
- ✅ **状态管理** - 所有复制的子任务标记为 COMPLETED 状态

## 使用流程

### 完整分享流程

```
用户 A 分享任务
    ↓
生成分享链接（加密 token）
    ↓
用户 B 访问 /shared/task?token=xxx（无需登录）
    ↓
查看完整对话历史（只读）
    ↓
点击"登录并复制"按钮
    ↓
跳转到登录页面
    ↓
登录成功后自动跳转到 /chat?taskShare=xxx
    ↓
弹出复制确认弹窗，选择团队
    ↓
点击"复制到我的任务"
    ↓
复制成功，自动打开新任务
    ↓
任务列表自动刷新
```

### 1. 分享任务

1. 在聊天页面选择一个已有对话的任务
2. 点击消息区域顶部的 **"Share Task"** 按钮
3. 系统生成加密分享链接
4. 点击 **"Copy Link"** 复制链接

分享链接格式：
```
http://localhost:3000/shared/task?token=test123dEA%3D%3D
```

### 2. 查看分享（无需登录）

1. 其他用户打开分享链接
2. 进入公开只读页面 `/shared/task?token=xxx`
3. 可以查看：
   - 任务标题
   - 分享者名称
   - 完整对话历史（用户消息 + AI 回复）
   - 所有消息的时间顺序
4. 页面顶部和底部都有"登录并复制"按钮
5. 页面提示这是只读分享，需要登录才能复制和继续对话

### 3. 登录并复制任务

1. 点击"登录并复制"按钮
2. 跳转到登录页面（token 保存在 localStorage）
3. 登录成功后自动跳转到 `/chat?taskShare=xxx`
4. 弹出任务复制确认弹窗，显示：
   - 分享者名称
   - 任务标题
   - 复制说明
   - 团队选择下拉框
5. 选择要复制到的团队
6. 点击 **"Copy to My Tasks"** 按钮
7. 复制成功后：
   - 任务列表自动刷新
   - 自动跳转到新任务的聊天页面
   - 可以继续基于历史对话进行交互

### 4. 继续对话

复制的任务包含:
- 原始任务的所有对话历史
- 所有附件(如果有)
- 完整的消息链
- **所有子任务状态设为 COMPLETED**（不会重新执行）

用户可以像操作普通任务一样继续发送消息，基于已有的对话历史进行追加聊天。

## 技术实现

### 后端实现

#### 数据模型

**SharedTask 表结构:**
```sql
CREATE TABLE shared_tasks (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT NOT NULL,                  -- 复制任务的用户
    original_user_id INT NOT NULL,         -- 原始分享者
    original_task_id INT NOT NULL,         -- 原始任务ID
    copied_task_id INT,                    -- 复制后的新任务ID
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME,
    updated_at DATETIME,
    UNIQUE(user_id, original_task_id)      -- 同一用户只能复制一次
);
```

#### API接口

**1. 生成分享链接**
```
POST /api/tasks/{task_id}/share
需要认证：是
Response: {
  "share_url": "http://localhost:3000/shared/task?token=test123dEA%3D%3D",
  "share_token": "test123dEA%3D%3D"
}
```

**2. 获取分享信息（用于复制弹窗）**
```
GET /api/tasks/share/info?share_token=<token>
需要认证：否
Response: {
  "user_id": 1,
  "user_name": "Alice",
  "task_id": 123,
  "task_title": "My Task"
}
```

**3. 获取公开分享任务（用于只读页面）**
```
GET /api/tasks/share/public?token=<token>
需要认证：否（公开访问）
Response: {
  "task_title": "My Task",
  "sharer_name": "Alice",
  "sharer_id": 1,
  "subtasks": [
    {
      "id": 1,
      "role": "USER",
      "prompt": "Hello, can you help me?",
      "result": null,
      "status": "COMPLETED",
      "created_at": "2025-12-04T10:00:00Z",
      "updated_at": "2025-12-04T10:00:01Z"
    },
    {
      "id": 2,
      "role": "AI",
      "prompt": "",
      "result": {"value": "Of course! How can I assist you?"},
      "status": "COMPLETED",
      "created_at": "2025-12-04T10:00:02Z",
      "updated_at": "2025-12-04T10:00:05Z"
    }
  ],
  "created_at": "2025-12-04T10:00:00Z"
}

注意：此接口只返回公开数据，不包含：
- 团队配置信息
- Bot 详情
- 敏感的系统配置
- 用户个人信息（除了分享者名称）
```

**4. 复制分享任务**
```
POST /api/tasks/share/join
需要认证：是
Body: {
  "share_token": "<token>",
  "team_id": 5  // 可选，不提供则使用用户第一个团队
}
Response: {
  "message": "Successfully copied shared task to your task list",
  "task_id": 456  // 新任务ID
}
```

#### 加密机制

- **算法**: AES-256-CBC
- **令牌格式**: `{user_id}#{task_id}` → AES加密 → Base64编码 → URL编码
- **密钥管理**: 通过环境变量配置 `SHARE_TOKEN_AES_KEY` 和 `SHARE_TOKEN_AES_IV`
- **解密验证**:
  1. URL解码
  2. Base64解码
  3. AES解密
  4. 验证格式和数据库存在性

#### 核心服务方法

**SharedTaskService (`backend/app/services/shared_task.py`):**

1. `generate_share_token(user_id, task_id)` - 生成加密分享令牌
2. `decode_share_token(share_token, db)` - 解密令牌获取任务信息
3. `generate_share_url(share_token)` - 生成完整分享URL（指向 `/shared/task` 页面）
4. `share_task(db, task_id, user_id)` - 创建任务分享
5. `get_share_info(db, share_token)` - 获取分享基本信息（用于复制确认弹窗）
6. `get_public_shared_task(db, share_token)` - 获取公开任务数据（用于只读页面，无需认证）
7. `join_shared_task(db, share_token, user_id, team_id)` - 复制任务到用户账户
8. `_copy_task_with_subtasks(db, original_task, new_user_id, new_team_id)` - 复制任务及所有子任务和附件

**任务复制逻辑：**
- 创建新的 Kind 记录（Task 类型），名称前缀 "Copy of"
- 复制所有 Subtask 记录，保持 message_id 和 parent_id 关系
- **所有子任务状态设为 COMPLETED，progress = 100**（避免重新执行）
- 复制所有 SubtaskAttachment（包括二进制数据和图片）
- 创建 SharedTask 记录，建立复制关系
- 防止重复复制（UNIQUE 约束）

### 前端实现

#### 页面路由

**1. 公开只读分享页面（无需登录）**
- 路由：`/shared/task`
- 文件：`frontend/src/app/shared/task/page.tsx`
- 功能：
  - 展示完整对话历史
  - 显示分享者信息和任务标题
  - 使用与聊天页面相同的布局结构（包含侧边栏）
  - 简化侧边栏显示当前分享任务和登录引导
  - 提供"登录并复制"按钮（顶部导航栏、侧边栏、底部CTA）
  - 点击按钮后保存 token 到 localStorage 并跳转登录
  - 登录后自动跳转到 `/chat?taskShare=xxx`

**2. 登录用户复制页面**
- 路由：`/chat?taskShare=xxx`
- 组件：`TaskShareHandler`（在 `/chat` 页面中使用）
- 功能：
  - 检测 URL 参数 `taskShare`
  - 获取团队列表
  - 显示复制确认弹窗
  - 选择团队并执行复制
  - 复制成功后刷新任务列表并打开新任务

#### 核心组件

**1. SharedTaskPage (`frontend/src/app/shared/task/page.tsx`)**
```typescript
功能：
- 无需登录的公开分享页面
- 调用 taskApis.getPublicSharedTask(token) 获取数据
- 使用与聊天页面相同的布局结构（ResizableSidebar + 主内容区）
- 渲染对话历史（用户消息 + AI 回复）
- 使用 MarkdownEditor 渲染 AI 回复
- 提供"登录并复制"CTA 按钮（多个位置）
- 点击按钮保存 token 到 localStorage，跳转到 /login?redirect=/chat
```

**2. PublicTaskSidebar (`frontend/src/features/tasks/components/PublicTaskSidebar.tsx`)**
```typescript
功能：
- 简化侧边栏专为公开分享页面设计
- 显示 Wegent Logo
- 显示当前分享任务（标题和分享者）
- 提供"Login to see your tasks"按钮
- 显示只读视图提示信息框
- 底部提供"Login & Copy Task"按钮
- 所有按钮都调用同一个 onLoginClick 处理函数
```

**3. TaskShareHandler (`frontend/src/features/tasks/components/TaskShareHandler.tsx`)**
```typescript
功能：
- 检测 URL 参数 taskShare
- 并行获取分享信息和团队列表
- 显示复制确认弹窗（Modal）
- 团队选择下拉框
- 自我分享检测（不能复制自己的任务）
- 调用 taskApis.joinSharedTask() 执行复制
- 复制成功后：
  1. 调用 onTaskCopied() 刷新任务列表
  2. 导航到 /chat?taskId={newTaskId}
  3. 清理 URL 参数
```

**4. 登录后自动跳转 (`frontend/src/app/(tasks)/chat/page.tsx`)**
```typescript
功能：
- 检查 localStorage 中的 pendingTaskShare
- 如果存在，清除并跳转到 /chat?taskShare={token}
- 这样登录后会自动触发 TaskShareHandler
```

**5. MessagesArea 中的分享按钮**
```typescript
功能：
- 在有消息的情况下显示 "Share Task" 按钮
- 点击调用 taskApis.shareTask(taskId)
- 显示 TaskShareModal 展示分享链接
- 提供一键复制链接功能
```

#### API 客户端

**taskApis (`frontend/src/apis/tasks.ts`):**

```typescript
shareTask(taskId: number): Promise<TaskShareResponse>
getTaskShareInfo(shareToken: string): Promise<TaskShareInfo>
getPublicSharedTask(token: string): Promise<PublicSharedTaskResponse>
joinSharedTask(request: JoinSharedTaskRequest): Promise<JoinSharedTaskResponse>
```

### 状态管理

**useTaskContext 集成：**
- `TaskShareHandler` 接收 `onTaskCopied` 回调
- 复制成功后调用 `refreshTasks()` 更新任务列表
- 新任务立即出现在侧边栏

**URL 参数处理：**
- `taskShare` - 用于触发复制确认弹窗
- `token` - 用于公开只读页面
- `taskId` - 用于打开特定任务

## 安全考虑

### 已实施的安全措施

1. **加密令牌**
   - 使用 AES-256-CBC 加密
   - URL 编码避免特殊字符问题
   - 令牌无法直接解析出 user_id 和 task_id

2. **访问控制**
   - 公开只读页面：只返回必要的公开数据
   - 复制操作：需要登录认证
   - 团队验证：只能复制到自己的团队

3. **防重复机制**
   - 数据库 UNIQUE 约束：`(user_id, original_task_id)`
   - 同一用户不能重复复制同一任务
   - 前端和后端双重检查

4. **数据验证**
   - 验证任务存在性和激活状态
   - 验证原始用户存在性
   - 验证分享者不是自己

5. **无敏感信息泄露**
   - 公开 API 不返回团队配置
   - 不返回 Bot 详细信息
   - 不返回其他用户信息

### 潜在风险和改进建议

1. **链接有效期**
   - 当前：永久有效
   - 建议：添加过期时间或访问次数限制

2. **访问日志**
   - 当前：无访问记录
   - 建议：记录分享链接的访问情况

3. **Rate Limiting**
   - 当前：无限制
   - 建议：添加访问频率限制，防止滥用

4. **撤销分享**
   - 当前：无法撤销已分享的链接
   - 建议：添加撤销分享功能

## 用户界面

### 分享任务界面

![Share Task Button](share-task-button.png)
- 位置：聊天消息区域顶部
- 样式：带 Share2 图标的按钮
- 显示条件：有消息时显示

### 公开只读分享页面

```
┌──────────────┬──────────────────────────────────────────┐
│  [Logo]      │ [Share Icon] Task Title    [Login & Copy]│
│  Wegent      │ Shared by Alice                          │
│              ├──────────────────────────────────────────┤
│ [Login...]   │ ℹ️ This is a read-only shared...         │
│              ├──────────────────────────────────────────┤
│  Shared Task │                                          │
│  ┌─────────┐ │ [User Message]                           │
│  │ 📝 Task │ │ "Hello, can you help me?"                │
│  │ Title   │ │                                          │
│  │ by Alice│ │ [AI Response]                            │
│  └─────────┘ │ "Of course! How can I assist you?"       │
│              │                                          │
│  ℹ️ Read-only│ ...more messages...                      │
│  view        │                                          │
│  Login to... │                                          │
│              ├──────────────────────────────────────────┤
│              │ Want to continue? [Login & Copy Tasks]   │
│ [Login &     │                                          │
│  Copy Task]  │                                          │
└──────────────┴──────────────────────────────────────────┘
```

功能说明：
- **左侧边栏**：显示Logo、当前分享任务、只读提示、登录按钮
- **顶部导航栏**：显示任务标题、分享者、GitHub Star 按钮、登录按钮
- **主内容区**：只读提示、完整对话历史、底部CTA
- **侧边栏可调整大小**：使用 ResizableSidebar 组件，与聊天页面一致

### 复制确认弹窗

```
┌─────────────────────────────────────────────────────┐
│ Shared Task                                     [X] │
├─────────────────────────────────────────────────────┤
│                                                       │
│ Alice shared the task "My Task" with you             │
│                                                       │
│ ℹ️ Copying this task will add all conversation       │
│    history to your task list.                        │
│                                                       │
│ Select Team:                                          │
│ [My Team ▼]                                          │
│                                                       │
│ [Cancel]                    [Copy to My Tasks]      │
└─────────────────────────────────────────────────────┘
```

### 分享链接弹窗

```
┌─────────────────────────────────────────────────────┐
│ Share Task                                      [X] │
├─────────────────────────────────────────────────────┤
│                                                       │
│ Share this link:                                     │
│ ┌───────────────────────────────────────────────┐  │
│ │ https://app.com/shared/task?token=xxx         │  │
│ └───────────────────────────────────────────────┘  │
│                               [Copy Link] [Copied!] │
│                                                       │
│ Anyone with this link can view your conversation    │
│ history. They can login to copy and continue.       │
│                                                       │
└─────────────────────────────────────────────────────┘
```

## 测试场景

### 功能测试

1. **生成分享链接**
   - ✅ 点击 Share Task 按钮
   - ✅ 显示分享链接弹窗
   - ✅ 复制链接到剪贴板
   - ✅ 链接格式正确

2. **公开查看（未登录）**
   - ✅ 访问分享链接
   - ✅ 显示完整对话历史
   - ✅ 显示分享者信息
   - ✅ 不包含敏感信息
   - ✅ 显示"登录并复制"按钮

3. **登录流程**
   - ✅ 点击"登录并复制"
   - ✅ token 保存到 localStorage
   - ✅ 跳转到登录页面
   - ✅ 登录成功后自动跳转到 `/chat?taskShare=xxx`
   - ✅ localStorage 中的 token 被清除

4. **复制任务**
   - ✅ 显示复制确认弹窗
   - ✅ 团队列表正确加载
   - ✅ 自动选择第一个团队
   - ✅ 可以切换团队
   - ✅ 点击复制按钮执行复制
   - ✅ 复制成功提示
   - ✅ 任务列表自动刷新
   - ✅ 自动打开新任务

5. **复制的任务验证**
   - ✅ 包含所有历史消息
   - ✅ 包含所有附件
   - ✅ 消息顺序正确
   - ✅ 任务标题前缀 "Copy of"
   - ✅ 所有子任务状态为 COMPLETED

6. **边界情况**
   - ✅ 无效 token 显示错误
   - ✅ 已删除的任务显示错误
   - ✅ 自己分享的任务提示不能复制
   - ✅ 重复复制同一任务被阻止
   - ✅ 无团队时不能复制

### 安全测试

1. **令牌安全**
   - ✅ 令牌加密正确
   - ✅ 无法从令牌反推原始信息
   - ✅ 修改令牌导致解密失败

2. **权限控制**
   - ✅ 公开页面无需认证
   - ✅ 复制操作需要认证
   - ✅ 不能复制到别人的团队

3. **数据隔离**
   - ✅ 公开 API 不返回敏感信息
   - ✅ 不同用户的数据隔离
   - ✅ 任务关联正确

## 常见问题

**Q: 分享链接会过期吗?**
A: 当前版本的分享链接不会过期,只要原始任务和用户存在,链接就一直有效。

**Q: 可以分享正在运行中的任务吗?**
A: 可以。但建议等任务完成后再分享,这样接收者能看到完整的对话历史。

**Q: 复制的任务会重新执行吗？**
A: 不会。所有复制的子任务状态都设为 COMPLETED，不会重新执行。用户只能基于历史继续新的对话。

**Q: 可以撤销分享吗？**
A: 当前版本不支持撤销已分享的链接。建议在分享前确认内容。

**Q: 分享链接能被搜索引擎索引吗？**
A: 不会。分享页面没有 SEO 优化，且需要加密 token 才能访问。

**Q: 为什么要两个页面？**
A:
- `/shared/task` 提供无需登录的公开访问，用户体验更好
- `/chat?taskShare=xxx` 用于已登录用户直接复制，功能更完整
- 这种设计既方便分享查看，又保证了数据安全

---

**实现完成时间**: 2025-12-04
**参考**: 类似ChatGPT的分享功能，增加了公开只读页面和登录引导流程

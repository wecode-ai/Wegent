实现一个**消息转发与工作队列系统**，允许用户将对话中的消息发送给其他用户，接收者通过"工作队列"管理收到的消息，并可配置智能体自动处理。

---

## 一、数据模型设计

### 1.1 工作队列 (WorkQueue)

创建新的 CRD 资源类型 `WorkQueue`，存储在 `kinds` 表中：

```yaml
apiVersion: agent.wecode.io/v1
kind: WorkQueue
metadata:
  name: string           # 队列名称
  namespace: string      # 命名空间
spec:
  displayName: string    # 显示名称
  description: string    # 队列描述
  isDefault: boolean     # 是否为默认队列
  ownerType: enum        # user | group (队列所有者类型)
  groupId: string        # 当 ownerType=group 时，关联的群组 ID
  visibility: enum       # private | public | group_visible | invite_only
  visibleToGroups: []    # 当 visibility=group_visible 时，可见的群组ID列表
  inviteCode: string     # 当 visibility=invite_only 时的邀请码
  
  # 自动处理配置
  autoProcess:
    enabled: boolean     # 是否启用自动处理
    teamRef:             # 处理消息的智能体引用
      namespace: string
      name: string
    triggerMode: enum    # immediate | manual | scheduled | condition_based
    scheduleInterval: number  # 定时处理间隔(分钟)，最小15分钟
    conditions:          # 条件触发规则
      - type: enum       # priority_high | specific_sender
        value: string    # 条件值（如发送者user_id）
        action: enum     # immediate | skip
    
  # 结果反馈配置
  resultFeedback:
    replyToSender: boolean      # 是否自动回复发送者
    saveInQueue: boolean        # 是否保存处理结果到队列
    sendNotification: boolean   # 是否发送通知
```

### 1.2 队列消息 (QueueMessage)

创建新表 `queue_messages` 存储转发的消息：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | bigint | 主键 |
| queue_id | bigint | 所属队列 ID (关联 kinds 表) |
| sender_user_id | bigint | 发送者用户 ID |
| recipient_user_id | bigint | 接收者用户 ID (队列所有者，组队列时为 null) |
| recipient_group_id | bigint | 接收者群组 ID (组队列时使用) |
| source_task_id | bigint | 原始对话任务 ID |
| source_subtask_ids | json | 原始消息 ID 列表 |
| content_snapshot | json | 消息内容快照（包含消息文本、附件等） |
| note | text | 发送者附加的备注说明 |
| priority | enum | low | normal | high |
| status | enum | unread | read | processing | processed | archived |
| process_result | json | 智能体处理结果 |
| process_task_id | bigint | 处理时创建的任务 ID |
| created_at | datetime | 创建时间 |
| updated_at | datetime | 更新时间 |
| processed_at | datetime | 处理完成时间 |

### 1.3 用户联系人 (RecentContact)

创建新表 `recent_contacts` 记录最近联系人：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | bigint | 主键 |
| user_id | bigint | 用户 ID |
| contact_user_id | bigint | 联系人用户 ID |
| last_contact_at | datetime | 最后联系时间 |
| contact_count | int | 联系次数 |

---

## 二、后端 API 设计

### 2.1 工作队列管理 API

```
POST   /api/v1/work-queues                    # 创建队列
GET    /api/v1/work-queues                    # 获取当前用户的队列列表（包含个人和可访问的组队列）
GET    /api/v1/work-queues/{queue_id}         # 获取队列详情
PUT    /api/v1/work-queues/{queue_id}         # 更新队列配置
DELETE /api/v1/work-queues/{queue_id}         # 删除队列
POST   /api/v1/work-queues/{queue_id}/set-default  # 设为默认队列
POST   /api/v1/work-queues/{queue_id}/regenerate-invite  # 重新生成邀请码

# 分组相关 API（类似知识库的分组设计）
GET    /api/v1/work-queues/groups             # 获取用户可访问的所有分组（个人、群组、组织）
GET    /api/v1/work-queues/groups/{group_id}/queues  # 获取指定分组下的队列列表

# 组队列相关 API
GET    /api/v1/groups/{group_id}/queues       # 获取群组的队列列表
POST   /api/v1/groups/{group_id}/queues       # 为群组创建队列（需管理员权限）
GET    /api/v1/groups/{group_id}/queues/default  # 获取群组的默认队列
```

**获取分组列表响应：**
```json
{
  "groups": [
    {
      "id": "personal",
      "type": "personal",
      "name": "personal",
      "displayName": "个人",
      "queueCount": 2,
      "unreadCount": 3
    },
    {
      "id": "group_123",
      "type": "group",
      "name": "dev-team",
      "displayName": "研发组",
      "queueCount": 1,
      "unreadCount": 5
    },
    {
      "id": "organization",
      "type": "organization",
      "name": "organization",
      "displayName": "组织",
      "queueCount": 1,
      "unreadCount": 2
    }
  ]
}
```

### 2.2 队列消息 API

```
GET    /api/v1/work-queues/{queue_id}/messages     # 获取队列消息列表（支持分页、筛选、排序）
GET    /api/v1/work-queues/messages/unread-count   # 获取所有队列未读消息数
PATCH  /api/v1/queue-messages/{message_id}/status  # 更新消息状态
PATCH  /api/v1/queue-messages/{message_id}/priority # 更新消息优先级
POST   /api/v1/queue-messages/{message_id}/process # 手动触发处理
DELETE /api/v1/queue-messages/{message_id}         # 删除/归档消息
```

### 2.3 消息转发 API

```
POST   /api/v1/messages/forward                    # 转发消息到队列
GET    /api/v1/users/{user_id}/public-queues       # 获取用户的公开队列列表
GET    /api/v1/users/search                        # 搜索用户（支持邮箱/用户名）
GET    /api/v1/users/recent-contacts               # 获取最近联系人
GET    /api/v1/groups/{group_id}/members           # 获取群组成员列表
```

**转发消息请求体：**
```json
{
  "sourceTaskId": "string",
  "subtaskIds": ["string"],           // 选择的消息ID，为空则发送整个对话
  "recipients": [
    {
      "type": "user | group",
      "id": "string",
      "queueId": "string"             // 可选，不传则使用默认队列
    }
  ],
  "note": "string",                   // 备注说明
  "priority": "low | normal | high"   // 优先级
}
```

**转发给组的处理逻辑：**

当 `type` 为 `group` 时，系统会将消息转发给组的共享队列：
- 每个群组自动拥有一个默认的共享工作队列
- 组内所有成员都可以查看和处理该队列中的消息
- 组管理员可以配置组队列的自动处理规则

### 2.4 WebSocket 事件

新增事件类型：

| 事件名 | 方向 | 说明 |
|--------|------|------|
| `queue:message_received` | Server→Client | 收到新的队列消息 |
| `queue:message_processed` | Server→Client | 消息处理完成 |
| `queue:reply_received` | Server→Client | 收到处理结果回复 |

---

## 三、后端服务设计

### 3.1 QueueService

- 队列 CRUD 操作
- 队列可见性权限校验
- 默认队列管理

### 3.2 QueueMessageService

- 消息转发与存储
- 消息状态管理
- 内容快照生成（从 subtasks 提取消息内容）

### 3.3 QueueProcessorService

- 自动处理调度（使用 APScheduler）
- 条件触发判断
- 调用智能体执行处理
- 结果反馈（回复发送者、保存结果、发送通知）

### 3.4 ContactService

- 最近联系人记录与查询
- 用户搜索（邮箱/用户名模糊匹配）

---

## 四、前端实现
### 4.1 消息转发功能

**入口位置：**
1. **消息气泡菜单**：在消息的更多操作菜单中添加"转发"选项
2. **批量选择模式**：在对话顶部添加"选择消息"按钮，进入多选模式后显示"转发"按钮

**转发对话框组件** (`ForwardMessageDialog`)：

转发对话框支持四种转发模式，通过 Tab 切换：

#### 4.1.1 转发给他人 (Forward to User)
- 接收者选择：
  - 最近联系人列表
  - 用户搜索（输入邮箱/用户名）
- 队列选择下拉框（显示接收者的公开队列，默认选中其默认队列）
- 备注输入框
- 优先级选择

#### 4.1.2 转发给组 (Forward to Group)
- 群组选择：
  - 显示当前用户所在的所有群组列表
  - 支持群组名称搜索
  - 显示群组头像、名称和成员数量
- 队列选择下拉框（显示群组的队列列表，默认选中群组的默认队列）
- 备注输入框
- 优先级选择
- 适用场景：将消息分享给整个团队，让团队成员协作处理

**转发给组的特点：**
- 消息发送到群组的共享队列，所有组成员都可以看到
- 任何组成员都可以处理该消息（先到先得或管理员分配）
- 处理结果对所有组成员可见
- 支持 @提及特定成员（可选功能）

#### 4.1.3 保存到自己队列 (Save to Queue)
- 队列选择下拉框（显示当前用户的所有队列）
- 自动选中默认队列
- 备注输入框
- 优先级选择
- 适用场景：将消息保存到自己的工作队列中，方便稍后处理或让智能体自动处理

#### 4.1.4 开始聊天 (Start Chat)
- 基于当前消息内容开始一个新的对话
- 点击后跳转到聊天页面，并携带转发消息的上下文
- URL 参数：`/chat?forwardTaskId={taskId}&forwardSubtaskIds={subtaskIds}`
- 适用场景：需要基于当前消息继续讨论，可以选择不同的智能体
- 消息预览区域

### 4.2 工作队列页面

**新增路由**：`/inbox` 或 `/work-queue`

**页面结构**（响应式设计）：

**桌面端布局：**（类似知识库页面的分组设计）
```
┌─────────────────────────────────────────────────────────┐
│  工作队列                              [+ 新建队列]      │
├──────────────┬──────────────────────────────────────────┤
│ 侧边栏        │  消息列表                                │
│              │  ┌─────────────────────────────────────┐ │
│ ▼ 分组 (12)   │  │ 筛选: [状态▼] [优先级▼] [发送者▼]   │ │
│   👤 个人(3)  │  │ 排序: [时间▼]                       │ │
│   👥 研发组(5)│  ├─────────────────────────────────────┤ │
│   👥 产品组(2)│  │ 消息卡片列表...                      │ │
│   🏢 组织(2)  │  │                                     │ │
│              │  │                                     │ │
│ ▼ 队列列表    │  │                                     │ │
│   □ 默认队列  │  │                                     │ │
│   □ 工作相关  │  │                                     │ │
│              │  │                                     │ │
│ [⚙️ 设置]    │  │                                     │ │
└──────────────┴──────────────────────────────────────────┘
```

**侧边栏组织结构**（类似知识库 `KnowledgeSidebar`）：

1. **分组区域 (GroupsSection)**：
   - 显示所有可访问的队列分组
   - 分组类型：
     - `personal`：个人队列（👤 图标）
     - `group`：群组队列（👥 图标）- 用户所在的每个群组
     - `organization`：组织队列（🏢 图标）- 组织级别的公共队列
   - 每个分组显示未读消息数
   - 点击分组筛选显示该分组下的所有队列消息

2. **队列列表区域 (QueuesSection)**：
   - 显示当前选中分组下的队列列表
   - 支持展开/折叠
   - 每个队列显示未读消息数
   - 点击队列筛选显示该队列的消息

**分组数据结构：**
```typescript
interface QueueGroup {
  id: string           // 分组 ID（personal / group_{groupId} / organization）
  type: 'personal' | 'group' | 'organization'
  name: string         // 分组名称
  displayName: string  // 显示名称
  queueCount: number   // 队列数量
  unreadCount: number  // 未读消息数
}
```

**移动端布局：**
- 队列列表使用抽屉式侧边栏
- 消息列表全屏显示

**消息卡片组件** (`QueueMessageCard`)：
- 发送者头像和名称
- 消息内容预览（截断显示）
- 优先级标签
- 状态标签（未读/已读/处理中/已处理）
- 时间戳
- 操作按钮（标记已读、处理、删除）

**消息详情抽屉/对话框** (`QueueMessageDetail`)：
- 完整消息内容展示
- 原始对话上下文（可展开）
- 发送者备注
- 处理结果展示
- 操作按钮（手动处理、回复、删除）

### 4.3 队列设置与管理

#### 4.3.1 个人队列设置

**入口**：工作队列页面 → 选中"个人"分组 → 队列右侧的设置图标

**设置内容：**
- 队列基本信息（名称、描述）
- 可见性设置
- 自动处理配置

#### 4.3.2 组队列设置（类似知识库的组管理）

**入口位置**（多个入口，方便用户访问）：

1. **工作队列页面内**（主要入口）：
   - 选中某个群组分组后，在队列列表区域显示该组的队列
   - 管理员可见 [+ 新建队列] 按钮
   - 每个队列右侧显示设置图标（仅管理员可见）
   - 点击设置图标打开队列编辑对话框

2. **群组设置页面**（备用入口）：
   - 路由：`/groups/{groupId}/settings/queues`
   - 群组设置页面 → 工作队列 Tab

**工作队列页面中的组队列管理布局：**
```
┌─────────────────────────────────────────────────────────┐
│  工作队列                              [+ 新建队列]      │
├──────────────┬──────────────────────────────────────────┤
│ 侧边栏        │  消息列表                                │
│              │                                          │
│ ▼ 分组 (12)   │  当前分组: 研发组                        │
│   👤 个人(3)  │  ┌─────────────────────────────────────┐ │
│   👥 研发组(5)│  │ 筛选: [状态▼] [优先级▼] [发送者▼]   │ │
│   👥 产品组(2)│  │ 排序: [时间▼]                       │ │
│   🏢 组织(2)  │  ├─────────────────────────────────────┤ │
│              │  │ 消息卡片列表...                      │ │
│ ▼ 队列列表    │  │                                     │ │
│   □ 默认队列 ⚙│  │                                     │ │
│   □ 客户反馈 ⚙│  │                                     │ │
│              │  │                                     │ │
│ [⚙️ 分组设置] │  │                                     │ │
└──────────────┴──────────────────────────────────────────┘
```

**说明：**
- 选中群组分组后，队列列表显示该群组的队列
- 队列右侧的 ⚙ 图标仅对群组管理员可见
- 底部的"分组设置"按钮跳转到群组设置页面的工作队列 Tab

**组队列设置内容：**
- 队列基本信息（名称、描述）
- 可见性设置（private/public/invite_only）
- 设为默认队列
- 自动处理配置（选择智能体、触发模式）
- 结果反馈配置

**权限说明：**
- 队列创建/编辑/删除：仅群组管理员（Owner、Maintainer）
- 消息查看/处理：所有群组成员
- 普通成员在工作队列页面只能查看和处理消息，看不到设置图标

### 4.5 导航与通知

- 在主导航栏添加"工作队列"入口，显示未读消息数角标
- 使用 WebSocket 实时更新未读数

---

## 五、技术要点

### 5.1 数据库迁移

使用 Alembic 创建新表：
- `queue_messages`
- `recent_contacts`

WorkQueue 作为 CRD 存储在现有 `kinds` 表中。

### 5.2 定时任务

使用现有的 APScheduler 框架：
- 添加队列消息处理定时任务
- 支持动态调整处理间隔（最小15分钟）
- 按队列配置的条件判断是否处理

### 5.3 智能体调用

复用现有的任务执行流程：
1. 创建临时 Task，关联队列配置的 Team
2. 将队列消息内容作为任务输入
3. 执行完成后获取结果
4. 根据配置进行结果反馈

### 5.4 权限控制

**个人队列权限：**
- 队列操作：仅所有者可管理
- 消息发送：根据队列可见性判断
  - `public`：任何登录用户可发送
  - `group_visible`：仅群组成员可发送
  - `invite_only`：持有邀请码可发送
  - `private`：仅自己可发送（用于手动添加）

**组队列权限：**
- 队列创建：仅群组管理员可创建
- 队列配置：仅群组管理员可修改
- 队列删除：仅群组管理员可删除
- 消息查看：所有群组成员可查看
- 消息处理：所有群组成员可处理（或根据配置限制）
- 消息发送：
  - 群组成员可直接发送到组队列
  - 非成员根据队列可见性判断（如 `public` 则任何人可发送）

**组队列自动创建：**
- 创建群组时自动创建一个默认的组队列
- 默认队列名称为 `{群组名称}-默认队列`
- 默认可见性为 `private`（仅组成员可发送）

### 5.5 国际化

添加 i18n 翻译键：
- `zh-CN`: `workQueue`, `inbox`, `forward` 等命名空间
- `en`: 对应英文翻译

---

## 六、UI/UX 规范

- 遵循项目现有的 Calm UI 设计规范
- 使用 teal (`#14B8A6`) 作为主色调
- 消息卡片使用 `bg-surface` 背景
- 优先级标签颜色：高(红) / 普通(灰) / 低(绿)
- 状态标签：未读(蓝点) / 处理中(黄) / 已处理(绿)
- 所有交互元素添加 `data-testid` 属性
- 移动端触摸目标最小 44px × 44px

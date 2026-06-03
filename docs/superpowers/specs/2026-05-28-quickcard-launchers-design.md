---
sidebar_position: 5
---

# QuickCard 启动入口设计

## 背景

首页空会话状态下已经有 `QuickAccessCards`，当前主要展示系统推荐和用户收藏的智能体。现在需要支持两类入口：

- 系统功能：例如创建 PPT、创建 Skill、创建定时任务。本质上仍然进入某个智能体对话，只是入口表达为功能。
- 用户收藏的智能体：用户自己收藏、排序和管理的常用智能体。

同时，点击入口后不应直接发送消息，而应展示该入口配置的快捷短语。用户点击短语后，只把短语填充到上方 `ChatInput`，最终发送仍由 `ChatInput` 处理。

## 目标

- QuickCard 同时承载系统功能入口和用户收藏智能体入口。
- 交互只保留两个展示状态：QuickCard 状态、快捷短语状态。
- 快捷短语从上到下排列，视觉上保持极简。
- 点击快捷短语只填充 `ChatInput`，不直接发送。
- 系统功能和智能体都支持配置快捷短语。
- 保持发送职责集中在现有输入框，避免 QuickCard 绕过附件、模型、技能、设备目标等输入上下文。

## 非目标

- 不新增单独的发送确认弹窗。
- 不在快捷短语区域直接创建任务或发送消息。
- 不把系统功能混入用户收藏列表的偏好数组。
- 不改变现有消息发送、流式响应和任务创建链路。

## 交互模型

### 状态 1：QuickCard

空会话输入框下方展示 QuickCard：

- 第一行是系统功能卡：例如 `创建 PPT`、`创建 Skill`、`创建定时任务`。
- 第二行是用户收藏智能体卡：来自用户收藏的智能体。
- 两行视觉上分组展示，不把系统功能和收藏智能体混排到同一行。
- 点击任意卡片后，记录当前选中的 launcher，并进入状态 2。

### 状态 2：快捷短语

隐藏 QuickCard，原位置展示当前 launcher 的快捷短语列表：

- 列表纵向排列。
- 每条短语是一个轻量按钮。
- 顶部展示当前 launcher 名称，并作为极简返回入口，例如 `← 创建 PPT` 或 `← 周报智能体`。
- 点击返回后清空当前 launcher，恢复状态 1。
- 点击短语后，将短语填充到上方 `ChatInput`。
- 点击短语后仍停留在状态 2，方便用户换一句。
- 不清空用户已填入的输入框内容，除非用户点击另一条短语覆盖输入。

最终发送仍由 `ChatInput` 的发送按钮触发。

## 信息架构

QuickCard 不是一个单纯的智能体列表，而是首页的“开始入口区”。它内部有两行 launcher：

- 系统功能行：系统配置的功能入口。
- 收藏智能体行：用户收藏的智能体入口。

两类入口共用点击后的快捷短语状态，但在 QuickCard 状态中必须分组展示。

```ts
type QuickLauncher =
  | {
      type: 'system_function'
      id: string
      title: string
      description?: string
      icon?: string
      team_id: number
      quick_phrases: string[]
    }
  | {
      type: 'favorite_agent'
      id: number
      team_id: number
      title: string
      description?: string
      icon?: string
      quick_phrases: string[]
    }
```

系统功能入口由系统配置提供，用户收藏智能体由用户偏好和 Team 数据合成。

## 数据设计

### 系统功能配置

新增独立的系统配置，不复用现有 `quick_access_recommended` 的 team ID 列表：

```json
{
  "functions": [
    {
      "id": "create_ppt",
      "title": "创建 PPT",
      "description": "用智能体生成演示文稿",
      "icon": "presentation",
      "team_id": 101,
      "quick_phrases": [
        "帮我创建一个 xxx 的 PPT",
        "把这份大纲整理成 PPT",
        "帮我做一份项目汇报 PPT"
      ],
      "enabled": true,
      "order": 10
    }
  ]
}
```

推荐配置 key：`quick_launch_functions`。

### 智能体快捷短语

在 Team spec 中增加快捷短语字段：

```json
{
  "quick_phrases": [
    "帮我总结这段内容",
    "帮我生成一份周报",
    "帮我分析这份材料的风险"
  ]
}
```

快捷短语属于智能体配置的一部分。编辑智能体时可以维护，分享或安装智能体时随 Team 配置一起流转。

约束：

- 默认最多 6 条。
- 每条最多 120 个字符。
- 保存时去掉空字符串。
- 不做模板变量解析；`xxx` 这种占位由用户在输入框里手动改。

## 前端设计

### 组件边界

建议将现有 `QuickAccessCards` 拆成更明确的结构：

- `QuickLaunchPanel`：状态容器，负责在 QuickCard 和快捷短语之间切换。
- `QuickLauncherCards`：展示系统功能和收藏智能体卡片。
- `QuickPhraseList`：展示纵向快捷短语列表。
- `useQuickLaunchers`：加载并合成系统功能、用户收藏智能体、Team 详情。

`ChatArea` 只需要把 `setTaskInputMessage` 或等价方法传给 `QuickLaunchPanel`。短语点击时调用这个方法填充输入框。

### 状态

```ts
const [selectedLauncher, setSelectedLauncher] = useState<QuickLauncher | null>(null)
```

- `selectedLauncher === null`：显示 QuickCard。
- `selectedLauncher !== null`：显示快捷短语。

返回入口文案使用当前 launcher 的标题，不写死为 `QuickCard`。点击后只执行：

```ts
setSelectedLauncher(null)
```

短语点击只执行：

```ts
setSelectedTeam(launcherTeam)
setTaskInputMessage(phrase)
```

不触发发送。

### 无快捷短语处理

如果某个 launcher 没有快捷短语，点击后仍进入状态 2，但展示一个极简空态：

- `暂无快捷短语`
- 顶部仍显示当前 launcher 名称的返回入口

不额外提供“直接发送”或“直接进入”按钮，保持两状态模型简单。

## 后端设计

### 用户接口

扩展或新增用户侧 QuickLaunch 接口，返回前端可直接渲染的 launcher 列表：

```http
GET /users/quick-launch
```

响应包含：

- `system_functions`
- `favorite_agents`

这样前端无需把系统功能配置、收藏偏好和 Team spec 多次拼接。

### 管理接口

新增系统功能配置管理接口：

```http
GET /admin/system-config/quick-launch-functions
PUT /admin/system-config/quick-launch-functions
```

管理员配置系统功能的顺序、标题、图标、绑定智能体和快捷短语。

### Team 接口

Team 创建、更新、详情和列表接口透传 `quick_phrases`：

- 创建/编辑智能体时保存。
- 列表接口返回，便于 QuickLaunch 一次渲染。
- QuickAccess 响应如继续保留，可追加 `quick_phrases`，但新 UI 优先使用 `/users/quick-launch`。

## 测试策略

### 前端单测

- QuickCard 初始状态渲染系统功能和收藏智能体。
- 点击卡片后隐藏 QuickCard，显示该卡片短语。
- 点击返回后恢复 QuickCard。
- 点击短语只填充输入框，不调用发送函数。
- 无快捷短语时显示极简空态。

### 后端单测

- `/users/quick-launch` 合并系统功能和用户收藏智能体。
- 系统功能跳过禁用项和不存在的 team。
- Team `quick_phrases` 保存时过滤空字符串。
- 普通用户不能修改系统功能配置。

### E2E

- 空会话页点击 `创建 PPT`，出现短语列表。
- 点击 `帮我创建一个 xxx 的 PPT`，输入框填入该文案。
- 用户编辑输入框后点击发送，仍走现有聊天发送流程。
- 返回按钮恢复 QuickCard。

## 开放问题

- 系统功能配置是否只允许绑定系统内置智能体，还是也允许绑定公共智能体。
- 快捷短语是否需要多语言字段。本轮建议先用普通字符串，跟随配置者输入，不做 i18n 展开。

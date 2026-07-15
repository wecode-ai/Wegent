# Wework Sites 功能设计

## 目标

在 Wework 桌面端增加一个 Codex 风格的“站点”顶层页面。页面直接读取外部
Sites API，允许当前用户搜索和查看站点、打开内部或外部 URL，并把尚未发布的
站点发布到外网。页面右上角提供“创建”入口，点击后进入一个全新的标准对话，
并自动预选 Sites 能力。

## 范围

本次实现包含：

- Wework 侧边栏“站点”入口和 `/sites` 顶层路由。
- 当前用户的站点列表、搜索、刷新和增量加载。
- 内部 URL、外部 URL及发布状态展示。
- 调用 Sites API 发布到外网，并在当前行更新结果。
- “创建”跳转到全新对话并预选 Sites Skill。
- 独立 Sites API 地址配置、接口类型、错误解析和双语文案。
- 单元测试、路由测试和真实 Tauri 桌面验证用例。

本次不包含：

- Wegent Backend 识别站点或调用 Sites 创建接口。
- Wework 内的站点创建表单。
- 站点删除、分享、访问范围、权限配置或版本管理。
- 修改负责生成并登记站点的独立 Skill。
- 修改外部 Sites API 或其 Mock Server。

## 系统边界

站点的创建和目录归并由独立 Skill 与 Sites API 负责。Skill 生成站点、取得内部
URL 后调用 Sites API 登记。多个 `taskid` 可以归属于同一站点；同一用户的规范化
目录 `path` 只对应一个站点。`siteid` 是站点唯一标识。这些关联规则不在 Wework
重复实现，Wework 只把 Sites API 当作站点事实来源。

Wework 不通过 Wegent Backend 代理 Sites 请求：

```text
独立 Sites Skill ──创建/登记──> Sites API
Wework          ──列表/发布──> Sites API
```

Wework 请求外部服务时不得携带 Wegent 登录 Bearer Token。当前内部 Sites API 使用
必填 `username` 过滤数据；`username` 固定取已登录用户的 `user_name`，页面不提供
可编辑输入框。

## 外部 API 使用

本次 Wework 只调用以下接口：

### 列表

```http
GET /api/v1/sites?username={user_name}&q={query}&offset={offset}&limit=20
```

- `username` 必填，来自当前登录用户。
- `q` 为空时不发送；输入停止 180 毫秒后请求。
- 首次请求使用 `offset=0`；存在剩余数据时显示“加载更多”。
- 搜索词变化会取消旧结果的状态写入，并重新从第一页加载。

### 发布

```http
POST /api/v1/sites/{siteid}/publish
```

- 每一行独立维护发布中的临时状态。
- 成功后使用响应中的完整 Site 替换当前列表项，不额外刷新整页。
- `published` 为幂等状态；已发布行不重复显示可点击的发布操作。
- `failed` 行显示错误摘要和“重新发布”。
- `409 site_publish_in_progress` 将该行切换为“发布中”，随后允许用户刷新。
- `502 site_publish_failed` 显示接口返回的 `error.message`，保留重试入口。

外部 API 的业务错误结构为 `{ "error": { "code", "message" } }`。Wework 公共
HTTP 错误解析器需要识别该结构，同时保留既有 FastAPI `detail` 解析行为。

## 运行配置

在 `RuntimeConfig` 增加：

```text
sitesApiBaseUrl / VITE_SITES_API_BASE_URL
```

配置值统一移除末尾 `/`。开发时可设置为 `http://127.0.0.1:8765`；未配置时页面
显示服务未配置状态和重试说明，不静默回退到 Wegent Backend。

## 页面结构

### 路由和外壳

- `/sites` 与 `/plugins` 一样是 Wework 的辅助顶层路由。
- Workbench 保持挂载但在 Sites 页面显示时隐藏，避免丢失对话、终端和浏览器状态。
- Sites 页面复用桌面侧边栏、窗口控制、移动抽屉和现有设置/搜索入口。
- 侧边栏增加带图标和文字的“站点”按钮，当前路由下显示选中态。

### 内容布局

桌面端采用用户截图中的 Codex 风格：大面积留白、单列内容、低对比度边框和现有
Wework 语义色。UI/UX 设计建议中的高对比紫色和外部字体不采用，因为它们与用户
截图和 Wework 现有视觉系统冲突；保留其单一主操作、清晰焦点、加载反馈和无障碍
要求。

```text
站点                                                [刷新] [创建]
将你的想法变成真实网站

[ 搜索站点                                                    ]

站点
┌────────┬──────────────────────┬──────────────────┬──────────┐
│ 缩略图 │ 名称 / URL / 更新时间 │ 发布状态          │ 操作     │
└────────┴──────────────────────┴──────────────────┴──────────┘
```

- 内容最大宽度约 920 像素，并与截图保持相近的标题、搜索框和行密度。
- 缩略图使用 API 的 `thumbnail_url`；加载失败时显示稳定的站点占位图标。
- 内部 URL 始终显示，点击后通过现有 `openExternalUrl` 打开。
- 只有 `published` 且 `external_url` 非空时显示外部 URL。
- URL 过长时单行省略，悬停和键盘聚焦可获得完整值。
- 行状态使用图标与文字共同表达，不只依靠颜色。

### 状态映射

| API 状态 | 页面文案 | 行操作 |
| --- | --- | --- |
| `unpublished` | 未发布到外网 | 发布 |
| `publishing` | 发布中 | 禁用按钮和加载图标 |
| `published` | 已发布到外网 | 已发布（禁用） |
| `failed` | 发布失败，并显示错误摘要 | 重新发布 |

### 页面状态

- 首次加载：保留列表尺寸的骨架屏，避免布局跳动。
- 空列表：显示“还没有站点”和“创建站点”按钮。
- 搜索无结果：显示当前搜索词和清除搜索入口。
- 列表失败：在内容区显示原因和“重试”，不清空仍可用的旧数据。
- 刷新：刷新按钮旋转且禁用，完成后保持当前搜索词。
- 所有新交互元素提供描述性 `data-testid`、可见焦点和 `aria-label`。

## “创建”对话流程

“创建”不调用 Sites 创建 API，也不打开独立表单。点击后执行：

1. 按规范标识 `sites:sites-building` 解析能力：统一技能列表按 `namespace + name`
   匹配，本地优先模式强制刷新 Codex app-server 的技能列表并匹配插件技能。
2. 建立一个全新的空白对话 scope，保留原任务和未发送草稿。
3. 仅为这个新 scope 设置能力；统一技能写入 `SkillRef`，本地插件技能写入指向
   `SKILL.md` 的 composer mention。
4. 导航到标准对话页 `/`，聚焦输入框。
5. 输入框的已选能力区域显示用户可读名称 `Sites`；不自动填充或发送提示词。
6. 用户发送后，统一技能沿用 `additional_skills`，本地插件技能沿用现有路径引用
   运行 Sites Skill。

现有 `startNewChat()` 默认语义保持不变。新增可选参数或专用方法，以支持
`fresh: true` 和按名称预选 Skill，并在切换 scope 前把选择写入目标
`blank:{standaloneChatKey}`，防止选择落到旧对话。

如果 Sites Skill 尚未加载，按钮显示短暂等待状态；如果加载完成后仍不存在，则
停留在 Sites 页面，显示“Sites 能力不可用”以及进入插件页面的恢复入口。

## 组件和模块边界

- `src/api/sites.ts`：外部接口 DTO、查询参数编码、列表和发布方法。
- `src/components/sites/SitesWorkspace.tsx`：列表查询、搜索、分页和页面状态协调。
- `src/components/sites/SiteListItem.tsx`：单行展示、URL 打开和发布状态。
- `src/pages/SitesPage.tsx`：复用 Wework 页面外壳并连接 Workbench 上下文。
- `src/features/workbench/useWorkbenchSkills.ts`：支持向指定对话 scope 写入技能选择。
- `src/features/workbench/WorkbenchProvider.tsx`：暴露新对话预选 Skill 的入口。
- `src/config/runtime.ts`：提供独立 Sites API 地址。
- `src/App.tsx` 与侧边栏组件：注册 `/sites` 路由和导航入口。
- `src/i18n/locales/{zh-CN,en}/sites.json`：Sites 专属文案。

## 测试策略

所有行为按测试驱动方式实现：先写失败测试，确认因功能缺失而失败，再写最小实现。

### 单元与组件测试

- Sites API 客户端正确编码必填 `username`、搜索和分页参数。
- Sites API 客户端不发送 Wegent 登录 Token。
- 公共 HTTP 客户端正确解析 `{error:{code,message}}`。
- Sites 页面覆盖加载、空列表、搜索、加载更多、失败重试和刷新。
- 每个发布状态映射到正确文案和按钮状态。
- 发布成功只更新目标行；502 显示可重试错误。
- “创建”生成新的空白对话 scope，并只在该 scope 预选 `sites:sites-building`，
  同时覆盖统一技能和本地插件技能两种来源。
- Skill 不可用时不导航，并显示恢复入口。
- `/sites` 路由保持 Workbench 挂载，侧边栏显示正确选中态。
- 中英文命名空间均注册且关键文案存在。

### 桌面验证

- 运行 Wework 全量 Vitest、类型检查、ESLint 和 Prettier 检查。
- 通过真实 `http://127.0.0.1:8765` API 验证列表、搜索和发布，不在 E2E 中 Mock
  站点请求。
- 使用 `pnpm --filter wework ai:verify --scenario ...` 验证实际 Tauri 桌面 UI：侧边栏
  入口、站点页面、发布状态以及“创建”后的 Sites 已选中状态。
- 在浅色和深色模式检查对比度、边框、焦点和禁用态；桌面优先，同时保证移动布局
  不产生横向滚动。

## 验收标准

1. 登录用户可以从侧边栏进入站点页，只看到 `user_name` 对应的数据。
2. 页面能够搜索、刷新和增量加载站点。
3. 每条站点始终展示内部 URL；发布成功后展示外部 URL。
4. 未发布或失败的站点可以发布到外网，发布过程不可重复点击，错误可以恢复。
5. 页面没有分享、访问范围、删除和版本相关入口。
6. 点击“创建”进入全新标准对话，Sites 已选中但没有自动发送消息。
7. Wegent Backend 没有新增站点识别或自动登记逻辑。

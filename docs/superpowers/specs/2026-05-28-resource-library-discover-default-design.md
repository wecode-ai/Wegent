---
sidebar_position: 5
---

# 资源库发现默认页设计

## 背景

资源库已经具备前端发现页组件、我的资源管理页组件、资源卡片、详情抽屉和安装调用封装。当前 `/resource-library` 页面只渲染“我的资源”，`DiscoverResources`、`ResourceLibraryTabs` 和 `ResourceTypeFilter` 没有出现在主入口中。现有测试也明确断言“发现”和“我的”Tab 不可见。

用户希望资源库支持“发现”能力，并明确选择以下产品方向：

- 发现页展示全站公开资源。
- 发现页先支持智能体和技能。
- `/resource-library` 默认进入发现页。
- 视觉布局采用“平衡型目录”：Tab、筛选、搜索和资源卡片都在首屏，保持工作台式信息密度。

## 目标

- `/resource-library` 默认显示“发现”。
- 内容区顶部恢复 `发现 / 我的` 一级 Tab。
- 发现页展示全站公开发布资源，资源类型筛选为 `全部`、`智能体`、`技能`。
- 发现页支持搜索、查看详情和安装资源。
- “我的”Tab 保留当前资源管理能力，包括个人/组资源和 Agent、Skill、Model、Shell、Retriever 管理。
- 保持现有设置页、组管理页、知识库页跳转到资源库管理入口的链接可用。

## 非目标

- 本次不做组内发现或组织级发现。
- 本次不把模型、执行器、检索器加入公开发现页。
- 本次不新增后端资源库接口或数据库结构。
- 本次不重做资源发布流程。
- 本次不引入推荐、评分、收藏、热门排序或资源分类市场化能力。
- 本次不改变资源安装后的落地模型。

## 用户体验

资源库页面保留左侧主导航和顶部导航。顶部导航标题仍为“资源库”。内容区采用单层工作台布局：

1. 第一行展示 `发现 / 我的` Tab。
2. 默认激活 `发现`。
3. 发现页第二行展示资源类型筛选和搜索框。
4. 下方以卡片网格展示资源。
5. 卡片包含资源类型、名称、描述、标签、安装次数、更新时间、安装按钮和详情按钮。
6. 点击详情打开右侧抽屉。
7. 点击安装调用现有安装 API，成功后卡片和抽屉都进入已安装状态。

选择 `我的` 后，页面切换到现有资源管理体验：

- 资源类型管理 Tab：`智能体`、`技能`、`模型`、`执行器`、`检索器`。
- 资源归属控制：个人资源或组资源。
- 对应资源列表沿用现有组件。

## URL 行为

URL 查询参数是页面状态入口，避免破坏已有跳转：

- `/resource-library` 默认等价于 `/resource-library?tab=discover`。
- `/resource-library?tab=discover` 显示发现页。
- `/resource-library?tab=mine` 显示我的资源页。
- `/resource-library?tab=mine&type=agent&scope=personal` 继续显示个人智能体管理页。
- `/resource-library?tab=mine&type=agent&scope=group&group=<name>` 继续显示指定组的智能体管理页。

无效 `tab` 值回退到 `discover`。无效 `type` 或 `scope` 仍由 `MyResources` 的现有默认逻辑处理。

## 组件设计

### `ResourceLibraryPage`

职责：

- 读取初始 `tab` 查询参数。
- 管理当前一级 Tab。
- 渲染 `ResourceLibraryTabs`。
- 根据当前 Tab 渲染发现页或我的资源页。
- 在切换 Tab 时更新浏览器 URL，保留可分享状态。

发现页状态：

- 默认资源类型为 `all`。
- 使用 `ResourceTypeFilter` 渲染 `all`、`agent`、`skill`。
- 使用 `DiscoverResources` 加载列表。

我的资源状态：

- 直接渲染 `MyResources`。
- `MyResources` 继续读取 `type`、`scope` 和 `group` 查询参数。

### `DiscoverResources`

职责保持不变：

- 调用 `resourceLibraryApi.listListings`。
- 传递 `resourceType`、`keyword`、`page` 和 `limit`。
- 过滤不应在发现页展示的资源类型。
- 处理加载、错误、空态、详情抽屉和安装操作。

发现页可见类型继续限制为 `agent` 和 `skill`，即使 API 返回 `mcp` 也不展示。

### `ResourceTypeFilter`

职责保持不变：

- 展示 `全部`、`智能体`、`技能`。
- 使用按钮式分段筛选。
- 所有按钮保留可测试的 `data-testid`。

### `ResourceLibraryTabs`

职责保持不变：

- 展示 `发现` 和 `我的`。
- 使用 `primary` variant 标识当前 Tab。
- 所有按钮保留可测试的 `data-testid`。

## 数据流

发现页初次加载：

1. `ResourceLibraryPage` 读取 `tab`。
2. 没有 `tab` 时设为 `discover`。
3. 发现页设置 `resourceType = "all"`。
4. `DiscoverResources` 调用 `GET /resource-library/listings?page=1&limit=50`。
5. 前端过滤非可见资源类型。
6. 渲染资源卡片。

发现页搜索：

1. 用户输入关键词。
2. 提交搜索表单。
3. `DiscoverResources` 设置 `keyword`。
4. 重新调用列表接口。

安装资源：

1. 用户点击卡片或详情抽屉中的安装按钮。
2. `DiscoverResources` 调用 `POST /resource-library/listings/{id}/install`。
3. 请求使用默认 `targetNamespace = "default"`。
4. 成功后更新当前资源的 `is_installed` 和 `install_count`。
5. 重新加载发现列表，确保列表和后端状态一致。
6. 失败时展示 destructive toast。

## 空态和错误处理

- 加载中显示卡片骨架屏。
- 请求失败显示错误区域和重试按钮。
- 没有资源时显示资源库空态文案。
- 搜索无结果时复用空态文案。
- 详情加载失败时保持抽屉打开，并展示错误 toast。
- 安装失败时不修改本地安装状态。

## 响应式设计

桌面端：

- 内容区使用现有最大宽度容器。
- Tab 位于内容区顶部。
- 发现页筛选和搜索同一行展示。
- 资源卡片使用 2 到 3 列网格。

移动端：

- Tab、筛选和搜索纵向堆叠。
- 按钮高度保持至少 44px。
- 资源卡片单列展示。
- 详情抽屉沿用现有移动端抽屉行为。

## 测试计划

前端测试先行：

- `ResourceLibraryPage` 默认渲染发现 Tab。
- 默认页面渲染 `发现 / 我的` Tab 和 `全部 / 智能体 / 技能` 筛选。
- 默认进入发现页时调用 `resourceLibraryApi.listListings`，不渲染我的资源管理。
- 点击 `我的` 后渲染 `MyResources`，不继续展示发现列表。
- 初始 URL 为 `?tab=mine&type=agent&scope=personal` 时直接渲染 `MyResources`。
- 点击资源类型筛选会把对应类型传给 `DiscoverResources` 并重新加载列表。
- `DiscoverResources` 继续过滤 `mcp` 类型资源。
- 详情和安装流程沿用现有测试覆盖。

## 实现边界

本次实现应优先复用已存在组件，不新增复杂抽象。主要改动集中在 `ResourceLibraryPage` 的页面编排和相关测试。除非测试暴露问题，否则不修改后端、不修改资源安装 API、不重写卡片或抽屉组件。

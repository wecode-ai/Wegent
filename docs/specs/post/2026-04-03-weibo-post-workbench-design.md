---
sidebar_position: 1
---

# Wegent 微博草稿工作台设计

## 背景

当前 Wegent 的任务对话可以生成文本、图片、视频等适合微博发布的内容，但这些内容仍然分散在具体任务和消息上下文中，缺少一个面向“发布整理”的全局工作区。

用户希望获得一个可从所有任务页面呼出的全局右侧面板，用于完成两件事：

- 从任意智能体对话中收集可复用的发布素材
- 将多个素材自由组合为一条待发布的微博草稿

本次需求的核心不只是“临时导出内容”，而是建立一个用户级别、跨任务共享的内容整理工作台。

## 目标

本次设计目标如下：

- 提供一个全局可呼出的微博草稿工作台面板
- 建立用户级别的独立素材库，支持从任意 AI 消息收集素材
- 建立微博草稿能力，使草稿通过引用素材进行组合和排序
- 支持同一素材被多条草稿复用，同一草稿引用多个素材
- 支持在草稿内对文本素材做局部覆写，不影响素材库原文
- 支持将草稿发布到微博 Upload Channel 页面
- 支持桌面端右侧 overlay 面板与移动端全屏 Drawer

## 非目标

本次不做以下内容：

- 不实现微博发布完成后的回调同步
- 不保证用户在微博页面取消发布后可自动回滚草稿状态
- 不实现已发布草稿的专门管理页面
- 不实现草稿复制、素材去重、素材批量操作
- 不实现真正跨页面自动执行 regenerate
- 不把该能力抽象为通用“内容资产中心”

## 方案对比

### 方案 1：两张表，草稿引用关系存 JSON

数据层只新增两张表：

- `post_materials`
- `post_drafts`

其中草稿内素材引用关系存放在 `post_drafts.material_refs` JSON 字段中。

优点：

- 表数量少，符合本次“不要过重建模”的约束
- 保留素材独立存在、草稿按引用组合的核心语义
- 支持排序、局部文本覆写、多对多复用
- 后端接口保持清晰，前端心智模型稳定

缺点：

- 草稿详情需要服务层主动组装素材详情
- 排序和引用更新不再依赖关系表，需要整体读写 JSON

### 方案 2：三张表，单独维护引用关系表

数据层新增三张表：

- `post_materials`
- `post_drafts`
- `post_draft_material_refs`

优点：

- 关系建模最规范
- 引用更新、排序更新、查询过滤更细粒度

缺点：

- 数据模型偏重
- 对本次需求来说成本过高
- 与用户提出的“表太多了”约束冲突

### 方案 3：单表，把素材直接内嵌到草稿

只保留 `post_drafts` 一张表，素材作为草稿 JSON 的一部分保存。

优点：

- 实现最轻

缺点：

- 素材无法成为全局共享资源
- 无法真正支持多草稿复用同一素材
- 与本次需求核心理念冲突

## 选型

采用方案 1。

理由：

- 同时满足“素材独立资源池”和“数据层不要太重”这两个核心要求
- 能以较低复杂度保住多对多引用、排序、文本覆写等关键能力
- 便于前端以工作台心智模型稳定接入

## 总体设计

本次改动分为四层：

### 1. 后端资源层

新增两张业务表：

- `post_materials`：保存用户级独立素材
- `post_drafts`：保存草稿本体与素材引用 JSON

### 2. 后端业务层

新增两个 service：

- `post_material_service.py`：负责素材 CRUD
- `post_draft_service.py`：负责草稿 CRUD、草稿内引用维护、发布链接组装

### 3. 前端全局工作台层

在 `frontend/src/app/(tasks)/layout.tsx` 注入 `PostWorkbenchProvider`，负责：

- 面板展开与收起
- 宽度持久化
- 当前标签页
- 当前激活草稿
- 未发布草稿数量

### 4. 前端业务交互层

拆分为素材域和草稿域：

- 素材域：采集、筛选、删除、加入当前草稿
- 草稿域：创建、切换、排序、文本覆写、发布

## 数据模型

### `post_materials`

`PostMaterial` 表示独立素材资源。

字段如下：

- `id: string`，UUID 主键
- `user_id: int`，所属用户
- `type: string`，取值为 `text`、`image`、`video`、`audio`
- `text_content: text | null`
- `media_urls: json | null`
- `thumbnail_url: string | null`
- `media_id: string | null`
- `pid: string | null`
- `duration: float | null`
- `source_task_id: int | null`
- `source_subtask_id: int | null`
- `source_team_name: string | null`
- `is_active: bool`，软删除标记
- `created_at`
- `updated_at`

设计约束：

- 不做素材去重
- 删除素材采用软删除
- 素材与任务、消息只保留溯源信息，不建立强外键依赖

### `post_drafts`

`PostDraft` 表示微博草稿。

字段如下：

- `id: string`，UUID 主键
- `user_id: int`
- `title: string`
- `description: text | null`
- `status: string`，取值为 `editing` 或 `published`
- `published_at: datetime | null`
- `material_refs: json`
- `created_at`
- `updated_at`

其中 `material_refs` 的结构为：

```json
[
  {
    "id": "uuid",
    "materialId": "uuid",
    "sortOrder": 0,
    "textOverride": "optional text"
  }
]
```

设计约束：

- `material_refs` 只保存引用关系和局部覆写，不保存素材完整数据
- 草稿详情接口需要根据 `materialId` 批量查询素材并拼装返回
- 已发布草稿默认不出现在前端头部草稿切换器中

## 后端接口设计

### 素材库 API

- `POST /api/post-materials`
  - 新增素材
  - 用于从消息内容中收集文案、图片、视频、音频
- `GET /api/post-materials`
  - 获取素材列表
  - 支持按 `type`、关键词、分页过滤
- `DELETE /api/post-materials/{materialId}`
  - 软删除素材

### 草稿 API

- `POST /api/post-drafts`
  - 创建空白草稿
- `GET /api/post-drafts`
  - 获取草稿列表
  - 支持按 `status` 过滤
- `GET /api/post-drafts/{draftId}`
  - 获取草稿详情
  - 返回草稿本体、`material_refs`，以及按顺序组装后的素材完整信息
- `PUT /api/post-drafts/{draftId}`
  - 更新草稿标题、描述
- `DELETE /api/post-drafts/{draftId}`
  - 删除草稿

### 草稿内素材操作 API

虽然底层不再有单独关系表，但保留独立的引用操作接口，避免前端直接整体覆盖整份草稿：

- `POST /api/post-drafts/{draftId}/materials`
  - 向草稿追加一个素材引用
- `PUT /api/post-drafts/{draftId}/materials/reorder`
  - 批量更新引用顺序
- `PUT /api/post-drafts/{draftId}/materials/{refId}`
  - 更新指定引用，例如 `textOverride`
- `DELETE /api/post-drafts/{draftId}/materials/{refId}`
  - 从草稿中移除指定引用

这些接口在服务层内部统一通过读写 `material_refs` JSON 完成。

### 发布 API

- `POST /api/post-drafts/{draftId}/publish`

行为如下：

- 读取草稿和引用素材
- 按 `sortOrder` 组装发布顺序
- 文本内容优先使用 `textOverride`，否则使用素材原始 `text_content`
- 图片素材使用 `pid`
- 视频素材使用 `media_id`
- 调用微博发布 URL 构建逻辑生成最终链接
- 返回该链接供前端打开
- 接口成功后将草稿更新为 `published`
- 写入 `published_at`

## 发布语义

本次“发布成功”的定义为：

- 后端成功组装并返回微博发布链接
- 前端成功打开微博发布页面
- 草稿在系统内立即更新为 `published`

这不是对微博最终发布结果的确认，而是对“进入发布流程”的确认。

采用该语义的原因是当前没有微博回调链路，系统也没有机会在用户取消发布时自动回滚状态。本次需求明确接受该取舍，因此将“打开发布页”视为已发布。

## 前端设计

### 全局入口

在 `TopNavigation` 右侧新增微博草稿按钮：

- 使用 `FileEdit` 或 `NotebookPen` 图标
- 在所有任务页面可见
- 点击展开或收起全局工作台
- 展开时高亮
- 有未发布草稿时显示 badge

### 面板容器

新增 `PostWorkbenchPanel`，行为如下：

- 桌面端以右侧 overlay 形式覆盖主内容
- 默认宽度 `420px`
- 支持拖拽左边缘调整宽度
- 最小宽度 `320px`
- 最大宽度 `600px`
- 宽度和展开状态持久化到 `localStorage`
- z-index 高于主内容，低于 Modal/Dialog

移动端适配：

- 使用全屏 Drawer
- 不使用桌面端右侧 overlay 布局
- 所有交互元素高度不小于 `44px`

### 面板头部

面板头部包含：

- 标题“微博草稿”
- 当前草稿选择器
- “＋新建”按钮
- 关闭按钮

草稿选择器只展示 `editing` 状态草稿，并显示：

- 草稿标题
- 素材数量
- 最后修改时间

### 子标签页

工作台包含两个子标签页：

- `素材库`
- `当前草稿`

这两个标签页共享同一个面板容器，但数据职责严格分离。

## 素材库设计

### 素材列表

素材库顶部包含：

- 搜索栏
- 类型筛选：全部、文案、图片、视频、音频

中部为按时间倒序排列的素材卡片列表。

卡片形态如下：

- 文案素材：显示两行文本预览
- 图片素材：显示缩略图或多图网格
- 视频素材：显示缩略图、播放标记、时长
- 音频素材：显示音频图标、文件名、时长

每张素材卡片包含：

- 删除按钮
- 当存在当前激活草稿时显示“添加到当前草稿”按钮

### 素材收集入口

在 `BubbleTools` 中新增 `AddMaterialButton`，并要求：

- 在所有对话模式下可见
- 支持文本、图片、视频、音频提取
- 混合内容时弹出轻量选择 Popover
- 添加成功后显示 toast
- 按钮短暂切换为勾选状态

提取规则如下：

- 纯文本消息：提取 `message.content` 或 `result.value`
- 图片：提取 `result.blocks` 中的图片 URL
- 视频：提取视频 URL、缩略图、`media_id`
- 音频：提取消息中的音频附件

本次不做去重限制，同一消息可重复添加为多个素材。

## 草稿编辑设计

### 草稿创建与切换

用户可通过“＋新建”创建草稿，只要求输入标题。

切换草稿时：

- 当前草稿标签页内容立即更新
- 未保存的本地编辑通过乐观更新和自动保存机制同步

### 当前草稿区域

草稿编辑区按微博最终展示顺序垂直排列素材块。

每个素材块显示：

- 拖拽手柄
- 移除按钮
- 重新生成按钮
- 素材内容预览

文本素材支持直接在草稿中编辑，编辑结果写入 `textOverride`。

约束如下：

- 编辑不修改素材库原始 `text_content`
- 输入采用 `500ms` debounce 自动保存

### 拖拽排序

使用项目已存在的 `@dnd-kit/core` 与 `@dnd-kit/sortable`。

桌面端：

- 拖拽手柄直接拖动排序

移动端：

- 使用长按触发拖拽

排序更新采用乐观更新，随后调用 `reorder` 接口落库。

### 重新生成

“重新生成”能力第一版只做来源定位能力预留：

- 优先跳转回来源任务或来源消息
- 不承诺自动执行 regenerate

这样可以避免本次需求与现有消息流、模型切换、不同任务类型的 regenerate 机制深度耦合。

## 发布确认弹窗

新增 `PostPublishModal`。

内容包括：

- 微博标题输入框，必填，最大 20 字
- 微博描述输入框，选填，最大 500 字
- 素材预览区，只读展示当前草稿顺序
- “确认发布”按钮，使用 `variant="primary"`
- “取消”按钮，使用 `variant="outline"`

确认后：

- 调用发布接口
- 在新窗口打开微博发布页
- 成功后刷新草稿列表与当前草稿状态

## 前端模块划分

新增以下模块：

- `frontend/src/features/post/components/PostWorkbenchPanel.tsx`
- `frontend/src/features/post/components/MaterialLibraryTab.tsx`
- `frontend/src/features/post/components/MaterialCard.tsx`
- `frontend/src/features/post/components/DraftEditorTab.tsx`
- `frontend/src/features/post/components/DraftMaterialCard.tsx`
- `frontend/src/features/post/components/DraftSelector.tsx`
- `frontend/src/features/post/components/PostPublishModal.tsx`
- `frontend/src/features/post/components/AddMaterialButton.tsx`
- `frontend/src/features/post/hooks/usePostWorkbench.ts`
- `frontend/src/features/post/hooks/useMaterialLibrary.ts`
- `frontend/src/features/post/hooks/usePostDraft.ts`
- `frontend/src/features/post/hooks/usePostPublish.ts`
- `frontend/src/features/post/contexts/postWorkbenchContext.tsx`
- `frontend/src/features/post/types.ts`
- `frontend/src/features/post/constants.ts`
- `frontend/src/apis/post-materials.ts`
- `frontend/src/apis/post-drafts.ts`

修改以下现有模块：

- `frontend/src/features/layout/TopNavigation.tsx`
- `frontend/src/app/(tasks)/layout.tsx`
- `frontend/src/features/tasks/components/message/BubbleTools.tsx`
- 必要时补充媒体消息相关入口组件
- `backend/app/api/router.py`

## 国际化

新增 `post` namespace：

- `frontend/src/i18n/locales/zh-CN/post.json`
- `frontend/src/i18n/locales/en/post.json`

前端统一使用 `useTranslation('post')`。

跨命名空间时使用：

- `t('common:xxx')`
- `t('chat:xxx')`

不使用多 namespace 数组形式。

## 状态与同步策略

### UI 状态

以下状态保存在 `localStorage`：

- 面板展开与收起
- 桌面端面板宽度
- 当前激活标签页

### 业务状态

以下状态以后端为准：

- 素材列表
- 草稿列表
- 草稿详情
- 当前草稿素材顺序与文本覆写

### 同步策略

- 素材添加、删除、加入草稿采用乐观更新
- 草稿排序采用乐观更新
- 文本覆写采用 `500ms` debounce 自动保存
- 发布完成后以接口结果刷新草稿状态

## 权限与数据隔离

素材和草稿均为用户级资源。

所有查询和写入都必须按当前登录用户隔离：

- 读取时必须基于 `user_id`
- 修改时必须校验资源归属
- 不允许跨用户读取或修改素材、草稿

## 错误处理

需要覆盖以下错误场景：

- 添加素材时无法解析有效内容
- 草稿不存在或不属于当前用户
- 草稿为空时触发发布
- 素材被删除后草稿仍引用该素材
- 发布所需 `pid` 或 `media_id` 缺失
- 新窗口打开失败

处理原则：

- 前端给出明确 toast 提示
- 后端返回清晰业务错误信息
- 草稿详情组装时若发现素材已失效，应在响应中显式标记，避免静默丢失

## 测试策略

### 后端测试

覆盖以下内容：

- 素材新增、列表、软删除
- 草稿新增、更新、删除
- `material_refs` JSON 的追加、删除、重排、覆写
- 草稿详情组装
- 发布参数组装
- 发布后状态更新为 `published`

### 前端测试

覆盖以下内容：

- 顶部入口按钮展开收起与 badge 显示
- 素材库筛选、删除、加入当前草稿
- 草稿切换与空状态
- 草稿内文本覆写与自动保存
- 草稿内拖拽排序
- 发布弹窗校验与提交流程

### 集成测试

覆盖以下主流程：

- 从消息点击“添加素材”进入素材库
- 从素材库添加素材到草稿
- 发布成功后草稿从编辑列表中移除

## 实现边界结论

本次设计明确采用以下边界：

- 数据库只新增两张表：`post_materials` 与 `post_drafts`
- 草稿引用关系存储在 `post_drafts.material_refs` JSON 字段
- 发布接口成功后立即将草稿标记为 `published`
- “重新生成”第一版只做来源定位，不做自动 regenerate

这套边界在满足核心需求的同时，控制了数据模型复杂度，并为后续扩展已发布草稿管理、微博回调同步、通用内容资产能力保留了演进空间。

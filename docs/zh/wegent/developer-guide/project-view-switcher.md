---
sidebar_position: 37
---

# 项目两级入口接入

W-0021 交付共享导航组件与壳层。W-0022 负责网页、桌面的调用方接线，以及 `collab.projectViews.v2` 在 beta 开启、stable 关闭的发布默认值。

## 选项与内容

`@wegent/collaboration` 导出 `ProjectViewSwitcher`、`groupedProjectViewMetadata` 和 `createProjectViewSelectionMemory`。给 `CollaborationProjectViewShell.viewMetadata` 传入 `groupedProjectViewMetadata` 才启用两级导航。也可在组件选项或壳层扩展选项上直接提供对应的 `group` / `parent`。

所有可用选项必须具有完整且一致的分组信息。缺省、部分或不符合固定结构的元数据保留原平级顺序，避免选项丢失。分组不增加路由 ID；切换始终返回原有的 `board/calendar/gantt/milestones/table/files/manage`。

组件只消费可用选项。标准视图沿用壳层已有权限过滤；扩展视图的 `available` 由调用方计算。无管理项时隐藏管理，不支持里程碑时不传入该项；支持但为空时仍传入选项和原空态内容。

## 会话选择

调用方在当前登录会话创建一个 `createProjectViewSelectionMemory()`，通过 `viewSelectionMemory` 交给壳层，并通过 `viewSelectionKey` 传入 `JSON.stringify([userId, projectStore, projectId])`。两项应同时传入。登出时销毁，刷新、重启后新建，禁止写入持久存储。这样跨组件卸载及项目切换仍能记住选择，并隔离用户、存储类型和项目。组件自身的缺省记忆只覆盖当前挂载生命周期。

只记住计划的子视图及时间线分段。管理每次进入默认文件；无文件时进入项目设置。显式传入的当前视图优先于记忆，挂载不会触发导航。记忆项不可用时重新选择可用项。

## 不可用链接与布局

带分组信息时，不可用视图先选同组第一项，再回工作。壳层展示解析后的内容，通过 `onUnavailableView` 返回解析结果，不调用 `onViewChange` 修改链接。W-0022 必须保留原 URL，并负责显示产品规定的提示。无分组时保留原有状态修正行为。

分组导航独立放在固定标题栏下。工作不渲染二级行，不保留该行空白。项目容器宽度小于 720px 时，二级入口使用菜单；日历/甘特分段保持在菜单外。一级不换行，二级区域允许换行。网页和桌面共用同一组件及主题结构。

## 设计交付与验证

组件注册描述位于 `packages/collaboration/design-system/project-view-switcher.json`，九个 CSF 展示状态位于 `ProjectViewSwitcher.stories.tsx`。每个状态支持 `theme` 参数切换浅色、深色；`CompactOpen` 的交互脚本打开菜单。组件测试与壳层测试由现有 collaboration CI 测试任务执行。

设计参考仓库的完整注册表、Storybook 构建环境和 `design_system_sync.py` 不在 Wegent 仓库。本地测试验证九个状态在两套主题中的实际渲染；设计仓库需导入注册描述及 stories 后运行自身的构建和同步检查。不得用虚构组件凑齐注册表数量。

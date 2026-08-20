---
sidebar_position: 47
---

# Wework 内置浏览器浏览历史功能技术方案

> 参考设计：[Codex 内置浏览器浏览历史功能分析](./codex-browser-history-analysis.md)。UI 样式与交互细节对齐 Codex。
> 涉及入口：浏览器工具栏"更多"菜单、设置-浏览器-常规。

## 目标与范围

### 范围内

1. **入口一**：浏览器工具栏 → 更多（`...`）菜单新增"历史记录"项，位于"清除浏览数据"之上；点击进入历史列表页。
2. **入口二**：设置 → 浏览器 → 常规分组新增"浏览历史"行（label + 描述 + 右侧"管理"按钮），点击进入历史列表页。
3. **历史列表页**：搜索、按天分组折叠、单条打开/删除、多选批量删除、无限滚动分页、清除浏览数据入口，交互与文案对齐 Codex。
4. **数据层**：Rust 侧记录导航历史并持久化，提供搜索/删除 IPC；清除浏览数据时同步清空历史。

### 范围外（后续迭代）

- 清除浏览数据对话框的分时间范围 × 分数据类型细化（当前 wework 为单次全量清除对话框，本方案仅把 history 纳入清除范围）。
- 从 Chrome 导入浏览器数据、AI 读取历史的审批设置、地址栏历史联想。
- SPA `pushState` 导航的记录（WRY `on_navigation` 不覆盖，见"已知限制"）。

## 入口设计

### 入口一：浏览器工具栏更多菜单

文件：[WorkspaceBrowserPanel.tsx](../../../../wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx) 的 `ActionMenu`（`workspace-browser-more-button`）。在 `workspace-browser-clear-data-item` **之前**插入：

```ts
{
  label: t('workbench.browser_history'),
  testId: 'workspace-browser-history-item',
  onSelect: () => navigateTo('/settings/browser/history'),
},
```

菜单项无禁用条件（浏览器不可用时不渲染整个菜单，已有逻辑保证）。

### 入口二：设置-浏览器-常规行

文件：[BrowserSettingsPage.tsx](../../../../wework/src/components/settings/BrowserSettingsPage.tsx) "常规" `SettingsGroup` 内、"清除浏览数据"行**之前**新增 `SettingsRow`：

- label：`workbench.browser_settings_history`（"浏览历史"）
- description：`workbench.browser_settings_history_description`（"查看和管理在内置浏览器中访问过的页面"）
- control：次要按钮样式（同"清除浏览数据"按钮，`h-8 rounded-md bg-muted px-3`），文案 `workbench.browser_settings_history_manage`（"管理"），`data-testid="browser-history-manage-button"`，`disabled={controlsDisabled}`，点击 `navigateTo('/settings/browser/history')`。

### 路由

wework 设置页是单页 + nav key 结构（[ConnectionsSettingsPage.tsx](../../../../wework/src/components/settings/ConnectionsSettingsPage.tsx)），`getSettingsNavFromPath` 目前只匹配 `/settings/<key>` 单段路径。方案：

- `getSettingsNavFromPath` 增加：`/settings/browser/history` → activeNav `'browser'`。
- `BrowserSettingsPage` 内部维护子视图状态：根据当前 `location.pathname` 是否为 `/settings/browser/history` 渲染 `BrowserHistoryPage`，否则渲染现有常规内容。历史页页头的返回按钮与面包屑"浏览器"项 `navigateTo('/settings/browser')`。
- 不在设置侧边栏新增 nav 项（历史页是浏览器设置的子页，非顶级设置项）。

## 数据层设计

### 记录模型（Rust）

新模块 `src-tauri/src/embedded_browser/history.rs`：

```rust
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedBrowserHistoryEntry {
    pub id: String,                    // 雪花/UUID，持久化时分配
    pub url: String,
    pub title: Option<String>,
    pub visit_time_ms: i64,            // 毫秒时间戳
}
```

**写入点**（均在 [embedded_browser.rs](../../../../wework/src-tauri/src/embedded_browser.rs) 已有回调内）：

1. `on_page_load`（`PageLoadEvent::Finished`）：复用现有 `loaded_browser_url` 过滤（排除 `about:blank`、映射本地预览页），最终 URL 为 `http`/`https`/`file` 时追加一条记录（本地文件/目录记录的是预览映射后的源 `file://` URL，从历史的条目打开会重新走预览管线）。选择加载完成而非 `on_navigation`，避免记录被拒绝或重定向的请求。
2. 标题与导航绑定：`on_navigation` 时在 webview 条目上标记 `pending_history_url` 并清空旧标题；`on_document_title_changed` 若发生在导航进行中（标题通常先于 Finished 触发）则不回填历史，新标题由 Finished 时的记录直接携带；仅当无进行中导航（加载完成后 JS 改标题）才按当前 URL 回填最近一条无标题记录。
3. favicon：不入库；前端渲染时按 `${origin}/favicon.ico` 直接加载 `<img>`，`onError` 回退默认 Globe 图标。相比 Codex 的 dataURL 存储更轻，代价是图标可能 404 或随站点变化。

**清除竞态**：`EmbeddedBrowserState.history_generation`（原子计数器）。清除浏览数据时先递增 generation 再清空存储；每次导航开始把当前 generation 记到 webview 条目，加载完成记录历史时在 store 锁内校验 generation 未变才写入——清除开始后完成加载的旧页面不会复活已清除的记录。

**持久化**：JSON 文件 `app_data_dir()/browser-history.json`（沿用 `opener_store.rs` 的 app_data_dir 模式，不引入 SQLite）。内存中 `VecDeque`，容量上限 **5000 条**，超出按 FIFO 淘汰；每次变更后写临时文件再 rename 原子落盘，首次访问时懒加载。

### IPC 命令

```
embedded_browser_history_search(
  text: String,            // 空串 = 全部；大小写不敏感，匹配 title 与 url 子串
  end_time_ms: Option<i64>,// 分页游标：上一页末条 visitTimeMs + 1；None = 从头
  offset: u32,             // 游标修正（同一毫秒多条记录）
  max_results: u32,        // 前端固定 100
) -> Vec<EmbeddedBrowserHistoryEntry>   // 按 visitTimeMs 倒序

embedded_browser_history_remove(
  ids: Vec<String>         // 按记录 id 删除，避免同 URL 同毫秒碰撞误删
) -> u32                   // 实际删除条数

embedded_browser_clear_data(dataKinds) // 现有命令，新增 History kind
```

`data_clearing.rs` 的 `EmbeddedBrowserDataKind` 增加 `History` 变体：清除时同时清空历史 JSON 与内存；`kinds == None`（全量清除，对应设置页"清除浏览数据"）时包含 history。

### 前端封装

新文件 `src/lib/embedded-browser-history.ts`：`searchEmbeddedBrowserHistory` / `removeEmbeddedBrowserHistoryEntries`，类型与 Rust 结构对齐（camelCase）。wework 未使用 TanStack Query，历史页用 `useState` + `useEffect` 直接管理分页状态（游标 `endTime`/`offset` 逻辑与 Codex 一致）。

## 历史列表页

新组件 `src/components/settings/BrowserHistoryPage.tsx`（单文件预计 600+ 行，按仓库规范超过 1000 行时拆分 `BrowserHistoryEntryRow` / `BrowserHistoryGroup`）。结构对齐 Codex：

1. **页头**：返回按钮（回 `/settings/browser`）+ 面包屑 `设置 / 浏览器 / 浏览历史` + 标题"浏览历史"。
2. **吸顶搜索框**：placeholder `workbench.browser_history_search`（"搜索浏览历史"），输入 **200ms 防抖**后重新查询；`data-testid="browser-history-search"`。
3. **区块标题行**："全部历史"，右侧按钮：
   - "删除所选"（有勾选时出现；删除中 loading 并禁用）`data-testid="browser-history-remove-selected"`。
   - "清除浏览数据"（复用现有 `ClearBrowserDataDialog`，抽取为共享组件供两个页面使用）。
4. **分组列表**：按 `new Date(visitTimeMs).toDateString()` 分天的折叠组；组头为整行按钮（旋转箭头 + `Intl.DateTimeFormat` 格式化日期，`aria-expanded`/`aria-controls` 完整）；**第一组默认展开**，其余默认折叠。
5. **条目行**（从左到右）：复选框（sr-only label "选择 {title}"）→ favicon（`<img>`，无则默认 Globe 图标）→ 标题（`title || hostname`，truncate）+ secondary 色 hostname → 右侧当天时分（`Intl.DateTimeFormat` hour/minute）→ "..." 菜单（`ActionMenu` 复用）："打开页面"、"从历史记录中删除"。
6. **无限滚动**：底部哨兵 `IntersectionObserver` 触发加载下一页（每页 100）；加载失败显示"无法加载更多浏览历史" + "重试"按钮。

### 交互细节（对齐 Codex）

- **打开条目**：点击标题链接 `preventDefault` 后在内置浏览器中打开该 URL（复用 `openEmbeddedBrowser` 流程）；删除/加载中行整体禁用。
- **单条删除**：`embedded_browser_history_remove([id])`，成功后从选中集合剔除并刷新查询。
- **批量删除**：勾选的记录 id 一次提交；进行中全部行禁用。
- **条目唯一键**为记录 `id`（后端生成）；分组键 `toDateString()`。

### 状态文案

| 状态 | 标题 | 说明/动作 |
| --- | --- | --- |
| 加载中 | "正在加载浏览历史" | spinner |
| 加载失败 | "无法加载浏览历史" | "重试"按钮 |
| 无历史 | "暂无浏览历史" | "在内置浏览器中访问的页面将显示在这里" |
| 搜索无结果 | "没有匹配的页面" | "尝试搜索其他页面或地址" |
| 删除失败 | toast "无法更新浏览历史" | TransientNotice |

### i18n

新增 key 放 `workbench.*` 命名空间，双语同步维护（`src/i18n/locales/en/common.json`、`zh-CN/common.json`）：`browser_history`、`browser_settings_history*`（label/description/manage）、`browser_history_search`、`browser_history_all_time`、`browser_history_remove_selected`、`browser_history_remove`、`browser_history_open_page`、`browser_history_empty*`、`browser_history_no_results*`、`browser_history_loading`、`browser_history_load_error`、`browser_history_pagination_error`、`browser_history_retry`、`browser_history_action_error`。

### data-testid 清单

`workspace-browser-history-item`、`browser-history-manage-button`、`browser-history-page`、`browser-history-back-button`、`browser-history-search`、`browser-history-remove-selected`、`browser-history-clear-data-button`、`browser-history-group-<dateKey>`、`browser-history-entry-<id>`、`browser-history-entry-open-<id>`、`browser-history-entry-remove-<id>`、`browser-history-load-more-sentinel`。

## 已知限制

- WRY `on_navigation` 不覆盖 SPA `pushState`/`replaceState`，v1 不记录此类访问；后续可通过 `on_document_title_changed` + URL 轮询或注入 `history` hook 补齐。
- favicon 按 `${origin}/favicon.ico` 即时加载而非 Codex 的 dataURL 存储，图标可能 404 或随站点变化，前端始终准备默认图标兜底。
- 多 webview 实例共享同一份全局历史（与 Codex 单 session 分区行为一致）。

## 测试

- Rust：`history.rs` 单元测试（追加/标题回填/容量淘汰/搜索过滤/游标分页/删除/持久化往返）。
- 前端 Vitest：`BrowserHistoryPage`（分组、搜索防抖、选中/删除、空/错误/加载态）、`BrowserSettingsPage` 新行、`WorkspaceBrowserPanel` 菜单项顺序与跳转。
- E2E：新增检查点——打开页面产生历史 → 菜单进入历史页 → 搜索/删除 → 清除浏览数据后历史为空。纳入 CI 套件。

## 任务拆分

1. Rust `history.rs` 存储 + IPC 命令 + clear_data 接入（含单元测试）。
2. 前端 `embedded-browser-history.ts` 封装。
3. `BrowserHistoryPage` 组件 + 路由接入。
4. 两个入口（更多菜单项、设置常规行）+ i18n。
5. `ClearBrowserDataDialog` 抽取共享与"删除所选/清除"联动。
6. Vitest + E2E 检查点。

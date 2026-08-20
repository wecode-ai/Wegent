---
sidebar_position: 46
---

# Codex（ChatGPT 桌面端）内置浏览器浏览历史功能分析

> 来源：对 `codex_app_source`（ChatGPT 桌面应用 webview 打包产物）的逆向分析，2026-08-11 版本。
> 关键文件：`webview/assets/app-initial-*.js`（主包，含数据层与桥接）、`webview/assets/browser-use-settings-*.js`（历史设置页 UI）。
> 用途：为 wework 内置浏览器开发浏览历史功能提供参考设计。

## 功能总览

Codex 的浏览历史不是独立的 chrome://history 页面，而是**设置体系内的一个子页面**（路由 `/settings/browser-use/history`），配合三个辅助能力：

1. **历史列表页**：搜索、按天分组、多选删除、单条打开/删除、无限滚动分页。
2. **清除浏览数据对话框**：按时间范围 × 数据类型清除（历史、Cookie、缓存、下载记录、表单数据、网站设置）。
3. **浏览器数据导入**：首次使用引导（NUX）从 Chrome 导入历史、Cookie、密码。
4. **历史访问审批设置**：控制 AI（ChatGPT）是否可以读取浏览历史（每次询问 / 直接允许 / 禁用）。

## 页面入口

| 入口 | 行为 |
| --- | --- |
| 浏览器面板右上角"..."菜单 → `History` 菜单项 | 上报埋点 `CODEX_BROWSER_SURFACE_ACTION_TYPE_HISTORY_SELECTED`，跳转 `/settings/browser-use/history`。菜单项受功能开关 `history.enabled` 控制 |
| 地址栏输入 `chrome://history/` | 被拦截并重定向到同一路由（`chrome://extensions/` 等同理映射到扩展管理页） |
| 设置 → Browser（浏览器使用）页 → `Browsing history` 行 | 行描述为 "View and manage pages visited in the built-in browser"，点击进入历史页 |

## 数据层

### 桥接架构

渲染进程通过 `window.postMessage({type: 'connect-app-host', port})`（MessageChannel）与原生宿主建立 RPC 桥，拿到 `services` 对象。浏览历史是其中的一个服务：`services.browsingHistory`，方法签名（从调用点还原）：

```
searchHistory(query: {
  text: string        // 搜索词，空串表示全部
  startTime: number   // 固定为 0
  endTime?: number    // 分页游标：上一页最后一条 visitTime + 1
  maxResults: number  // 固定 100
  offset: number      // 分页偏移（修正同一毫秒内多条记录）
}): Promise<HistoryEntry[]>

removeEntries(entries: { url: string, visitTime: number }[]): Promise<void>

clearBrowsingData(options: {
  dataTypes: ('history'|'siteData'|'cache'|'downloads'|'formData'|'siteSettings')[]
  timeRange: 'lastHour'|'lastDay'|'lastWeek'|'lastMonth'|'allTime'
}): Promise<void>

getBrowsingDataSettings(): Promise<BrowsingDataSettings>   // 各数据类型的清除策略/默认值
getBrowsingDataSummary(): Promise<{                        // 清除对话框的摘要信息
  history: { siteCount: number, firstSite?: string }
  downloads: { count: number }
  cache: { size: ... }
  ...
}>
```

实际的访问记录（写入）由原生侧完成（Electron session 分区 `persist:codex-browser-app`），webview 前端只读/删除，不负责记录。

### 单条历史记录的数据格式

```ts
interface HistoryEntry {
  id: string              // 记录 id（用于 DOM key 的一部分）
  url: string
  title: string           // 页面标题，可能为空
  visitTime: number       // 毫秒时间戳
  faviconDataURL?: string // data:image/ 开头的 favicon，非法值会被丢弃并回退到默认地球图标
}
```

条目的唯一键为 `` `${url}\0${visitTime}` ``；分组键为 `new Date(visitTime).toDateString()`。

### 前端数据获取（TanStack Query）

- `useInfiniteQuery`，queryKey `['browser-browsing-history', searchText]`，每页 100 条。
- 分页游标：`endTime = 上一页最后一条的 visitTime + 1`，`offset` 累加之前页中 `visitTime < endTime` 的条数，避免同一毫秒多条记录造成的重复/遗漏。
- `staleTime: 5s`，`refetchOnMount: 'always'`，`retry: false`，`placeholderData` 复用其他搜索词的缓存保证切换搜索词时不闪烁。
- 服务不可用时抛 `Browser history is unavailable`，页面重定向回 `/settings/browser-use`。

## 历史列表页 UI 与交互

### 页面结构（自上而下）

1. **页头工具栏**：返回按钮（回 `/settings/browser-use`）+ 面包屑 `Settings / Browser / Browsing history` + 页面标题 "Browsing history"。
2. **吸顶搜索框**（sticky）：placeholder "Search browsing history"，输入 **200ms 防抖** 后驱动查询。
3. **区块标题行**："All-time history"，右侧动作按钮：
   - `Remove selected`（有勾选时出现；无删除权限或删除进行中时禁用，进行中显示 loading）。
   - `Clear browsing data`（打开清除浏览数据对话框）。
4. **分组列表**：按天分组的折叠组（disclosure）。组头是整行按钮：旋转箭头图标 + 格式化日期（`day: numeric, month: short, year: numeric`），`aria-expanded`/`aria-controls` 完整。**第一组默认展开**，其余默认折叠；展开状态存在本地 state（`Set<组key>`），展开/收起切换。
5. **底部无限滚动哨兵**：进入视口自动 `fetchNextPage`；加载下一页失败时显示 "Unable to load more browsing history" + `Try again` 按钮。

### 单条记录行的组成

一行（hover 高亮 `hover:bg-token-list-hover-background`，`focus-within` 同样高亮）从左到右：

- **复选框**（label 包裹，sr-only 文案 "Select {title}"；无删除权限或删除中禁用）。
- **favicon**：`faviconDataURL` 以 `data:image/` 开头则渲染 `<img class="icon-sm rounded-2xs">`，否则渲染默认地球图标。
- **标题 + 域名**：`<a>` 元素，`title || hostname` 为主文案（`truncate`），后接 secondary 颜色的 hostname（`new URL(url).hostname || url`）；整链 hover 下划线，aria-label "Open {title}"。
- **右侧时间**：`FormattedTime` 显示当天时分，`text-sm text-token-text-secondary`。
- **"..." 行内菜单**（aria-label "Actions for {title}"）：
  - `Open page`（带打开图标）
  - `Remove from history`（带删除图标，无权限/进行中禁用）

### 交互细节

- **打开记录**：点击标题链接触发 `preventDefault` 后走内部打开逻辑——若当前会话已有该 URL 的浏览器标签页则聚焦该标签并跳回会话视图，否则在内置浏览器中新建打开；按住修饰键（cmd/ctrl 等）点击走"新标签打开"路径。来源标记为 `open_in_browser_bridge`。
- **单条删除**：`removeEntries([{url, visitTime}])`，成功后从选中集合中剔除并 `invalidateQueries(['browser-browsing-history'])`。
- **批量删除**：勾选项映射为 `{url, visitTime}[]` 一次提交；删除期间全部行禁用（`disabled` 下发到每行）。
- **权限门控**：`browsingDataSettings.dataRemovalPermitted.history === true` 时才允许删除（复选框、Remove selected、Remove from history 均据此禁用）。
- **错误处理**：删除/更新失败弹 danger toast；若错误信息匹配 `/policy|permission|prohibit|denied|not allowed|restricted/i`（企业策略拦截），toast 显示具体策略错误 "Unable to update browsing history: {error}"，否则显示通用 "Unable to update browsing history"。

### 状态文案

| 状态 | 标题 | 描述 |
| --- | --- | --- |
| 加载中 | "Loading browsing history" | — |
| 加载失败 | "Unable to load browsing history" | 附 `Try again` 按钮 |
| 无历史 | "No browsing history yet" | "Pages visited in the built-in browser will appear here" |
| 搜索无结果 | "No matching pages" | "Try searching for a different page or address" |

## 清除浏览数据对话框

- **时间范围**：`Last hour` / `Last 24 hours` / `Last 7 days` / `Last 4 weeks` / `All time`，默认 `lastHour`。
- **数据类型**（复选，默认值来自 `getBrowsingDataSettings()`）：`Browsing history`、`Cookies and site data`、`Cached images and files`、`Download history`、`Autofill form data`、`Site settings`。
- 每类下方显示摘要（来自 `getBrowsingDataSummary(timeRange)`），例如历史的 `From {firstSite} + {n} sites` / `No sites visited`，缓存的 `Current cache size: {size}`，下载的 `{count} downloads`。
- 确认按钮 "Delete data"，取消 "Cancel"；成功后 toast（如 "Browser history cleared"），失败 toast "Unable to clear browsing data"。
- 设置页另有一组逐项清除按钮（Delete browsing history / Delete cookies / Delete cached images and files / Delete download history / Delete site data），可展开/收起（"Show/Hide individual browsing data options"），加上总入口 "Clear all browsing data"。

## 相关辅助功能

- **浏览器数据导入**：NUX 弹窗 "Import from your browser"，可勾选 Cookies / Saved passwords / Browsing history，历史项卖点文案 "Find familiar sites faster"；设置页保留 "Import…" 入口。
- **AI 访问历史审批**（设置 → Permissions）："Choose whether ChatGPT can access your built-in browser history"，三档——`Always ask`（Ask before accessing history）、`Always allow`（Access history without asking，标注 elevated risk）、`Disable`（Do not allow access to history）。保存失败 toast "Unable to save history setting"。
- **地址栏联想**：地址栏下拉（"Address suggestions"）展示匹配项 + "Search the web for '{query}'" 兜底项，历史数据是联想来源之一。

## 对 wework 的落地建议

1. **记录层放在 Rust/Tauri 侧**：参考 Codex 的 session 分区做法，在 wework 的 webview 导航事件（`onNavigation`）里写入本地 SQLite（可复用 `wework` 本地数据目录规范），字段对齐 `id / url / title / visitTime / favicon`。
2. **IPC 接口对齐桥接协议**：`search_history(text, startTime, endTime, maxResults, offset)`、`remove_entries(entries)`、`clear_browsing_data(dataTypes, timeRange)` 三个命令即可覆盖页面全部需求；分页用"末条 visitTime + offset"游标，不要用纯 offset。
3. **UI 复用现有设置页骨架**：wework 已有设置路由与列表行组件，历史页可作为浏览器设置子页，按 Codex 的"面包屑 + 吸顶搜索 + 按天折叠组 + 无限滚动"结构实现。
4. **favicon 存储**：导航时抓取 favicon 存为 data URL 或本地缓存文件，渲染时校验 `data:image/` 前缀并准备默认图标兜底。
5. **权限与策略**：删除能力单独门控（对应 `dataRemovalPermitted`），AI 读取历史需要独立的审批设置（对应 `iabHistoryApproval`），这两个维度在需求阶段就要拆开。

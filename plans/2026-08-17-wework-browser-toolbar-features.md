# Wework 内嵌浏览器工具栏"更多"菜单功能增强 — 需求设计与技术方案

日期：2026-08-17
状态：设计评审稿（未实施）
参照产品：Codex 桌面端（ChatGPT.app 内 Codex 模式，Electron 实现，已从其发布包中逆向分析）

---

## 0. 调研结论：Codex 的产品实现

Codex 桌面端的内嵌浏览器（browser sidebar）基于 Electron `<webview>`，工具栏最右侧"更多"菜单（`thread.browser.options`，aria-label "Browser options"）中包含与本需求相关的四项能力，其实现事实如下（均从 Codex 发布包代码中提取）：

### 0.1 在页面中查找（Find in page）

- 菜单项：`thread.browser.findInPage` = "Find in page"，同时支持快捷键 `Cmd/Ctrl+F`。
- 打开后页面顶部悬浮查找条（find bar）：输入框（placeholder "Find in page"，id 为 `content-search-input`）、匹配计数（`{active} / {matches} results`，无匹配时显示 "0 results"）、上一个/下一个按钮（"Previous result" / "Next result"）、关闭按钮（"Close find"）。
- Codex 的查找条还带范围切换 chip（Search chat / Search browser page / Search diffs），因为它是"线程级查找"。本需求只需浏览器页面查找，不做范围切换。
- 交互细节：打开时自动聚焦并选中输入框；输入即时搜索；`Enter` 下一个、`Shift+Enter` 上一个；`Esc` 或关闭按钮关闭；关闭时清除页面内高亮选区。
- 技术实现：渲染进程下发命令 `open-find` / `close-find` / `find-next` / `find-previous`；主进程调用 Electron `webContents.findInPage(query, { findNext: false, forward })`，监听 `found-in-page` 事件回传 `{ query, matches, activeMatchOrdinal }` 状态（消息 `browser-sidebar-find-state`）；关闭时调用 `stopFindInPage('clearSelection')`。查找状态按 tab 保存。

### 0.2 缩放（Zoom）

- 菜单内嵌一行缩放控件（role=group，aria-label "Zoom"）：`-` 按钮、当前百分比文本（`{zoomPercent}%`，等宽数字）、`+` 按钮；到达上下限时对应按钮 disabled。
- 缩放档位阶梯（与 Chrome 一致）：`[25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]`。
- 快捷键：`Cmd/Ctrl+=`（含 `Shift+=`）放大、`Cmd/Ctrl+-` 缩小、`Cmd/Ctrl+0` 重置为 100%。
- 缩放操作后，页面右上角弹出 2 秒自动消失的悬浮条（zoom banner）：显示当前百分比、`-`/`+` 按钮、"Reset" 按钮（100% 时禁用）；鼠标悬停时不消失，移开后重新计时；图标带按下缩放动画。
- 技术实现：命令 `step-zoom {delta: ±1}` / `reset-zoom` / `set-zoom-percent`；主进程按档位阶梯计算新百分比并 `webContents.setZoomFactor(percent/100)`；缩放比例按 tab 持久化在 tab 快照（`zoomPercent`）中，切换 tab / 重开面板后恢复。

### 0.3 显示设备工具栏（Show device toolbar）

- 菜单项是开关：`thread.browser.options.showDeviceToolbar` = "Show device toolbar" / `hideDeviceToolbar` = "Hide device toolbar"，选中后上报埋点 `SHOW_DEVICE_TOOLBAR_SELECTED`。
- 打开后页面视口上方出现一条设备工具栏，包含：
  - 设备预设下拉：`Responsive`（默认，390×844）、`iPhone SE`（375×667）、`iPhone 15 Pro`（393×852）、`iPhone 15 Pro Max`（430×932）、`Pixel 8`（412×915）、`iPad Mini`（768×1024）、`iPad Air`（820×1180）、`Surface Duo`（540×720）、`Surface Pro 7`（912×1368）、`Laptop`（1024×768）、`Laptop L`（1440×900）、`4K`（2560×1440）。
  - "Dimensions:" 宽×高输入框（aria-label "Viewport width" / "Viewport height"）。
  - 旋转按钮（"Rotate viewport"，交换宽高）。
  - 缩放下拉（"Browser zoom"，适配/百分比选项）。
  - 关闭按钮（"Exit device toolbar mode"）。
- 视口四周有拖拽手柄（左、右、下、左下、右下）可直接改尺寸；预设改为自定义尺寸时自动变为 Responsive。
- 技术实现：主进程 `webContents.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 1, mobile: false })`；当设备尺寸大于面板可用区域时计算 `viewportScale` 对 webview 做等比缩放适配（fit）；设备工具栏状态（`{ isEnabled, presetId, width, height }`）按 tab 保存，切换/恢复 tab 时保留。

### 0.4 浏览器设置（Browser settings）

- 菜单项：`thread.browser.browserSettings` = "Browser settings"，点击后跳转到应用设置 → Browser 页（Codex 设置导航 `settings.nav.browser-use`）。
- Codex 的设置页内还内嵌了 `chrome://settings` 风格的 webview（History / 密码管理器 / Site settings / Extensions / Contact info），本需求不含这部分，只需跳转。

---

## 1. 需求设计

### 1.1 范围

**范围内（scope in）**

1. 浏览器工具栏"更多"菜单新增"在页面中查找"：打开页面顶部查找条，支持即时查找、匹配计数、上一个/下一个、关闭；快捷键 `Cmd/Ctrl+F`；仅作用于内嵌浏览器当前页面。
2. "更多"菜单新增"缩放"行：`-` / 百分比 / `+`，档位阶梯与 Codex 一致；快捷键 `Cmd/Ctrl+=`、`Cmd/Ctrl+-`、`Cmd/Ctrl+0`；缩放后显示 2 秒自动消失的缩放提示条（含 Reset）。
3. "更多"菜单新增"显示设备工具栏/隐藏设备工具栏"开关：设备工具栏含预设下拉、宽高输入、旋转、缩放下拉、关闭；视口边缘拖拽手柄；按 tab 记忆状态。
4. "更多"菜单新增"浏览器设置"：跳转到 Wework 设置 → 浏览器页（已有 `/settings/browser` 路由与 `BrowserSettingsPage`）。

**范围外（scope out）**

- 查找的 chat/diff 范围切换（Wework 浏览器面板不属于线程查找场景）。
- Codex 设备工具栏的 User-Agent 模拟、deviceScaleFactor/mobile 触摸模拟（wry 不支持，见 2.3）。
- 浏览器设置页内的 chrome:// 内嵌页面、打印、扩展管理、导入 Cookie 等 Codex 其他菜单项。
- 跨会话磁盘持久化缩放/设备工具栏（首期内存态，随浏览器会话生命周期）。

### 1.2 交互定义（对齐 Codex）

**菜单结构**（"更多"菜单，自上而下）：

- 在页面中查找（快捷键标注 `Cmd+F`）
- 缩放（内嵌控件行：`-` `100%` `+`）
- 显示设备工具栏（开关项，开启时文案变为"隐藏设备工具栏"）
- 分隔线
- 浏览器设置
- 分隔线
- 清除浏览数据（现有子菜单，保持不动）

**在页面中查找**

- 打开：菜单点击或 `Cmd/Ctrl+F`（浏览器面板获得焦点时）。打开后查找条显示在工具栏下方（与标注模式 bar 同样的位置与高度风格），输入框自动聚焦并全选。
- 输入即搜（防抖约 150ms），结果显示 `n / m`，无结果显示 `0 results`。
- `Enter` 下一个并滚动到可视区域居中，`Shift+Enter` 上一个；`Esc` 关闭并清除高亮。
- 页面跳转/刷新后：已有关键词自动在新页面重搜；关闭浏览器或切换面板时查找条关闭。
- 无页面（空态/内部桌面页）时菜单项 disabled。

**缩放**

- 档位：`[25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]`。
- 菜单内 `-`/`+` 沿档位步进；百分比文本等宽数字居中；到达 25% 或 500% 时对应按钮禁用；点击 `-`/`+` 后菜单保持打开（对齐 Chrome/Codex 菜单行为）。
- 快捷键作用于当前活跃浏览器 tab。
- 缩放提示条：页面区域右上角浮层，圆角 12px、毛玻璃背景（对齐 Codex `bg-token-dropdown-background/90 backdrop-blur-sm`），内容：`{percent}%`、`-`/`+` 按钮组、"重置"按钮（100% 时禁用）；每次缩放重置 2 秒消失计时，悬停暂停。
- 缩放按 tab 记忆，切换 tab 恢复各自缩放。

**显示设备工具栏**

- 开启后页面视口上方出现设备工具栏（高度约 40px），从左到右：预设下拉、"Dimensions:"、宽输入、×、高输入、旋转按钮、缩放下拉、关闭按钮。
- 预设列表与 Codex 对齐（见 0.3）；选预设即改宽高并应用；手动改宽高/拖拽手柄后预设显示为 Responsive。
- 旋转按钮交换宽、高。
- 缩放下拉提供"适应面板（Fit）"与 50%–200% 档位；当设备尺寸超出面板可用区域时默认自动等比缩小适配。
- 视口左/右/下边缘及左下/右下角落提供拖拽手柄，拖拽实时改尺寸。
- 页面区域按设备视口居中显示，四周用中性深色背景衬底（对齐 Chrome DevTools device mode 观感）。
- 关闭：工具栏关闭按钮或再次点击菜单开关；按 tab 记忆 `{ isEnabled, presetId, width, height, zoomMode }`。

**浏览器设置**

- 点击后 `navigateTo('/settings/browser')`，设置页左侧导航选中"浏览器"（现有 `getSettingsNavFromPath` 已支持该深链）。

### 1.3 data-testid 约定（遵循 AGENTS.md）

所有新交互元素带 `data-testid`：

- `workspace-browser-find-item` / `workspace-browser-find-bar` / `workspace-browser-find-input` / `workspace-browser-find-count` / `workspace-browser-find-prev-button` / `workspace-browser-find-next-button` / `workspace-browser-find-close-button`
- `workspace-browser-zoom-out-button` / `workspace-browser-zoom-in-button` / `workspace-browser-zoom-label` / `workspace-browser-zoom-banner` / `workspace-browser-zoom-reset-button`
- `workspace-browser-device-toolbar-item` / `workspace-browser-device-toolbar` / `workspace-browser-device-preset-select` / `workspace-browser-device-width-input` / `workspace-browser-device-height-input` / `workspace-browser-device-rotate-button` / `workspace-browser-device-zoom-select` / `workspace-browser-device-close-button` / `workspace-browser-device-resize-{left,right,bottom,bottom-left,bottom-right}`
- `workspace-browser-settings-item`

---

## 2. 技术方案

### 2.0 总体约束

Wework 内嵌浏览器是 **Tauri v2 + wry 0.55** 的原生 webview（macOS WKWebView / Windows WebView2 / Linux WebKitGTK），通过 `src/lib/embedded-browser.ts` 的 invoke 命令 + 事件桥接驱动（`src-tauri/src/embedded_browser.rs`）。与 Codex 的 Electron 能力差异决定三个功能三条实现路径：

| 功能 | Codex（Electron） | Wework（wry）可行路径 |
| --- | --- | --- |
| 页面查找 | `webContents.findInPage` 原生 | wry 无查找 API → JS 注入实现（复用 annotation 注入模式） |
| 缩放 | `setZoomFactor` | `Webview::set_zoom(f64)` 原生支持 |
| 设备工具栏 | `setDeviceMetricsOverride` | wry 无 metrics override → 真实调整 webview bounds + `set_zoom` 适配 |

### 2.1 在页面中查找（JS 注入方案）

**页面侧运行时**（新文件 `src/components/layout/workspace-panels/browser-find/injection-script.ts`，模式对齐 `browser-annotation/injection-script.ts`）：

- 注入全局 `window.__WEWORK_BROWSER_FIND__`，暴露 `search(query)` / `next()` / `prev()` / `clear()` / `state()`。
- 实现：`TreeWalker` 遍历可见文本节点（跳过 `script/style/noscript`、隐藏元素），按不区分大小写匹配；命中片段用带 class 的 `<mark>` 包裹并计数；当前命中用高对比色 `outline` 标记并 `scrollIntoView({ block: 'center' })`。
- `clear()` 时把所有 `<mark>` 展平还原 DOM 并合并文本节点。
- 注入时机：沿用现有 `evalEmbeddedBrowser` 通道惰性注入（首次打开查找条时 eval 注入脚本 + 执行）；页面 `url` 变化后由面板层重新注入并重搜（监听现有 `listenEmbeddedBrowserPageStateChanges`）。
- 不在 `src-tauri` 加常驻 initialization script，避免影响所有页面加载性能与兼容性。

**面板侧**（`WorkspaceBrowserPanel.tsx` 内新增受控状态 + 子组件 `BrowserFindBar.tsx`）：

- 状态：`findOpen`、`findQuery`、`findState { active, matches }`（每次 eval 返回的最新结果）。
- 命令封装到新模块 `browser-find-store.ts`：`openFind/closeFind/searchFind/stepFind(label, direction)`，内部走 `evalEmbeddedBrowserJson`。
- 快捷键：在浏览器面板根节点监听 `Cmd/Ctrl+F`（拦截并阻止冒泡，避免触发其他全局查找），`Enter`/`Shift+Enter`/`Esc` 在输入框 `onKeyDown` 处理。
- 失败兜底：注入失败（如 CSP 严格页面或内部桌面页）时查找条显示不可用提示并禁用输入。

### 2.2 缩放（原生 set_zoom 方案）

**Rust 侧**（`src-tauri/src/embedded_browser.rs`）：

- 新增命令 `embedded_browser_set_zoom(label, scale_factor: f64)`：取 `ready_webview()` 后调用 `webview.set_zoom(scale_factor)`（wry `WebView::zoom`，三端均支持）。
- 在 `src-tauri` capabilities 中确认/添加 `core:webview:allow-set-webview-zoom` 权限。
- 页面条目状态增加 `zoom_percent: u32`（默认 100），导航/恢复时不重置。

**TS 侧**：

- `src/lib/embedded-browser.ts` 增加 `setEmbeddedBrowserZoom(label, percent)`；常量 `BROWSER_ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]` 与 `stepZoomPercent(current, delta)`（取相邻档位）放 `src/lib/browser-zoom.ts`（纯函数，便于单测）。
- 面板状态：每 tab `zoomPercent`（内存 Map<label, number>），切换 tab 时读取并 `set_zoom` 恢复。
- UI：菜单内缩放行（自定义 `label` 渲染，点击不关闭菜单）；`BrowserZoomBanner.tsx` 浮层组件（2 秒自动隐藏、悬停暂停、Reset）。
- 快捷键：面板根节点监听 `Cmd/Ctrl+=` / `Cmd/Ctrl+-` / `Cmd/Ctrl+0`。

### 2.3 设备工具栏（bounds + zoom 方案）

**核心思路**：wry 没有 `setDeviceMetricsOverride`，但 wework 的 webview 本身就是通过 `embedded_browser_set_bounds` 绝对定位的子视图。把 webview 的实际 bounds 改为设备尺寸即可让页面按设备宽度布局（媒体查询、viewport 单位全部自然生效），真实度高于 CSS transform 方案。

**Rust 侧**：无需新命令，复用 `embedded_browser_set_bounds` 与新增的 `embedded_browser_set_zoom`。

**TS 侧**（新模块 `src/lib/browser-device-toolbar.ts` + 面板子组件 `BrowserDeviceToolbar.tsx`）：

- 状态按 tab：`{ isEnabled, presetId, width, height, zoomMode: 'fit' | number }`，预设表与 Codex 对齐（见 0.3）。
- bounds 计算：面板容器可用区域 `R`（扣掉工具栏与设备工具栏高度）：
  - 目标视口 `w×h`；
  - `zoomMode === 'fit'` 时 `scale = min(1, R.w / w, R.h / h)`；定档缩放时 `scale = percent/100`；
  - 若 `scale === 1`：webview bounds = 居中后的 `w×h`；
  - 若 `scale < 1`：webview bounds 仍为 `w×h`（保证布局宽度 = 设备宽度），调用 `set_zoom(scale)` 视觉缩小，并按 `w*scale × h*scale` 居中放置；三端 `set_zoom` 均为整页缩放，视觉对齐 DevTools 的 fit 行为（近似，见风险 R2）。
- 关闭时恢复面板原有 bounds 计算逻辑（现有 `setEmbeddedBrowserBounds` 路径）并恢复该 tab 的页面缩放。
- 交互：宽高输入（数字，Enter 生效）、旋转（交换 w/h）、边缘/角落拖拽手柄（pointer events 实时更新）、预设选择；均走同一 `applyDeviceViewport` 纯函数入口。
- 与"页面缩放"的叠加：设备工具栏的 fit 缩放与 2.2 的页面缩放相乘（`set_zoom(pageZoom * fitScale)`），UI 上设备工具栏开启时缩放提示条只显示页面缩放部分。

### 2.4 浏览器设置

- 菜单项 `onSelect: () => navigateTo('/settings/browser')`。现有 `ConnectionsSettingsPage` 的 `getSettingsNavFromPath('/settings/browser')` 已命中 `browser` 导航项，无需改设置页。

### 2.5 文件与改动清单

| 文件 | 改动 |
| --- | --- |
| `src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx` | "更多"菜单新增 4 项；挂载查找条/缩放提示条/设备工具栏；快捷键监听；每 tab 状态 |
| `src/components/layout/workspace-panels/browser-find/injection-script.ts`（新） | 页面内查找运行时 |
| `src/components/layout/workspace-panels/browser-find/BrowserFindBar.tsx`（新） | 查找条 UI |
| `src/components/layout/workspace-panels/browser-find/browser-find-store.ts`（新） | eval 命令封装 |
| `src/components/layout/workspace-panels/BrowserZoomBanner.tsx`（新） | 缩放提示条 |
| `src/lib/browser-zoom.ts`（新） | 缩放档位与纯函数 |
| `src/components/layout/workspace-panels/BrowserDeviceToolbar.tsx`（新） | 设备工具栏 UI + 手柄 |
| `src/lib/browser-device-toolbar.ts`（新） | 预设表、bounds/scale 计算纯函数 |
| `src/lib/embedded-browser.ts` | 新增 `setEmbeddedBrowserZoom`；页面状态类型扩展 |
| `src-tauri/src/embedded_browser.rs` | 新增 `embedded_browser_set_zoom` 命令；entry 增加 `zoom_percent` |
| `src-tauri` capabilities / `lib.rs` | 注册命令与 `allow-set-webview-zoom` 权限 |
| `src/i18n/locales/en` / `zh-CN`（workbench 命名空间） | 全部新文案中英双语 |

### 2.6 测试

- 单测（Vitest）：`browser-zoom` 档位步进纯函数；`browser-device-toolbar` 的 bounds/scale 计算；菜单项渲染与禁用态；查找条交互（mock eval 层）；Rust 侧 `set_zoom` 命令的参数校验。
- E2E：沿用现有 workspace browser 面板 E2E 套件（真实 Tauri 会话），覆盖：打开查找并跳转匹配、缩放档位与提示条、设备工具栏切换与旋转、菜单跳转 `/settings/browser`；全部接入 CI 已覆盖的套件，不新增 CI 不跑的脚本。

### 2.7 风险

- R1（查找）：JS 注入查找在 CSP 严格或重 JS 页面上可能注入失败或高亮被页面脚本清除；缓解：惰性注入 + 失败提示，`<mark>` 方案不使用 Shadow DOM，接受极端页面降级。
- R2（设备工具栏）：wry 无法像 Chromium 那样只缩放视觉而不改布局；`set_zoom` 是整页缩放，`scale < 1` 时滚动条尺寸与截图坐标会有偏差。验收标准按"布局宽度正确 + 视觉近似"定义，不追求与 DevTools 像素级一致。
- R3（缩放）：Linux WebKitGTK 的 `set_zoom` 行为与 macOS/Windows 略有差异（文本缩放 vs 页面缩放），需在三端冒烟。
- R4：快捷键与现有全局命令面板/系统快捷键冲突，需在 macOS 与 Windows 各验证一遍。

### 2.8 验收标准

1. "更多"菜单四项均可见、有 `data-testid`、中英双语；无页面时查找/设备工具栏项禁用。
2. 查找：输入即时出计数，Enter/Shift+Enter 循环跳转并滚动居中，Esc 关闭并清除高亮；页面跳转后自动重搜。
3. 缩放：档位与 Codex 一致，`Cmd/Ctrl+=` `-` `0` 生效，提示条 2 秒消失、悬停暂停、Reset 回 100%；切 tab 恢复各自缩放。
4. 设备工具栏：预设/输入/旋转/拖拽均改变实际布局宽度；超出面板时自动 fit；关闭后完全恢复。
5. 浏览器设置：一键进入设置-浏览器页。
6. `pnpm --filter wework test`、prettier、eslint 全绿；相关 E2E 在 CI 套件中通过。

---

## 3. 任务拆解

| # | 任务 | 角色 |
| --- | --- | --- |
| T1 | Rust：`embedded_browser_set_zoom` 命令 + 权限 + entry 状态 | developer |
| T2 | TS：browser-zoom 纯函数 + set_zoom 封装 + 菜单缩放行 + 提示条 + 快捷键 | developer |
| T3 | 查找：注入脚本 + find store + 查找条 UI + 快捷键 | developer |
| T4 | 设备工具栏：预设/计算纯函数 + 工具栏 UI + bounds 接管/恢复 | developer |
| T5 | 菜单"浏览器设置"跳转 + 菜单结构重组 | developer |
| T6 | i18n 文案（中英）+ data-testid 梳理 | developer |
| T7 | 单测 + E2E + 三端冒烟 | developer |
| T8 | 方案评审与范围冻结 | owner |

> 建议落地顺序：T5 → T2（依赖 T1） → T3 → T4 → T6/T7。T3、T4 相互独立可并行。

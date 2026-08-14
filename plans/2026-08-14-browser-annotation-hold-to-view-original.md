---
sidebar_position: 4
created: 2026-08-14
---

# 浏览器批注「按住查看原始页面」功能实现文档

## 一、结论

按 Codex 桌面版（`com.openai.codex` v26.803.41515）的实现，为 Wework 内置浏览器批注工具栏增加「按住查看原始页面」按钮：

- 按钮位于批注模式顶部工具栏（`WorkspaceBrowserPanel` 的批注工具栏），位置在「发送/发布」之前；
- 仅在当前批注列表中存在**样式调整（tweaks）**时可用（Codex 的 `hasQueuedTweaks`）；
- 按住（`pointerdown` 或键盘 `Space`/`Enter`）期间，页面临时还原为原始样式，同时中间标题从「正在批注 · url」切换为「原网页 · url」；
- 松开、失焦或 `pointercancel` 后，页面恢复已排队的调整；
- 图标、tooltip 文案、`aria-pressed`、禁用语义与 Codex 一致。

## 二、Codex 实现证据

### 2.1 组件与状态

文件：`webview/assets/app-initial-Biw83Aiz.js`

- 工具栏组件 `JVo`（偏移约 8579550）：

```js
// 从 props 解构
{
  hasPendingAnnotations: o,
  hasQueuedTweaks: s,
  isOriginalViewEnabled: l,
  onOriginalViewBlur: m,
  onOriginalViewKeyDown: h,
  onOriginalViewKeyUp: g,
  onOriginalViewPointerCancel: _,
  onOriginalViewPointerDown: v,
  onOriginalViewPointerUp: y,
}

// tooltip / aria-label
w = C.formatMessage({
  id: 'thread.browser.tweaks.holdToViewOriginal',
  defaultMessage: 'Hold to view original',
  description: 'Tooltip and aria label for the button that shows the original page without tweaks applied while pressed',
})

// 按钮
th({
  'aria-label': w,
  'aria-pressed': l,
  color: l ? 'ghostActive' : 'ghost',
  size: 'toolbar',
  title: w,
  uniform: true,
  disabled: !s,                       // 没有已排队 tweaks 时禁用
  onBlur: m,
  onKeyDown: h,
  onKeyUp: g,
  onPointerCancel: _,
  onPointerDown: v,
  onPointerUp: y,
  children: (
    <span className={
      'inline-flex items-center justify-center transition-transform duration-basic motion-reduce:transition-none ' +
      (l && 'scale-[0.8]')
    }>
      {l ? <NVo className="icon-sm" /> : <AVo className="icon-sm" />}  {/* 按下时眼睛带斜线，缩放 0.8 */}
    </span>
  )
})
```

标题（按住时切换）：

```js
H = l
  ? <FormattedMessage id="thread.browser.tweaks.originalTitle" defaultMessage="Original • {url}" …/>
  : <FormattedMessage id="thread.browser.tweaks.title" defaultMessage="Annotating • {url}" …/>
```

### 2.2 图标（Codex 原始 SVG path，20×20，fill currentColor）

普通「眼睛」（`AVo`）：

```
M8.50195 17.5V16.498H6.5C5.81091 16.498 5.25395 16.4987 4.80371 16.4619C4.40303 16.4292 4.04237 16.364 3.70606 16.2197L3.56348 16.1533C3.04236 15.8878 2.60586 15.4841 2.30176 14.9883L2.17969 14.7705C1.98772 14.3937 1.90851 13.9873 1.87109 13.5293C1.83432 13.0791 1.83496 12.522 1.83496 11.833V8.16699C1.83496 7.478 1.83432 6.92091 1.87109 6.4707C1.90851 6.0127 1.98772 5.60625 2.17969 5.22949L2.30176 5.01172C2.60586 4.5159 3.04236 4.1122 3.56348 3.84668L3.70606 3.78027C4.04237 3.636 4.40303 3.57083 4.80371 3.53809C5.25395 3.5013 5.81091 3.50195 6.5 3.50195H8.50195V2.5C8.50195 2.13273 8.79972 1.83496 9.16699 1.83496C9.53411 1.83514 9.83203 2.13284 9.83203 2.5V17.5C9.83203 17.8672 9.53411 18.1649 9.16699 18.165C8.79972 18.165 8.50195 17.8673 8.50195 17.5ZM16.835 11.833V8.16699C16.835 7.4561 16.8341 6.96259 16.8027 6.5791C16.7797 6.29739 16.7428 6.1076 16.6914 5.96387L16.6348 5.83398C16.4808 5.53176 16.2466 5.27886 15.959 5.10254L15.833 5.03125C15.675 4.9508 15.4635 4.89397 15.0879 4.86328C14.7044 4.83195 14.211 4.83203 13.5 4.83203H12.5C12.1328 4.83203 11.8351 4.53411 11.835 4.16699C11.835 3.79972 12.1327 3.50195 12.5 3.50195H13.5C14.1891 3.50195 14.746 3.5013 15.1963 3.53809C15.6541 3.5755 16.0599 3.65483 16.4365 3.84668L16.6553 3.96875C17.1509 4.27282 17.5549 4.70856 17.8203 5.22949L17.8867 5.37207C18.0311 5.70855 18.0961 6.06979 18.1289 6.4707C18.1657 6.92091 18.165 7.478 18.165 8.16699V11.833C18.165 12.522 18.1657 13.0791 18.1289 13.5293C18.0961 13.9302 18.0311 14.2914 17.8867 14.6279L17.8203 14.7705C17.5549 15.2914 17.1509 15.7272 16.6553 16.0312L16.4365 16.1533C16.0599 16.3452 15.6541 16.4245 15.1963 16.4619C14.746 16.4987 14.1891 16.498 13.5 16.498H12.5C12.1327 16.498 11.835 16.2003 11.835 15.833C11.8351 15.4659 12.1328 15.168 12.5 15.168H13.5C14.211 15.168 14.7044 15.1681 15.0879 15.1367C15.4635 15.106 15.675 15.0492 15.833 14.9688L15.959 14.8975C16.2466 14.7211 16.4808 14.4682 16.6348 14.166L16.6914 14.0361C16.7428 13.8924 16.7797 13.7026 16.8027 13.4209C16.8341 13.0374 16.835 12.5439 16.835 11.833Z
```

按下时「眼睛带斜线」（`NVo`）在普通眼睛基础上增加：

```
M3.16504 11.833C3.16504 12.5439 3.16595 13.0374 3.19727 13.4209C3.22795 13.7965 3.28478 14.008 3.36524 14.166L3.43555 14.293C3.61186 14.5804 3.86488 14.8148 4.16699 14.9688L4.29688 15.0244C4.44065 15.0759 4.6021 15.1167 4.7725 15.1481L3.26013 16.7501C2.98382 17.049 3.01822 17.5198 3.33734 17.7341C3.63373 17.9333 4.04444 17.8667 4.26816 17.6251L11.5435 9.67934C11.7375 9.45741 11.7047 9.12753 11.4624 8.94551C11.2303 8.78669 10.9187 8.78911 10.7261 8.99983L3.16504 11.833ZM16.7005 10.4814C16.8404 10.6582 16.88 10.8534 16.7992 10.9698C16.6982 11.0864 16.6063 11.2251 16.5394 11.3935C16.4229 11.6894 16.3539 11.9974 16.3343 12.3106C16.3182 12.5668 16.2619 12.815 16.1672 13.0501L16.124 13.1764C16.0123 13.4719 15.8415 13.7402 15.6236 13.9647L15.4308 14.1801L17.3971 12.0618C17.7 11.7297 17.6586 11.2544 17.2998 11.0136C16.9799 10.7991 16.5405 10.9042 16.7005 11.2238V10.4814Z
```

### 2.3 运行状态与事件

```js
// 状态：holding
const [isHeld, setHeld] = useState(false)   // er=setHeld(true), tr=setHeld(false)

// 计算
Jn = yt && dt && it.isHeld   // yt=comment mode 开，dt=hasQueuedTweaks，it.isHeld=按住中

// 键盘：Space/Enter 按住/松开
rr = e => { if (!isKeyLikeSpaceOrEnter(e.key) || e.repeat) return; e.preventDefault(); er() }   // keydown
ar = e => { if (!isKeyLikeSpaceOrEnter(e.key)) return; e.preventDefault(); tr() }              // keyup

// 指针
nr = e => { e.currentTarget.setPointerCapture?.(e.pointerId); er() }   // pointerdown
ir = e => { e.currentTarget.hasPointerCapture?.(e.pointerId) && e.currentTarget.releasePointerCapture(e.pointerId); tr() }  // pointerup
or = e => { e.currentTarget.hasPointerCapture?.(e.pointerId) && e.currentTarget.releasePointerCapture(e.pointerId); setHeld(false) }  // pointercancel
tr = () => setHeld(false)   // blur

// 状态同步到页面 runtime
useEffect(() => {
  dispatchMessage('browser-sidebar-command', {
    browserTabId,
    conversationId,
    command: { type: 'set-original-view-enabled', enabled: isOriginalViewEnabled },
  })
}, [isOriginalViewEnabled])
```

### 2.4 页面 runtime 命令

文件：`.vite/build/browser-page-preload.js`

```js
case 'set-original-view-enabled':
  if (enabled) {
    restoreAll()   // 恢复所有 baseline（原始样式）
  } else {
    // 重放所有已排队注释的调整
    comments.forEach(c => c.adjustments.forEach(a => applyAdjustment(c.element, a)))
  }
  break
```

## 三、Wework 落地方案

### 3.1 数据与语义

- `hasQueuedTweaks` = `annotations.some(a => a.adjustments.length > 0)`（已保存到快照、尚未发送给模型的调整）；
- `isOriginalViewEnabled` = `annotationMode && hasQueuedTweaks && originalViewHeld`；
- 按钮放在批注模式工具栏 `Send/发布` 之前；`disabled = !hasQueuedTweaks`；
- 按住期间标题切换为「原网页 · site」，松开恢复「正在批注 · site」。

### 3.2 文件改动

| 文件 | 改动 |
| --- | --- |
| `wework/src/components/layout/workspace-panels/browser-annotation/injection-script.ts` | 新增 `replayAll()`；新增 `api.setOriginalViewEnabled(enabled)`；`restoreAll` 保持原样 |
| `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx` | 新增 `originalViewHeld` 状态、按住按钮（Codex 图标）、标题切换、`setOriginalViewEnabled` 命令调用 |
| `wework/src/i18n/locales/en/common.json` | `browser_annotation_hold_to_view_original` = "Hold to view original"；`browser_annotation_original_title` = "Original · {{site}}" |
| `wework/src/i18n/locales/zh-CN/common.json` | `browser_annotation_hold_to_view_original` = "按住查看原始页面"；`browser_annotation_original_title` = "原网页 · {{site}}" |
| 测试 | 注入脚本 API 单测 + 组件测试（如果适用），real Tauri 验证 |

### 3.3 注入脚本 runtime 行为

```js
const replayAll = () => {
  restoreAll()
  state.annotations
    .filter(annotation => annotation.element?.isConnected)
    .sort((a, b) => a.number - b.number)
    .forEach(annotation =>
      annotation.adjustments.forEach(adjustment => applyAdjustment(annotation.element, adjustment))
    )
}

const api = {
  …,
  setOriginalViewEnabled(enabled) {
    if (enabled) restoreAll()
    else replayAll()
    return snapshot()
  },
}
```

> `restoreAll()` 只恢复有 baseline 的元素；`replayAll()` 先恢复所有基线再重放已排队注释的调整，与 Codex runtime 一致。

### 3.4 工具栏按钮交互

```jsx
<button
  data-testid="workspace-browser-annotation-original-view-button"
  aria-pressed={originalViewEnabled}
  aria-label={t('workbench.browser_annotation_hold_to_view_original')}
  title={t('workbench.browser_annotation_hold_to_view_original')}
  disabled={!hasQueuedTweaks}
  onBlur={releaseOriginalView}
  onKeyDown={handleOriginalViewKeyDown}   // Space/Enter，排除 repeat
  onKeyUp={handleOriginalViewKeyUp}
  onPointerCancel={cancelOriginalView}
  onPointerDown={holdOriginalView}
  onPointerUp={releaseOriginalView}
>
  <span className={originalViewEnabled ? 'scale-90' : undefined}>
    <OriginalViewIcon />  {/* 按住时 NVo 眼睛斜线 */}
  </span>
</button>
```

按住时调用 `evalEmbeddedBrowser('window.__WEWORK_BROWSER_ANNOTATION__?.setOriginalViewEnabled?.(true) ?? true', label)`；松开/取消/失焦时传 `false`。页面不可用或已退出批注时自动忽略。

## 四、测试方案（QA）

1. 无调整时按钮禁用（`disabled`），按住无效果；
2. 添加一个含样式调整的批注后，按钮可用；
3. 按住按钮：页面样式恢复原样，标题变为「原网页 · site」，图标变为带斜线眼睛；
4. 松开按钮：页面恢复调整后样式，标题回到「正在批注 · site」；
5. 键盘 `Space`/`Enter` 按住与松开行为等价；重复触发（repeat）不抖动；
6. `pointercancel` / blur（含按钮外的 blur）安全恢复；
7. 退出批注模式、清空批注后按钮消失或不可用；
8. 多批注、多个元素调整时全部原始样式同时还原、同时恢复；
9. 深色模式下样式与现有批注工具栏一致。

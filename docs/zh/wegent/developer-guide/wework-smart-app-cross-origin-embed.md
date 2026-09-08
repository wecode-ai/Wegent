---
sidebar_position: 30
---

# Wework Smart App 跨域 iframe 与区域截图

本文说明 Smart App 在 Wework 中嵌入跨域页面并把局部截图交给插件的通用架构。
宿主能力与业务域名无关，不应在 Wework 源码中维护站点白名单。

## 结论

跨域页面继续使用普通 iframe。Smart App、iframe、插件弹窗和其他控件由同一个
WebContents 合成，因此 CSS 层级、点击、滚动、焦点和生命周期都遵循标准 Web 语义。

截图由宿主对调用插件所属的 Smart App WebContents 执行：插件只上报 iframe 的
`getBoundingClientRect()`，宿主通过 scoped HostPipe 找到 owner，然后调用
`capturePage(rect)`。跨域 iframe 的 OOPIF 像素属于 owner WebContents 的最终合成结果，
插件不需要读取 iframe DOM，也不需要桌面录屏权限。

```text
BrowserWindow
  └─ Smart App <webview>（owner）
       ├─ 插件 UI
       └─ 跨域 <iframe>

iframe DOMRect
  → dshCapture.ownerRect
  → owner WebContents.capturePage(rect)
  → PNG data URL
```

## 为什么不使用原生 Surface

`WebContentsView` 属于 BrowserWindow 的原生 View 树，不属于 Smart App DOM 合成树。
它不能附着到普通 DOM 节点，也不能与插件弹窗按 CSS `z-index` 混排。用 bounds、显隐、
遮挡矩形或 clip-path 模拟 DOM 行为，会引入以下结构性问题：

- 原生内容覆盖插件 UI 并抢占输入；
- 弹窗打开时只能隐藏原生内容，表现为黑屏；
- tab 可见性与原生 View 生命周期需要额外同步；
- 截图前后的显隐切换容易产生竞态；
- 每新增一种覆盖层都要修改遮挡规则。

因此 `dshSurface.open/setBounds/navigate/capture/close` 不应作为 Smart App 局部网页的
呈现抽象。

## 登录约束

Wework 不绕过目标站点的浏览器安全策略。iframe 登录需要目标站点同时满足：

1. 允许通过 CSP `frame-ancestors` 嵌入（不要依赖 `X-Frame-Options`——它无法表达跨域白名单，
   其 `ALLOW-FROM` 指令已废弃）；
2. 登录完成后在当前 frame 导航，不强制修改 `top` 或 `parent`；
3. 登录 Cookie 在嵌入上下文可被接受和发送，例如使用合适的 `SameSite=None; Secure`
   或分区 Cookie；
4. Smart App 使用持久化 Wework browser session，刷新和重开后复用同一存储。

如果 callback 成功但授权接口仍返回未登录，应在隔离 Electron 会话中记录 Cookie 的
domain、path、secure、httpOnly、sameSite、partitioned 等元数据。不得记录 Cookie 值、
登录 ticket、Authorization 或用户身份数据。

## Capability 设计

Workbench runtime 的 HostPipe 创建时绑定 Smart App tab ID。插件只能调用：

- `dshCapture.capabilities`：返回 owner-view 区域截图是否可用；
- `dshCapture.ownerRect`：接受 `{x, y, width, height}`，返回 PNG data URL。

`ownerRect` 不接受 label、URL 或 WebContents ID。宿主必须：

- 校验有限、非负、非零矩形；
- 限制最大宽高和总像素；
- 拒绝隐藏或已经销毁的 owner；
- 永远使用 HostPipe 绑定的 owner label；
- 不暴露任意窗口、其他 Smart App 或桌面截图。

## 插件行为

- Wework 和普通浏览器始终渲染同一个 iframe 分支；
- Wework 能力可用时，用 iframe DOMRect 调用 `dshCapture.ownerRect`；
- 能力不可用时，普通浏览器继续使用 `getDisplayMedia` 并裁剪目标区域；
- 两种能力都不可用时，引导用户粘贴系统截图；
- 打开配置、Terminal、审批框或切换标签页不得更改 iframe 的 `display`、`src` 或生命周期；
- 截图只新增图片附件，不隐藏、重载或重新创建 iframe。

## 验证

自动化测试应覆盖 owner scope、非法矩形、隐藏 owner、PNG 转 File、iframe 始终存在、
浏览器 fallback，以及连续截图不改变 iframe 显示状态。桌面 E2E checkpoint
`dsh-owner-capture` 必须从 UI 启动真实 Smart App 并调用 scoped capability。

真实 Electron 验证必须使用 `scripts/ai-verify.mjs` 创建隔离 user-data：

1. 匿名会话打开监控 iframe 并完成登录；
2. 在 iframe 内点击、输入和滚动；
3. 打开和关闭插件弹窗，确认 iframe 不变黑、不遮挡；
4. 连续截图两次，确认每次生成图片且页面显示不变；
5. 切换 Wework tab 后返回，确认 iframe 与登录态恢复；
6. 停止隔离会话并清理测试数据。

---
sidebar_position: 38
---

# 内置浏览器

Wework 的内置浏览器用于在桌面工作台右侧面板中展示可交互网页，并让本地运行时通过 CDP-backed Browser Session 控制同一个页面。它不是截图预览，也不会新开外部 Chrome 窗口。

## 架构

内置浏览器由三层组成：

- Wework Tauri 原生层创建嵌入式 WebView，并通过命令更新位置、导航地址和显示状态。
- Wework React 工作台负责把浏览器面板挂载到右侧 workspace pane，并维护面板、任务和批注状态。
- `deps/browser/relay-server` 暴露给 Codex 的浏览器 MCP 工具，工具名称面向模型描述为 Wework 内置浏览器，避免暴露 Playwright 等实现细节。

Executor 启动 Codex 时会注入 relay server 配置。模型调用浏览器工具时，relay server 通过 Wework 的本地 IPC 操作当前任务绑定的嵌入式浏览器。

每个 Wework 进程启动时都会绑定独立的随机本地桥接端口，并把实际地址传给它启动的 Executor。不得复用父进程环境中的桥接地址，否则同时运行的多个 Wework 实例可能把浏览器请求发送到错误的窗口。

## 任务绑定

浏览器实例以 pane/task label 绑定：

- 未创建运行任务的新对话使用当前 pane key 生成临时浏览器 label。
- 新对话发送后如果创建了 runtime task，Wework 会把临时浏览器 relabel 到新 task label。
- 切换任务时，只显示当前 pane/task 绑定的浏览器；其它任务的页面不会跨 pane 泄漏。
- MCP 打开请求先使用默认 label；当前 pane 失活时，Wework 会把 WebView 迁移到任务专属 label，并且只有活跃任务可以接管默认 label。
- 浏览器右侧面板关闭时，原生 WebView 会被隐藏到不可见区域，不应覆盖聊天区、debug panel 或分割线。

这种绑定保证“用户看到的浏览器”和“agent 控制的浏览器”是同一个对象。

## WebView 兼容性

- 浏览器 WebView 使用固定的独立数据存储标识和应用数据目录，不能与 Wework 主界面的登录存储混用。浏览器设置中的清理操作只作用于这个数据存储。
- 下载处理器从应用偏好读取下载目录和“下载前询问”开关；取消系统保存对话框必须取消本次下载。
- 页面加载事件负责把当前 URL 写入应用状态。不要在 IPC 或自定义协议处理期间同步读取原生 WebView URL；macOS WebKit 在 WebView 创建或销毁期间可能暂时没有 URL。
- 嵌入式浏览器使用标准 Safari 兼容 User-Agent，避免网站把缺少浏览器产品标识的 WebKit User-Agent 识别为不受支持的客户端。

## 批注流程

右侧浏览器地址栏旁提供批注图标。进入批注模式后：

- 鼠标移动到页面元素上时，只高亮当前 DOM 元素。
- 点击元素弹出评论输入框。
- 在评论输入框按 Enter 会发布批注并回到 Wework 主输入框附件区。
- 发送后，会话区显示评论附件样式，主输入框附件会被清理。
- 发送给模型的内容包含隐藏的 `<workspace_comment_context>`，用于说明批注对应的可视网页区域；UI 不展示原始隐藏上下文。

批注用于网页可视区域评论，不等同于代码选择评论。`browser_annotation` 项应被模型理解为对当前可见网页元素的评论。

## 开发检查

修改内置浏览器相关代码后，至少运行：

```bash
pnpm --filter wework typecheck
pnpm --filter wework lint
cd wework && pnpm vitest run src/lib/embedded-browser.test.ts src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx
cd wework/src-tauri && cargo check
cd deps/browser/relay-server && npm run test:mcp
```

涉及 Executor Codex 启动配置时，还应运行：

```bash
cd executor && cargo test codex_launch_config_includes_cdp_browser_mcp_server
```

---
sidebar_position: 35
---

# MCP 应用

Wework 可以在 Codex 任务的工具结果旁运行 MCP 应用。应用由 MCP 服务提供 HTML，通过标准 MCP Apps 协议与宿主交互。

## 声明界面

在工具定义的 `_meta.ui.resourceUri` 中声明资源 URI，并通过 `resources/read` 返回 HTML：

```json
{
  "name": "show_dashboard",
  "inputSchema": { "type": "object", "properties": {} },
  "_meta": { "ui": { "resourceUri": "ui://dashboard/app.html" } }
}
```

```json
{
  "contents": [{
    "uri": "ui://dashboard/app.html",
    "mimeType": "text/html;profile=mcp-app",
    "text": "<!doctype html><html>...</html>",
    "_meta": { "ui": { "csp": { "connectDomains": [], "resourceDomains": [] } } }
  }]
}
```

宿主同时接受旧的 `ui/resourceUri`、`openai/outputTemplate` 和结果 `_meta` 中的资源引用。`text/html+skybridge` 通过 `window.openai` 兼容桥接入同一条宿主链路。

## 通信和生命周期

应用完成 `ui/initialize` 与 `ui/notifications/initialized` 握手后接收工具输入和结果。结果的 `content`、`structuredContent` 和 `_meta` 保持分离；宿主不会把 `_meta` 添加到模型上下文。

应用可以调用来源服务的工具、读取资源、发送对话消息、更新模型上下文，以及请求内联、全屏或画中画显示。只读 Issue 执行视图不提供应用发送会话消息的能力，回复仍通过 Issue 发起。其他对话消息需要用户确认。应用工具调用通过来源绑定的 Codex 原生通道执行；宿主不会根据工具注解额外逐次弹窗。`visibility: ["app"]` 的工具只供应用调用，`visibility: ["model"]` 的工具不会向应用开放。

虚拟列表移除工具行时，宿主使用保留状态的 DOM 移动停放页面，保留页面状态和正在进行的请求。关闭应用或离开任务时，宿主清理协议连接和临时文档。模型上下文按来源调用保存在任务中，并以不可信应用数据的身份用于后续消息。

桌面工作区同时支持对话内联卡片与右侧应用标签。应用请求 fullscreen 时使用右侧工作区容器；展开和收回移动同一个沙箱节点，保留页面输入、登录状态和进行中的请求。关闭右侧标签时，支持内联的应用返回对话；仅支持 fullscreen 的应用保留文档并收起为重新打开入口。关闭应用本身才释放文档。

## 安全边界

- 执行器从任务中的真实调用确定来源服务，不接受页面指定其他任务、服务或插件。共享服务还按连接器和账号隔离。
- HTML 使用独立的本机来源，不共享工作台的 DOM、Cookie、存储或桌面宿主接口。
- 资源 CSP 通过响应头实施。未声明的网络和子框架请求默认禁止；HTTP 仅用于显式声明的本机开发来源。
- 页面消息同时校验来源窗口和来源地址，发送方向也绑定来源地址。导航到其他地址后不能继续使用原应用的宿主通道。
- 应用元数据和更新的上下文不能授予权限。执行器校验工具可见性；界面确认不能扩大插件和账号范围。

## 验证

```bash
pnpm --filter wework e2e:desktop --segment mcp-apps
```

该 checkpoint 使用真实 Electron、执行器、Codex 和标准输入输出 MCP 服务，仅模拟模型响应，并由桌面 CI 调用。验证范围包含资源读取、初始化、私有结果元数据交付、应用专用工具、模型上下文、显示模式切换、跨调用隔离、连续非只读工具调用、作用域拒绝和资源清理。

每个文档使用独立的 `codex-sandbox://<id>.web-sandbox.oaiusercontent.com/mcp-app.html` 来源。Electron 在本地处理此自定义协议，不查询该域名、不请求 OpenAI 服务，也不远程执行页面。宿主在启动前将协议注册为标准安全协议，文档响应继续执行资源声明的 CSP。

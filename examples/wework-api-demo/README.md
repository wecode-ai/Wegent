---
sidebar_position: 1
---

# Wework API 网页测试台

需要 Node.js 20 或以上，无需安装依赖。在仓库根目录运行：

```bash
node examples/wework-api-demo/server.mjs
```

打开 <http://127.0.0.1:8765>。端口被占用时：

```bash
DEMO_PORT=8766 node examples/wework-api-demo/server.mjs
```

1. 填写 backend 的完整 API 前缀，例如 `http://localhost:8000/api/v1`，输入个人 API Key。
2. 点击“加载设备和模型”，选择执行机器和模型；支持 Bearer 或 X-API-Key。
3. 选择实时输出、异步提交或同步等待，发送任务。
4. Response ID 和 Conversation ID 自动填入，可查询任务、查看消息或停止任务。
5. 选择“继续指定会话”或“接着指定轮次执行”来测试续写。
6. 点击会话列表的“刷新”浏览已有会话；支持设备筛选及分页。

页面通过仅绑定 `127.0.0.1` 的本地服务代理 HTTP/SSE，避免跨域配置。API Key 不写入浏览器存储、文件或日志，刷新后需要重新填写。任务内容、返回结果和错误以纯文本展示。SSE 原始事件最多保留最近 300 条，请求记录最多 60 条。

“断开输出连接”只关闭连接，不会停止 Runtime；停止任务需单独点击“停止任务”。重新订阅仅显示新输出，已有文本通过“查询状态 / 输出”获取。错误区域展示 backend 的 HTTP 状态及错误详情，包括参数校验、设备离线和模型错误。

本 Demo 测试统一入口的 Wework 执行模式，不修改 backend 配置，不创建 API Key，也不自动发送任务。实际创建的会话会保留在对应 Runtime 中。若同步等待超过本地代理的 60 秒响应头等待上限，先查询会话确认执行情况；长任务建议使用 SSE 或异步模式。

解析器验证：

```bash
node --test examples/wework-api-demo/sse.test.mjs
```

## English

Run `node examples/wework-api-demo/server.mjs` with Node.js 20+, then open <http://127.0.0.1:8765>. No dependencies are required. Enter your backend URL ending in `/api/v1` and a personal API key, load devices/models, and submit a streaming, background, or synchronous task. The page supports conversation browsing, continuation, response retrieval, live subscription, and cancellation.

The local server forwards HTTP/SSE to your selected backend to avoid browser CORS restrictions. Keys remain in page memory only. Disconnecting a stream does not cancel a task. Reattachment receives new events only. Response headers have a 60-second timeout; use streaming or background mode for long tasks. The interface is in Chinese.

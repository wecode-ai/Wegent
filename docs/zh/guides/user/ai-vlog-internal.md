---
sidebar_position: 90
---

# 内网 AI剪辑Vlog

AI剪辑Vlog 使用 AIGC 的多风格流水线，同一批用户素材生成三个独立风格，
并支持逐条打开 OpenCut、保存及重新渲染。普通 AI智能剪辑和 AI高光剪辑不变。

## 配置

1. 安装 AIGC 仓库的 `skills/material-to-video-multi-style` Skill 包。
2. 创建独立 Ghost，使用该目录的 `system_prompt.md`，绑定并预加载该 Skill。
   内网没有微博私信通知时，将提示词中的私信承诺改为“生成后可在卡片中查看”。
3. 创建独立 Bot，绑定该 Ghost、Chat Shell 和支持图片及工具调用的文本模型。
4. 创建 `AI剪辑Vlog` Team，引用新 Bot，设置 `requiresWorkspace=false`。
5. Backend 和 Chat Shell 配置同一个 `AIGC_VIDEO_AGENT_URL`；
   `WEGENT_BACKEND_PUBLIC_URL` 必须可被后台轮询进程访问。
   AIGC 内网实例使用 `DEPLOYMENT_MODE=internal`。
6. 如果前端代理限制跨域回调，Backend 配置 `OPENCUT_CALLBACK_URL` 为
   浏览器可达的后端地址（例如测试环境 `http://10.218.17.35:8500`）。
   不要放开公共代理规则；签名校验仍由后端执行。未配置时保留原回调地址。

需确认 AIGC 的 `mv_style_task`、素材、时间线与渲染结果表，以及模板和 Worker 已就绪。
不要为内网变更外网实例的部署模式。

## 适配边界

- 私有 MCP 工具 `create_async_multi_video_card` 使用现有公共异步卡片服务。
- 私有签名轮询接口将 AIGC 的数字状态和数组结果转换为 CardBlock 协议。
  用户身份从任务令牌获取，不能通过传入 URL 切换用户或父任务。
- 三条结果分别显示进度；一个失败不会隐藏其他已完成的视频。
- 只有用户点击才打开 OpenCut；分享页不能编辑或重新渲染。
- 子会话格式为父会话加风格序号，例如 `137_2`。重新渲染使用
  `rerender_style_video(sub_task_id="137_2")`，不重新生成其余风格。
- 保存并渲染会在对话中发送含子会话标识的明确指令；这是内网适配，
  不依赖外网的私有卡片按钮配置机制。

## 验证

应覆盖图片、视频、混合素材；三个风格的逐步完成、部分失败与刷新恢复；
单条编辑重渲；分享只读和跨用户／任务请求拒绝。三个风格并行生成会消耗
多路模型和渲染资源，首次验证建议使用短素材。

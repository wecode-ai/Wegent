---
sidebar_position: 18
---

# 搜索 AI 识图

搜索 AI 识图利用微博站内相似图片及相关微博上下文补充图片识别。该能力仅由用户明确触发，不替代普通的 `understand_media` 图片理解。

## 能力边界

搜索识图与图片上传由两个独立能力组成：

- Wegent 图片附件和站外内容入库链路负责自动上传微博图床，并在 metadata 中保存可复用 PID。
- `videoServer` MCP 负责根据 PID 调用站内搜索 AI 识图服务。

微博站内图片由媒体分析 Skill 先通过 `getWeiboMediaResources` 获取 PID，无需重复上传。

## 处理流程

用户明确触发搜索 AI 识图后：

1. 已有 PID 时直接调用 `videoServer` MCP。
2. 图片附件或站外图片直接从 metadata 读取 Wegent 自动生成的 PID，再交给 `videoServer` MCP。
3. `videoServer` 提交识图任务并轮询，提交后的总等待时间最多 15 秒。

图片上传支持 JPEG、PNG 和 GIF，文件必须小于 10 MB。站外图片采用流式下载，达到限制时立即终止。PID 生成是非阻断增强：附件首次上传成功后将 PID 写入 `SubtaskContext.type_data.image_pid`；图片过大、格式不支持或图床失败时只记录 `image_pid_status` 和 `image_pid_error`，不影响原附件或站外内容入库。

`videoServer` 原样返回内部查询接口响应：

- 查询得到非空 `data.content`：识别成功。
- 等待期内 `data` 始终为空：未识别成功。
- 提交或查询失败：返回错误信息。

图床地址和 TAuth 只由 Wegent 内部上传服务维护，不暴露为 MCP；识图地址和轮询参数只由 `videoServer` 维护。两者均不进入 Skill 参数。

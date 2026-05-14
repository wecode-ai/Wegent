---
sidebar_position: 1
---

# 智能体 API 调用引导

## 背景

Wegent 已提供 `/api/v1/responses` 接口，外部应用可以通过 OpenAI Responses API 兼容格式调用智能体，但当前设置界面没有把“智能体可以被 API 调用”这件事和具体智能体连接起来。用户需要在智能体列表中看到明确入口，并能直接复制可运行的 curl 示例。

## 目标

- 在智能体列表中为每个智能体提供 API 调用入口。
- 展示包含当前智能体标识的 curl 示例，降低接入成本。
- 提供复制 curl、管理 API Key、查看完整文档三个动作。
- 保持设置页安静，不把大段开发者说明直接铺在列表上。

## 方案

在 `TeamList` 的每个智能体卡片操作区新增一个代码/终端图标按钮。点击后打开 “API 调用” 对话框，对话框展示当前智能体的调用信息和 curl 示例。

curl 示例使用现有 `/api/v1/responses` 端点：

```bash
curl -X POST "$WEGENT_API_BASE/api/v1/responses" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your-api-key>" \
  -d '{
    "model": "default#my-agent",
    "input": "帮我总结今天的待办",
    "stream": true,
    "tools": [{"type": "wegent_chat_bot"}]
  }'
```

`model` 根据当前智能体自动生成：

- 个人智能体：`default#team.name`
- 群组智能体：`team.namespace#team.name`

如果智能体名称包含特殊字符，示例仍按字符串展示，由 JSON 序列化保证请求体合法。

## 交互

- 卡片按钮使用图标按钮，标题为“API 调用”。
- 对话框标题显示“API 调用：{智能体名称}”。
- 对话框正文包含：
  - Endpoint：`/api/v1/responses`
  - Model：当前智能体标识
  - 代码块：curl 示例
- 对话框底部动作：
  - “复制 curl”：复制完整示例，并显示 toast。
  - “管理 API Key”：跳转到设置页 `api-keys` 标签。
  - “查看文档”：打开现有 Responses API 文档链接。

## 文案与国际化

新增文案放在 `common.teams.api_call` 下，覆盖中英文：

- 入口标题
- 对话框标题
- Endpoint、Model 标签
- 复制成功/失败提示
- 管理 API Key
- 查看文档
- API Key 占位提示

## 测试

新增前端组件测试覆盖：

- 点击智能体卡片的 API 调用按钮会打开对话框。
- curl 示例包含当前智能体的 `namespace#name` model。
- “复制 curl” 调用剪贴板 API。
- “管理 API Key” 跳转到 `/settings?section=api-keys&tab=api-keys`。

## 非目标

- 不新增或修改后端 API。
- 不在本次实现中创建真实 API Key。
- 不把完整 API 文档嵌入弹窗，只提供最小可复制示例和文档入口。

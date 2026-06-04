---
sidebar_position: 28
---

# QuickCard 输入预设

## 概述

QuickCard 的系统功能是一个输入框预填入口。系统功能绑定目标智能体，并配置一个或多个输入预设。用户点击系统功能后，系统会选择目标智能体，并在当前页或目标页展示输入预设列表。

输入预设不会直接发送消息。它只更新输入框草稿和输入控件选项，最终发送仍由 ChatInput 统一处理。

## 数据模型

系统功能配置仍存储在 `quick_launch_functions` 系统配置项下。每个功能使用 `input_presets` 描述可应用到输入框的预设：

```json
{
  "id": "code_review",
  "title": "代码评审",
  "team_id": 7,
  "enabled": true,
  "order": 10,
  "input_presets": [
    {
      "id": "review_change",
      "title": "评审变更",
      "prompt": "请帮我评审当前代码变更",
      "options": {
        "enable_deep_thinking": false,
        "enable_clarification": true,
        "force_override": true,
        "selected_skill_names": ["code-review"]
      }
    }
  ]
}
```

`quick_phrases` 旧配置会在读取时迁移为输入预设，保存时输出 `input_presets`。

## 启动流程

跨页面启动时，QuickCard 使用 URL 中的一次性 launch intent：

- `teamId`：目标智能体 ID
- `quickLauncher`：系统功能或收藏智能体 key
- `quickPreset`：可选，直接应用的预设 ID
- `showPresets=1`：进入目标页后展示当前功能的预设列表

目标页读取 intent 后会清理这些查询参数。清理后，URL 不再持续控制智能体选择，因此用户可以取消或切换智能体。

## 支持的输入选项

输入预设当前支持这些稳定、可序列化的输入框选项：

- `prompt`：输入框文本
- `enable_deep_thinking`：深度思考开关
- `enable_clarification`：澄清模式开关
- `force_override`：强制覆盖模型开关
- `selected_skill_names`：本次输入预选技能名

附件、仓库、分支和用户上下文不放入系统功能配置。这些内容依赖用户环境、权限或当前任务状态，不适合作为全局系统预设。

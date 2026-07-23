---
sidebar_position: 9
---

# 设置与数据

## 常用设置

- **通用**：界面语言、启动时是否显示窗口、关闭窗口后是否后台运行，以及从 Codex 或 Claude Code 导入内容。
- **外观**：主题和工作台背景。背景图片及显示参数保存在当前设备。
- **模型**：本机 Codex 登录、本地 OpenAI Responses 兼容模型和云端模型。
- **代理**：分别配置本机和云端设备的模型访问代理。
- **上下文**：管理任务上下文偏好和 Codex 个性。
- **快捷短语**：保存经常使用的任务说明。
- **键盘快捷键**：查看、修改或清除本机快捷键。
- **工作树**：设置 Worktree 根目录、自动清理和保留数量。
- **已归档会话**：搜索、恢复或删除历史会话。

## 默认快捷键

| 功能           | macOS 默认快捷键          |
| -------------- | ------------------------- |
| 打开设置       | `Command+,`               |
| 切换左侧边栏   | `Command+B`               |
| 切换右侧工作区 | `Option+Command+B`        |
| 切换底部面板   | `Command+J`               |
| 返回 / 前进    | `Command+[` / `Command+]` |
| 选择模型       | `Control+Shift+M`         |
| 应用快照       | `Command+Shift+2`         |

Windows 和 Linux 使用界面中显示的对应组合键。

## 自定义 Codex 模型

在“设置 → 模型”中点击“添加模型”后，先选择提供商。Wework 内置 Kimi Coding、Kimi 开放平台、DeepSeek 和 GLM profile；填写对应平台的 API Key 后，可以从提供商的 `/models` 接口读取可用模型。连接地址、Chat Completions 协议、工具模式和已知模型的上下文长度由 profile 自动填写，其中 Kimi 开放平台使用中国区 `api.moonshot.cn` 端点。Kimi Coding 的 K3 会自动使用内置的 Codex Catalog profile，包括 256K 上下文和默认 `low` 推理等级。

每个自定义模型都可以设置可选的“分组”，模型选择器会使用该名称组织模型。Kimi Coding 默认填写“Kimi”，用户可以修改或清空；未设置分组的模型统一显示在“自定义模型”下。

选择“完全自定义”可以配置兼容 OpenAI Responses、Chat Completions 或 Anthropic Messages 的接口。模型能力使用结构化表单维护，不需要编辑 Catalog JSON：

- 最大上下文同时用于运行时和 Catalog，不需要重复填写。
- 推理等级、输入类型和布尔能力通过预设选项或复选框配置。
- 基础提示词默认参考 Codex 的 GPT profile，并可单独展开编辑。
- 不常用字段在“高级模型能力”对话框中按“响应与工具”“Catalog 元数据”“提示词模板”分类配置。

自定义 Catalog 由当前设备上的同一个 Codex app-server 读取。保存模型时，如果没有任务执行，Wework 会静默重启 Codex app-server；如果有任务正在执行，则询问是否立即重启。选择稍后重启时，模型显示“等待重启执行器”，并且在重启完成前不会出现在模型选择器中。

## 数据位置与同步

本地项目文件保存在原项目目录。应用偏好、本地模型和本地会话保存在当前设备。只有在连接 Wegent 并主动使用云端能力时，相关任务请求和配置才会发送到对应服务。

Codex 认证内容只会在你明确上传或导入到云端后参与同步。远程设备命令、Git Token 和模型 API Key 应作为凭证管理。

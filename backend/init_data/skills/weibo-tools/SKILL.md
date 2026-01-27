---
description: "微博平台数据查询工具集。当用户需要查询微博内容、用户信息、评论、热搜等微博相关数据时使用此技能。支持：查询微博内容（按ID或用户）、获取用户资料、查看评论、获取热搜榜单、根据微博链接获取内容等。"
displayName: "微博工具"
version: "1.1.0"
author: "Wegent Team"
tags: ["weibo", "微博", "social-media", "热搜", "用户", "评论"]
bindShells: ["Chat"]
provider:
  module: provider
  class: WeiboToolProvider
tools:
  - name: list_weibo_mcps
    provider: weibo-tools
  - name: load_weibo_mcp_tools
    provider: weibo-tools
    config:
      timeout: 60
  - name: invoke_weibo_tool
    provider: weibo-tools
---

# 微博工具技能

微博平台数据查询工具集，支持查询微博内容、用户信息、评论、热搜等数据。

## 三阶段懒加载设计

为了减少 Token 消耗，本技能采用三阶段懒加载设计：

### 阶段 1: 发现可用服务 (list_weibo_mcps)

列出可用的微博 MCP 服务，无需网络连接：

```json
{
  "name": "list_weibo_mcps"
}
```

返回可用服务列表，帮助选择合适的服务。

### 阶段 2: 加载服务工具 (load_weibo_mcp_tools)

连接到特定的 MCP 服务并获取其工具列表：

```json
{
  "name": "load_weibo_mcp_tools",
  "arguments": {
    "server_name": "weibo-status"
  }
}
```

只加载指定服务的工具，避免加载无关工具。

### 阶段 3: 调用工具 (invoke_weibo_tool)

调用已加载服务中的特定工具：

```json
{
  "name": "invoke_weibo_tool",
  "arguments": {
    "server_name": "weibo-status",
    "tool_name": "get_weibo_by_id",
    "arguments": {
      "weibo_id": "1234567890"
    }
  }
}
```

## 支持的微博服务

| 服务名 | 功能 | 适用场景 |
|--------|------|----------|
| weibo-status | 微博内容查询 | 查看微博正文、获取用户微博列表 |
| weibo-user | 用户信息查询 | 获取用户资料、粉丝数据 |
| weibo-comments | 评论数据查询 | 查看评论、分析评论 |
| weibo-search | 搜索和热搜 | 获取热搜榜、搜索话题 |
| wegent-fetch | 链接解析 | 通过URL获取微博内容 |

## 使用流程示例

用户问: "帮我看看某某的最新微博"

AI 处理流程:
1. 识别到这是微博用户内容查询
2. 调用 `list_weibo_mcps` 查看可用服务
3. 选择 `weibo-status` 服务
4. 调用 `load_weibo_mcp_tools(server_name='weibo-status')` 加载工具
5. 调用 `invoke_weibo_tool(server_name='weibo-status', tool_name='get_user_weibos', arguments={...})`
6. 返回该用户的微博内容

## Token 效率

- **阶段 1**: ~200 tokens (静态服务目录)
- **阶段 2**: ~50-100 tokens/服务 (单个服务的工具列表)
- **阶段 3**: 只传递调用参数

相比一次性加载所有服务所有工具，可节省 70-80% 的 Token 消耗。

## 配置要求

需要配置 `CHAT_MCP_SERVERS` 环境变量，包含微博 MCP 服务的连接信息。

示例配置:
```json
{
  "mcpServers": {
    "weibo-status": {
      "command": "node",
      "args": ["path/to/weibo-status-mcp"]
    },
    "weibo-user": {
      "command": "node",
      "args": ["path/to/weibo-user-mcp"]
    }
  }
}
```

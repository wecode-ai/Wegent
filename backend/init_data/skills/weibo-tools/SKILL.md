---
description: "微博平台数据查询工具集。当用户需要查询微博内容、用户信息、评论、热搜等微博相关数据时使用此技能。支持：查询微博内容（按ID或用户）、获取用户资料、查看评论、获取热搜榜单、根据微博链接获取内容等。"
displayName: "微博工具"
version: "1.0.0"
author: "Wegent Team"
tags: ["weibo", "微博", "social-media", "热搜", "用户", "评论"]
bindShells: ["Chat"]
provider:
  module: provider
  class: WeiboToolProvider
tools:
  - name: load_weibo_tools
    provider: weibo-tools
    config:
      timeout: 60
  - name: invoke_weibo_tool
    provider: weibo-tools
    config:
      timeout: 60
---

# 微博工具 - Weibo Tools

提供微博平台数据查询能力的技能集合，支持查询微博内容、用户信息、评论数据和热搜榜单。

## 使用场景

当用户提出以下类型的请求时，应加载此技能：

- **微博内容查询**：查看某条微博的内容、获取某用户发布的微博
- **用户信息查询**：查询微博用户的资料、粉丝数、关注数等
- **评论数据查询**：查看微博下的评论、我发出/收到的评论
- **热搜榜单**：获取当前微博热搜词、查看热搜话题下的微博
- **微博链接解析**：根据微博URL获取对应内容

## 可用工具

### `load_weibo_tools`

连接微博 MCP 服务并加载所有可用工具。

**参数：**
- `server_names`（可选）：指定要加载的服务列表。不提供则加载所有已配置的微博服务。

**返回：**
- 成功：已加载工具的列表及其描述
- 失败：错误信息

**示例：**
```json
{
  "name": "load_weibo_tools",
  "arguments": {}
}
```

### `invoke_weibo_tool`

调用已加载的微博工具。

**参数：**
- `tool_name`（必需）：要调用的工具名称
- `arguments`（可选）：传递给工具的参数

**返回：**
- 工具执行结果

**示例：**
```json
{
  "name": "invoke_weibo_tool",
  "arguments": {
    "tool_name": "get_weibo_by_id",
    "arguments": {
      "weibo_id": "5126850123456789"
    }
  }
}
```

## 包含的微博服务

此技能整合了以下微博 MCP 服务：

### 1. Weibo Status（微博内容）
- 按微博ID获取详细内容
- 按用户ID或昵称查询其最新发布的微博

### 2. Weibo User（用户信息）
- 获取指定用户的详细资料
- 支持通过用户ID或昵称查询
- 返回用户基本信息：ID、昵称、头像、简介等

### 3. Weibo Comments（评论数据）
- 批量查询评论内容
- 查询某条微博的评论列表
- 查询我发出的评论与我收到的评论

### 4. Weibo Search（热搜榜单）
- 获取当前微博热搜词列表
- 获取指定热搜词下的微博内容
- 实时获取最新热点话题

### 5. Wegent Fetch（链接解析）
- 根据微博URL直接获取对应内容
- 支持各种微博链接格式

## 使用流程

1. **识别需求**：用户询问微博相关问题
2. **加载工具**：调用 `load_weibo_tools` 连接微博服务
3. **查看可用工具**：根据返回的工具列表确定要使用的工具
4. **执行查询**：调用 `invoke_weibo_tool` 执行具体操作
5. **返回结果**：将查询结果整理后返回给用户

## 示例对话

**用户**：帮我看看微博热搜有什么

**AI处理流程**：
1. 识别到这是微博热搜查询
2. 调用 `load_weibo_tools` 加载微博工具
3. 调用 `invoke_weibo_tool` 使用热搜查询工具
4. 返回当前热搜榜单

**用户**：查一下用户"某某"的微博

**AI处理流程**：
1. 识别到这是微博用户内容查询
2. 调用 `load_weibo_tools` 加载微博工具
3. 调用 `invoke_weibo_tool` 查询用户最新微博
4. 返回该用户的微博内容

## 配置

微博服务通过 `CHAT_MCP_SERVERS` 环境变量配置，格式示例：

```json
{
  "mcpServers": {
    "weibo-status": {
      "type": "sse",
      "url": "https://weibo-status-mcp.example.com"
    },
    "weibo-user": {
      "type": "sse",
      "url": "https://weibo-user-mcp.example.com"
    }
  }
}
```

## 注意事项

- 首次使用需调用 `load_weibo_tools` 加载工具
- 工具加载后在会话期间保持可用
- 部分查询可能需要用户授权
- 查询结果受微博平台接口限制

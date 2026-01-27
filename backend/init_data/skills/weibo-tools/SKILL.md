---
description: "微博平台数据查询工具集。当用户需要查询微博内容、用户信息、评论、热搜等微博相关数据时使用此技能。支持：查询微博内容（按ID或用户）、获取用户资料、查看评论、获取热搜榜单、根据微博链接获取内容等。"
displayName: "微博工具"
version: "1.2.0"
author: "Wegent Team"
tags: ["weibo", "微博", "social-media", "热搜", "用户", "评论"]
bindShells: ["Chat"]
provider:
  module: provider
  class: WeiboToolProvider
mcpServers:
  statusServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/status"
    headers:
      Authorization: "mcp_eyJhbGciOiJIUzI1NiJ9.eyJhcGlfa2V5IjoiMiIsInNlcnZlciI6InN0YXR1cyIsInVzZXJfaWQiOiIxIiwiaWF0IjoxNzQxNzY1OTYxLCJleHAiOjE3NDY5NDk5NjF9.wbqKZi-kxgslrZPVJz0_xemWWLDk-o2sPMbQ2OCZJFI"
      mcp-proxy-wegent-user: "${{user.name}}"
  commentsServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/comments"
    headers:
      Authorization: "mcp_eyJhbGciOiJIUzI1NiJ9.eyJhcGlfa2V5IjoiMiIsInNlcnZlciI6ImNvbW1lbnRzIiwidXNlcl9pZCI6IjEiLCJpYXQiOjE3NDE3NjU5NjEsImV4cCI6MTc0Njk0OTk2MX0.8zsDWPPq5cG_xjzRrYq4LoAKJ6YEhKiSA5PVfPJKzLQ"
      mcp-proxy-wegent-user: "${{user.name}}"
  userServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/user"
    headers:
      Authorization: "mcp_eyJhbGciOiJIUzI1NiJ9.eyJhcGlfa2V5IjoiMiIsInNlcnZlciI6InVzZXIiLCJ1c2VyX2lkIjoiMSIsImlhdCI6MTc0MTc2NTk2MSwiZXhwIjoxNzQ2OTQ5OTYxfQ.3Z0-XjxL6zIvBq3qY-vTqS2a1cHG6z5qZ0-DWwL3Y8M"
      mcp-proxy-wegent-user: "${{user.name}}"
  searchServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/search"
    headers:
      Authorization: "mcp_eyJhbGciOiJIUzI1NiJ9.eyJhcGlfa2V5IjoiMiIsInNlcnZlciI6InNlYXJjaCIsInVzZXJfaWQiOiIxIiwiaWF0IjoxNzQxNzY1OTYxLCJleHAiOjE3NDY5NDk5NjF9.9XjL6vBq3qY-vT1a2cHG6z5qZ0-WwL3Y8MkxgslrZPV"
      mcp-proxy-wegent-user: "${{user.name}}"
  fetchServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/wegent-fetch"
    headers:
      Authorization: "mcp_eyJhbGciOiJIUzI1NiJ9.eyJhcGlfa2V5IjoiMiIsInNlcnZlciI6IndlZ2VudC1mZXRjaCIsInVzZXJfaWQiOiIxIiwiaWF0IjoxNzQxNzY1OTYxLCJleHAiOjE3NDY5NDk5NjF9.Jz0_xemWWLDk-o2sPMbQ2OCZJFI"
      mcp-proxy-wegent-user: "${{user.name}}"
---

# 微博工具技能

微博平台数据查询工具集，支持查询微博内容、用户信息、评论、热搜等数据。

## MCP 服务器配置

本技能通过配置 MCP 服务器来提供微博数据查询能力。系统会自动连接配置的 MCP 服务器并加载相关工具。

### 可用的 MCP 服务器

| 服务器名 | 功能 | 适用场景 |
|----------|------|----------|
| statusServer | 微博内容查询 | 查看微博正文、获取用户微博列表 |
| userServer | 用户信息查询 | 获取用户资料、粉丝数据 |
| commentsServer | 评论数据查询 | 查看评论、分析评论 |
| searchServer | 搜索和热搜 | 获取热搜榜、搜索话题 |
| fetchServer | 链接解析 | 通过URL获取微博内容 |

## 使用示例

### 查询微博内容

用户问: "帮我看看某某的最新微博"

AI 会自动使用 statusServer 提供的工具来查询用户的微博列表。

### 获取热搜

用户问: "现在的热搜是什么"

AI 会自动使用 searchServer 提供的工具来获取当前热搜榜单。

### 解析微博链接

用户问: "帮我看看这条微博 https://weibo.com/..."

AI 会自动使用 fetchServer 提供的工具来解析微博链接并获取内容。

## 变量替换

MCP 服务器配置支持以下变量替换：

- `${{user.name}}` - 当前用户的用户名
- `${{user.id}}` - 当前用户的 ID
- `${{task.id}}` - 当前任务的 ID

这些变量会在运行时自动替换为实际值。

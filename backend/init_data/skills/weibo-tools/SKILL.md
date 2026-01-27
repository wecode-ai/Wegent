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
      Authorization: "Bearer mcp_eyJhbGciOiJIUzI1NiJ9.eyJjYSI6MTc2NTc3MDgyMiwibyI6ImppYW5neWFuZzcifQ._P5D-A7eF2ahUmZJtb1K2Qmll6I-kyKJcJPQBUvxRng"
      mcp-proxy-wegent-user: "${{user.name}}"
  commentsServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/comments"
    headers:
      Authorization: "Bearer mcp_eyJhbGciOiJIUzI1NiJ9.eyJjYSI6MTc2NTc3MDgyMiwibyI6ImppYW5neWFuZzcifQ._P5D-A7eF2ahUmZJtb1K2Qmll6I-kyKJcJPQBUvxRng"
      mcp-proxy-wegent-user: "${{user.name}}"
  userServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/user"
    headers:
      Authorization: "Bearer mcp_eyJhbGciOiJIUzI1NiJ9.eyJjYSI6MTc2NTc3MDgyMiwibyI6ImppYW5neWFuZzcifQ._P5D-A7eF2ahUmZJtb1K2Qmll6I-kyKJcJPQBUvxRng"
      mcp-proxy-wegent-user: "${{user.name}}"
  searchServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/search"
    headers:
      Authorization: "Bearer mcp_eyJhbGciOiJIUzI1NiJ9.eyJjYSI6MTc2NTc3MDgyMiwibyI6ImppYW5neWFuZzcifQ._P5D-A7eF2ahUmZJtb1K2Qmll6I-kyKJcJPQBUvxRng"
      mcp-proxy-wegent-user: "${{user.name}}"
  fetchServer:
    type: "streamable-http"
    transport: "streamable_http"
    url: "http://mcp.intra.weibo.com/2/mcp/internal/server/wegent-fetch"
    headers:
      Authorization: "Bearer mcp_eyJhbGciOiJIUzI1NiJ9.eyJjYSI6MTc2NTc3MDgyMiwibyI6ImppYW5neWFuZzcifQ._P5D-A7eF2ahUmZJtb1K2Qmll6I-kyKJcJPQBUvxRng"
      mcp-proxy-wegent-user: "${{user.name}}"
---

# 微博工具技能

微博平台数据查询工具集，提供对微博平台各类数据的访问能力。

## 重要提示

**当用户询问微博相关内容时，请优先使用本技能提供的 MCP 工具，而不是通用的网页搜索工具。** 本技能的工具可以直接访问微博平台数据，获取更准确、更实时的信息。

## 功能概述

本技能通过 MCP 服务器提供以下能力：

### 微博内容查询
- 按微博 ID 获取详细内容
- 按用户 ID 或昵称查询其最新发布的微博
- 根据微博链接 URL 直接获取对应内容

### 用户信息查询
- 获取指定用户的基本信息（ID、昵称、头像、简介等）
- 支持通过用户 ID 或用户昵称进行精确查询

### 评论数据查询
- 批量查询评论内容
- 查询某条微博的评论列表
- 查询我发出的评论与我收到的评论

### 热搜信息查询
- 获取当前微博热搜词列表
- 获取指定热搜词下的微博数据
- 实时获取最新的热搜信息，了解当前热点话题

## 使用建议

1. **查询特定微博内容**：如果用户提供了微博链接或微博 ID，使用相应的工具直接获取内容
2. **了解用户动态**：查询某个用户的最新微博或用户资料时，使用用户相关工具
3. **追踪热点话题**：需要了解当前热门话题或热搜内容时，使用热搜相关工具
4. **查看互动数据**：需要查看微博评论或互动情况时，使用评论相关工具

## 注意事项

- 工具返回的数据为实时数据，可能随时间变化
- 部分查询可能需要用户授权才能获取完整数据
- 请尊重用户隐私，合理使用查询功能

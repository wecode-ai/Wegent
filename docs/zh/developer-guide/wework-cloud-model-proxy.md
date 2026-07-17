---
sidebar_position: 39
---

# Wework 云端模型代理网关

Wework 桌面端与 Wegent 后端可能运行在不同机器上。当桌面端使用配置了真实云端 provider 凭证的 Model CRD 时，必须避免把 provider `api_key` 明文下发到本地，同时保证 Codex 能够正常调用云端模型。

## 解决方案

Wework 使用已配置的云端地址和登录 token 直接构造代理模型配置，由 Wegent 代替 Wework 调用真实 provider。

### 核心组件

- `app/services/llm_proxy_service.py`：解析模型身份、校验权限并转发 provider 请求。
- `POST /api/runtime-work/llm-responses-proxy/responses`：使用用户登录 token 鉴权的代理端点。
- `/models/unified`：下发模型名称、类型、namespace 和资源 owner ID，供代理精确定位 Model CRD。

### 请求流程

1. Wework 从 `/models/unified` 获取不含 provider 凭证的模型元数据。
2. Wework 直接构造代理配置：`base_url` 为所配置云端地址下的 `/api/runtime-work/llm-responses-proxy`，`api_key` 为当前云端登录 token。
3. executor 的 Codex compat proxy 使用登录 token 请求 backend，并携带模型类型、namespace 和资源 owner ID。
4. backend 验证登录 token 和模型访问权限，按 `user_id + namespace + name` 精确解析 Model CRD。
5. backend 取出真实 provider 配置，将请求中的模型名称改写为 provider `model_id`，再流式转发请求和响应。

## 安全收益

- Wework 桌面端和本地 executor 永远不会拿到真实 provider `api_key`。
- 模型代理与其他 backend API 共用登录 token 的过期和鉴权策略。
- 真实 provider 凭证只留在 backend 内存和数据库中。

## 相关实现

- executor 的 Codex compat proxy 将登录 token 放入 backend 请求的 `Authorization: Bearer` 头。
- backend 使用完整资源身份解析模型，避免个人、公共和群组模型重名时串用配置。
- Wework 创建任务、继续对话和回滚时都直接使用同一代理配置，不再请求单独的模型配置解析接口。

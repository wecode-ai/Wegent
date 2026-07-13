---
sidebar_position: 39
---

# Wework 云端模型代理网关

Wework 桌面端与 Wegent 后端可能运行在不同机器上。当桌面端使用配置了真实云端 provider 凭证的 Model CRD 时，必须避免把 `api_key` 明文下发到本地，同时保证 Codex 能够正常调用云端模型。

## 问题背景

- Model CRD 的 `spec.modelConfig.env` 中保存了真实的 `base_url`、`api_key` 和 `model_id`。
- Wework 桌面端通过 `/runtime-work/resolve-model-config` 获取运行时模型配置。
- 如果后端直接把真实凭证返回给桌面端，敏感信息会离开受控的服务器环境，存在泄露风险。
- 之前的修复逐步让 executor 和 Wework 能够识别云端模型配置，但仍未彻底解决凭证隔离问题。

## 解决方案

引入后端 LLM 代理网关：Wework 只把用户输入和模型选择发给 Wegent，由 Wegent 代替 Wework 调用真实 provider。

### 核心组件

- `app/services/llm_proxy_service.py`：代理网关核心服务。
- `POST /api/runtime-work/llm-responses-proxy/responses`：代理端点。加密的代理 token 通过 `Authorization: Bearer` 请求头传递。
- `app/services/chat/trigger/unified.py` 与 `runtime_work_service.py`：根据模型配置决定是否走代理模式。

### 请求流程

1. Wework 调用 `/runtime-work/resolve-model-config` 获取模型配置。
2. 如果模型带有真实 provider 凭证，后端：
   - 生成一个加密的 Fernet 代理 token，token 中只包含用户 ID、模型 namespace/name、签发与过期时间。
   - 返回 `base_url` 为后端代理端点，`api_key` 为代理 token，`codex_responses_compat_proxy: true`。
3. Wework/executor 的 Codex compat proxy 把请求发到该 `base_url`。
4. 后端解密 token，解析 Model CRD，取出真实 `base_url`、`api_key`、`model_id`。
5. 后端把请求转发到真实 provider，并将响应流式返回给 Wework。

## 密钥管理

代理 token 使用 Fernet 对称加密。密钥获取优先级：

1. 环境变量 `LLM_PROXY_TOKEN_KEY`。
2. `SystemConfig` 表中 `llm_proxy_token_key` 配置项；不存在时自动生成并持久化。
3. 无数据库的测试/开发环境使用基于现有设置派生的确定性密钥。

生产环境无需手动配置 `LLM_PROXY_TOKEN_KEY`，后端会在首次使用时自动生成并持久化密钥。

## 安全收益

- Wework 桌面端和本地 executor 永远不会拿到真实 `api_key`。
- 代理 token 与用户和模型 CRD 绑定，并有过期时间。
- 真实 provider 凭证只留在后端内存和数据库中。

## 相关改动

- executor 把第三方 Model CRD 配置传入本地 Codex binary，并从 CRD env 解析 `model_id`。
- 后端为桌面 runtime tasks 解析云端模型配置并修正返回字段 key。
- 后端新增加密的 Codex responses 代理网关与配套测试。
- Wework 侧对接运行时模型解析和云端授权流程。

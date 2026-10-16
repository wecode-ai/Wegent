---
sidebar_position: 36
---

# 决策模型与智能判定工作台

## 配置与权限

决策模型使用现有 `kind: Model`，在模型管理中新增、编辑或删除。
用户模型沿用个人和团队权限，管理员通过公共模型管理发布公共模型。
用户表单选择“决策模型”，协议选择 `SystemOne` 或 `OpenAI Decisions`；
公共模型 JSON 使用同样的字段。

```yaml
apiVersion: agent.wecode.io/v1
kind: Model
metadata:
  name: decision-systemone
  namespace: default
  displayName: SystemOne 判定
spec:
  modelType: decision
  protocol: systemone
  isWeworkAvailable: true
  modelConfig:
    env:
      model: systemone
      model_id: jev-latest
      base_url: https://api.typesafe.ai/v1
      api_key: <provider-api-key>
status:
  state: Available
```

OpenAI 配置使用 `protocol: openai`、`env.model: openai`，并填写该服务的
模型 ID 和 HTTPS API 地址。决策模型不设置对话用途的 `apiFormat`。
`base_url` 接受服务根地址、以 `/v1` 结尾的 API 基址或对应完整端点。
SystemOne 的端点为 `/v1/systemone`，OpenAI 的端点为 `/v1/decisions`；
与协议不匹配的端点、带凭证、查询参数或片段的地址会被拒绝。

`api_key` 使用现有 Model 凭证及占位符机制，仅在后端执行时解密和解析。
不要把真实凭证写入源代码或 Smart App 环境变量。

### 部署侧凭证扩展

`app.services.model_credential_service` 提供共享扩展入口：

- `register_model_api_key_resolver(resolver)`：在部署启动时注册异步解析器。
- 解析器签名为 `async def resolver(template: str, current_user: User) -> str | None`。
- `template` 是配置中的原始占位符，不会被同名全局环境变量遮蔽。
- `current_user` 是实际请求用户，不是公共或共享 Model 的所有者。
- 返回 `None` 表示不处理该模板，保留普通 Model 配置的既有解析结果。
- 对已处理的模板必须返回有效 key；空值、异常或超时均阻止请求，不回退到全局 key。

LLM 代理和决策执行共用此入口。模型连接测试仅接受直接提供的密钥，
不解析服务器占位符，也不调用部署凭证解析器。决策执行要求非空 key，
其 30 秒总预算包含凭证解析和上游请求，兼容 Python 3.10。
凭证解析默认最多 30 秒，不缓存用户 key，也不修改已保存的 Model。
目录查询不调用凭证解析器。部署专属的接口、鉴权配置及用户 key 获取逻辑
应保留在部署扩展中；开源代码不实现特定企业的占位符语义。

默认混合网关通过 `backend-rs/config/routes.toml` 将 `GET`、`POST
`/api/models/decisions`交给 Rust。Rust 复用统一模型聚合的可见性和授权检查，
每次执行重新读取目录及 Model 配置。部署侧通过现有`AppState.llm_proxy_credentials`注册`LlmProxyCredentials`，与 Rust LLM 代理
共用凭证解析器；输入保留原始模板和当前请求用户。解析失败或返回无效 key
会阻止执行。Rust 同样不缓存凭证、不跟随重定向、不重试上游请求，且对请求
和响应分别限制 1 MiB。Python 实现及其测试保留为兼容性参照。

公共模型继续遵守 `isVisible`、`allowedUsersEnabled` 和 `allowedUsers`。
只有启用 `isWeworkAvailable` 的决策模型进入工作台目录。
决策模型不会进入 Shell 的对话模型列表。

## 请求链路

```text
Smart App（decisionModel capability）
  -> Executor loopback route + opaque route token
  -> Wegent 后端（当前用户登录态）
  -> Model CRD 指定的决策服务
```

Executor 不再读取 `WEWORK_DECISION_PROXY_UPSTREAM_URL` 或
`WEWORK_DECISION_PROXY_DEFAULT_MODEL`，也不再持有专用的模型 key 兑换缓存。
后端是模型地址、协议和凭证的唯一配置来源，必须能够访问配置的决策服务。

现有本地路由仍使用协议版本 1：

- `GET {WEWORK_DECISION_ROUTER_BASE_URL}/status`：获取实时模型目录。
- `POST {WEWORK_DECISION_ROUTER_BASE_URL}/v1/decisions`：执行判定。
- 两个请求都使用本地标记 `Authorization: Bearer wework-local-router`。
- 直接调用后端时，两个操作分别为 `GET`、`POST /api/models/decisions`，
  使用 Wegent 登录凭证而非本地标记。

目录示例：

```json
{
  "protocolVersion": 1,
  "defaultModel": "<catalog-model-id>",
  "models": [
    {
      "id": "<catalog-model-id>",
      "displayName": "SystemOne 判定",
      "modelId": "jev-latest",
      "protocol": "systemone",
      "type": "public",
      "namespace": "default"
    }
  ]
}
```

模型选择器使用 `displayName` 展示选项，保存并发送 `id`，不要发送
`modelId`，也不要自行拼接模型标识。目录 ID 根据资源来源、命名空间、
所有者和名称生成，区分同名个人与公共模型；它不是访问凭证。
更新模型配置后 ID 保持稳定，执行时重新读取配置和权限。
目录为空时 `models: []`、`defaultModel: ""`，应保留选择器和刷新入口并阻止发送。
目录和判定响应都设置 `Cache-Control: no-store`。

## 统一判定格式

Smart App 保持 SystemOne 风格的 `state` 和具名 `questions`，不因提供商切换
请求格式。以下请求可发送给目录中的任何决策模型：

```json
{
  "model": "<selected-catalog-model-id>",
  "state": { "comment": "支付连续失败" },
  "questions": {
    "urgent": { "type": "noul", "instructions": "是否需要紧急处理？" },
    "department": {
      "type": "choice",
      "instructions": "应该由哪个部门处理？",
      "criteria": { "billing": "支付问题", "technical": "系统故障" }
    },
    "severity": {
      "type": "score",
      "instructions": "问题的严重程度？",
      "criteria": ["轻微", "可绕过", "完全阻塞"]
    }
  }
}
```

后端对 SystemOne 保留结构化状态、指令和 criteria。对于 OpenAI，结构化
状态和指令序列化为 JSON 文本，`noul` 转换为 `predicate`，具名问题转换
为含 `name` 的数组，choice/score criteria 转换为 choices/levels。
返回的 answers 统一为具名对象，predicate probability 转回 noul，
概率数组转回概率映射，score legend 从原始 criteria 重建。
OpenAI refusal 保留为 `{"type": "refusal"}`，调用者必须处理拒绝状态。
此统一接口的状态是文本或结构化 JSON，不提供原生 OpenAI 图像输入接口。

请求与响应大小限制为 1 MiB，每次最多 20 个问题。choice 支持 1–255 个
选项，score 支持 2–10 个等级。非法问题、缺失或重复答案、非法数值会
明确失败；不会换协议、回退到对话模型或执行其他模型。

模型被删除、停用、隐藏或收回权限后，旧 ID 返回 `model_not_found`。
调用者刷新目录并重新选择模型，不应自动改用另一模型。上游错误只返回固定
错误信息和请求 ID，不返回提供商响应正文、调试数据或凭证。

## 从环境配置迁移

1. 在现有模型管理中创建决策 Model，填写实际协议、地址、模型 ID 和凭证。
2. 开启 `isWeworkAvailable`，检查公共模型可见性及白名单。
3. 部署后端和 Executor，刷新工作台的模型目录。
4. 删除旧的两个决策环境变量。不要再通过安装包品牌配置写入它们。

协议参考：[TypeSafe API](https://docs.typesafe.ai/api)、
[OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)。

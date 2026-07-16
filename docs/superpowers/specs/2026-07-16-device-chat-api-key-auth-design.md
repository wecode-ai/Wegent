---
sidebar_position: 1
---

# Device Chat Tasks API Key 鉴权设计

## 背景

`POST /api/device-chat/tasks` 当前使用 `security.get_current_user`，因此只接受
`Authorization: Bearer <JWT>`。项目已经为 Executor 相关接口提供
`security.get_current_user_flexible_for_executor`，统一支持 JWT 和用户创建的个人
API Key。Device Chat Tasks 会触发设备侧执行，应该与这些接口采用相同的鉴权约定。

## 目标

- 保留现有 JWT 鉴权行为。
- 支持通过 `X-API-Key: wg-...` 传入用户个人 API Key。
- 支持通过 `Authorization: Bearer wg-...` 传入用户个人 API Key。
- 复用现有个人 API Key 校验规则，包括启用状态、有效期、所属用户和用户状态。
- 将本次请求实际采用的凭证继续传给设备任务执行链路。

## 非目标

- 不支持 Service Key。
- 不修改所有使用 `security.get_current_user` 的接口。
- 不新增 API Key 格式、数据库表或权限模型。
- 不改变 Device Chat 任务创建、设备选择或消息触发逻辑。

## 方案比较

### 方案一：接口级复用现有灵活鉴权依赖（采用）

将 Device Chat Tasks 接口的用户依赖替换为
`security.get_current_user_flexible_for_executor`。该依赖已经实现项目约定的 JWT、
`X-API-Key` 和 Bearer API Key 识别与校验，且只接受个人 API Key。

优点是改动范围小、行为与现有 Executor 接口一致，也不引入重复鉴权逻辑。

### 方案二：扩展全局 `get_current_user`

让所有 JWT-only 接口自动接受 API Key。该方案会扩大 API Key 的可访问范围，难以
确认所有接口都应该开放程序化访问，因此不采用。

### 方案三：新增 Device Chat 专用鉴权依赖

可以精确控制接口行为，但会复制已有的解析、校验和错误处理规则，后续容易产生
差异，因此不采用。

## 接口与数据流

请求鉴权顺序与现有灵活鉴权依赖保持一致：

1. 若 `X-API-Key` 是 `wg-` 前缀的 API Key，优先校验并使用该凭证。
2. 否则读取 `Authorization`。Bearer 值为 `wg-` 前缀时按个人 API Key 校验。
3. 其他 Bearer 值继续按 JWT 校验。
4. 缺失或无效凭证返回 `401 Unauthorized`。

鉴权成功后，依赖返回 API Key 或 JWT 所属的 `User`。接口调用
`device_chat_task_service.create_device_chat_task` 时，将实际采用的原始凭证作为
`auth_token` 传入。这样异步设备执行及其下游后端请求可以继续使用同一凭证。

当请求同时包含有效的 `X-API-Key` 和 `Authorization` 时，用户身份与下游
`auth_token` 都使用 `X-API-Key`，避免鉴权身份和转发凭证不一致。

## 代码边界

- `backend/app/api/endpoints/device_chat_tasks.py`
  - 改用现有灵活鉴权依赖。
  - 声明可选 `X-API-Key` 请求头。
  - 从 `X-API-Key` 或 Bearer 头提取本次实际使用的下游凭证。
- `backend/tests/api/endpoints/test_device_chat_tasks_api.py`
  - 增加 API Key 端到端接口鉴权回归测试。
  - 保留现有 JWT 和缺少凭证测试。

服务层和统一触发链路的 `auth_token` 接口保持不变。

## 错误处理与安全

- 无效、禁用、过期或非个人类型的 API Key 返回 `401`，不回退到另一种身份。
- 未提供凭证继续返回 `401`。
- API Key 不写入日志或响应。
- 只有与灵活鉴权依赖判定一致的 `wg-` API Key 才能作为 `X-API-Key` 下游凭证；
  不能让未参与鉴权的任意请求头覆盖有效 JWT。
- JWT 的状态码和响应行为保持不变。

## 测试策略

聚焦接口测试覆盖：

1. JWT Bearer 请求成功，服务层收到原 JWT。
2. `X-API-Key` 个人 Key 请求成功，服务层收到该 API Key。
3. Bearer 个人 API Key 请求成功，服务层收到该 API Key。
4. 无凭证请求返回 `401`。
5. 无效个人 API Key 请求返回 `401`，且不调用任务服务。

实现遵循测试驱动流程：先添加 API Key 场景并确认在 JWT-only 实现上失败，再完成最小
接口改动并运行聚焦测试。随后运行相关鉴权测试，确认复用依赖的既有行为没有回归。

## 兼容性

现有 JWT 客户端无需修改。新客户端可以采用项目已有的任一种个人 API Key 传递方式。
请求体和响应体均不改变，因此不需要数据迁移或客户端模型更新。

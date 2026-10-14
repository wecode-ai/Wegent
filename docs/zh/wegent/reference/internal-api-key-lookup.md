---
sidebar_position: 12
---

# 内部 API Key 身份查询

可信客户端或服务可以调用 `POST /api/internal/api-keys/lookup`，查询 Wegent
签发的 API Key 是否有效以及它代表的身份。接口仅接受原始密钥，并要求使用
`INTERNAL_SERVICE_TOKEN` 进行服务间认证。

## 请求

```http
POST /api/internal/api-keys/lookup
Authorization: Bearer <INTERNAL_SERVICE_TOKEN>
Content-Type: application/json

{"api_key": "wg-<api-key>"}
```

`api_key` 是必填的非空字符串。请求缺少密钥或提供空值时返回 HTTP 422；
内部认证令牌缺失、无效或未配置时返回 HTTP 401。

## 查询顺序与身份

1. 根据密钥的 SHA256 哈希查询所有管理员创建的服务秘钥，不按创建者限制查询。
   密钥必须以 `wg-` 开头、处于启用状态且未过期。匹配成功后，直接返回该服务
   秘钥的**名称**，并标记 `key_type: "service"`。
2. 未匹配有效服务秘钥时，查询个人秘钥。个人秘钥同样必须启用且未过期，所属
   用户必须存在且处于启用状态。返回所属用户的用户名，并标记
   `key_type: "personal"`。
3. 没有有效匹配时，返回 `exists: false`，其余字段为 `null`。

服务秘钥的 `user_id` 记录创建它的管理员，不代表服务账号身份。查询结果使用
秘钥名称作为服务账号名称，因此不会返回管理员用户名，也不依赖创建者的启用
状态。插件发布秘钥不在此接口的查询范围内。

## 响应

查询成功或未匹配有效密钥均返回 HTTP 200。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `exists` | boolean | 是否匹配有效密钥 |
| `user_name` | string 或 null | 服务秘钥名称或个人秘钥所属用户的用户名 |
| `key_type` | `service`、`personal` 或 null | 匹配的密钥类型；未匹配时为 null |

服务秘钥：

```json
{"exists": true, "user_name": "model-proxy-service", "key_type": "service"}
```

个人秘钥：

```json
{"exists": true, "user_name": "alice", "key_type": "personal"}
```

无效、禁用、过期或未知密钥：

```json
{"exists": false, "user_name": null, "key_type": null}
```

`exists` 与 `user_name` 保留原有字段，`key_type` 是新增的可选字段。现有客户端
可以继续只读取前两个字段；需要区分服务身份和个人身份的客户端应读取
`key_type`。

查询不会更新 `last_used_at`、创建用户或修改密钥。执行器认证仍然只接受个人
秘钥；本接口识别服务秘钥不会改变执行器的认证规则。默认混合网关路由由 Python
后端处理此接口。

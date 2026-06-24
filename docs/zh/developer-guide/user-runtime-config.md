---
sidebar_position: 26
---

# 用户运行时配置

[English](../../en/developer-guide/user-runtime-config.md) | 简体中文

`UserRuntimeConfig` 用于保存只对当前用户生效的本地 CLI 运行时配置，例如 Codex 或后续 Claude 的认证文件。资源存储在现有 `kinds` 表中，不新增数据库表。

## 存储结构

每个运行时使用一条用户级 Kind 资源：

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "UserRuntimeConfig",
  "metadata": {
    "name": "codex",
    "namespace": "default"
  },
  "spec": {
    "runtime": "codex",
    "auth": {
      "format": "json",
      "targetPath": "~/.codex/auth.json",
      "encryptedValue": "...",
      "sha256": "...",
      "sourceDeviceId": "...",
      "sourceModifiedAt": "...",
      "updatedAt": "..."
    },
    "updatedAt": "..."
  }
}
```

个人代理配置使用独立的用户级 Kind 资源，避免绑定到某一个运行时：

```json
{
  "apiVersion": "agent.wecode.io/v1",
  "kind": "UserProxyConfig",
  "metadata": {
    "name": "default",
    "namespace": "default"
  },
  "spec": {
    "proxy": {
      "encryptedUrl": "...",
      "sha256": "...",
      "updatedAt": "..."
    },
    "updatedAt": "..."
  }
}
```

资源仍按 Kind 规则用 `user_id + namespace + name` 定位。`UserRuntimeConfig` 的 `name` 是运行时标识，例如 `codex`；后续扩展 Claude 时新增 `claude` 资源即可。`UserProxyConfig` 的 `name` 固定为 `default`，表示当前用户的默认个人代理。

“是否启用个人配置”和“该运行时是否使用个人代理”不存放在 Kind 中，而是作为用户偏好存放在 `users.preferences`：

```json
{
  "runtime_configs": {
    "codex": {
      "use_user_config": true,
      "use_proxy": true,
      "auth_sync": {
        "master_device_id": "macbook-pro",
        "slave_device_ids": ["linux-builder"]
      }
    }
  }
}
```

## 安全规则

- 上传内容必须是合法 JSON，并且顶层必须是 object。
- 后端使用 `shared.utils.crypto.encrypt_sensitive_data()` 加密后存储。
- API 响应只返回是否已配置、更新时间、目标路径和摘要，不返回明文或密文。
- 代理 URL 也加密存储，API 只返回脱敏后的展示值。
- 前端不得在状态、toast 或同步结果中展示认证内容。

## 执行代理

个人代理配置只在执行期注入 executor，不下发到设备 auth 文件。后端在构建执行请求时，如果用户为 `codex` 启用了 `use_proxy` 且 `UserProxyConfig/default` 已保存代理 URL，会把明文代理 URL 放入执行请求顶层的 `proxy.url`。消费层根据自己的运行时开关决定是否使用该代理。

executor 启动 Codex SDK 时把代理 URL 注入为 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 以及对应的小写变量。`NO_PROXY` 的规则是：

- 如果 executor 原有环境已经配置 `NO_PROXY` 或 `no_proxy`，沿用原值。
- 如果没有配置，默认使用 `localhost,127.0.0.1,::1,host.docker.internal`，避免本地 stdio/localhost 类访问走代理。

## 主从设备同步

用户可以在 Codex 认证设置中选择一台主设备和多台从设备。主设备是 `auth.json` 的来源，不会被后端覆盖；从设备是接收端，后端会用当前保存的主版本直接覆盖它们的 `~/.codex/auth.json`。

executor 会在设备心跳中上报 Codex auth 文件的存在状态、SHA-256 摘要和本地修改时间。后端只对用户选择的设备执行同步策略：

- 主设备心跳：如果上报的摘要不同，并且本地修改时间晚于后端已保存的 `sourceModifiedAt`（或后端保存时间），后端通过 `read_runtime_auth_file` 读取主设备文件，校验 JSON 后加密保存，并记录 `sourceDeviceId` 与 `sourceModifiedAt`。随后后端把新的 auth 下发给所有从设备。
- 从设备心跳：如果用户启用了个人配置且后端已保存 auth，后端调用 `sync_runtime_auth_file`，携带显式覆盖标记，把保存的 auth 直接写入该从设备。
- 未被选择为主设备或从设备的设备心跳不会触发 auth 同步。

下发链路复用 Local Device Command RPC：后端调用白名单命令 `sync_runtime_auth_file`，通过环境变量传递认证内容，避免把密文或明文放到命令行日志。会话启动时只注入是否启用个人配置的状态，不再负责解密或下发 auth 文件。

设备端写入规则：

- 目标路径必须在当前用户 home 目录内。
- 默认同步不覆盖已有文件，目标文件已存在时返回 `skipped_existing`。
- 主从同步到从设备时会设置 `WEGENT_RUNTIME_CONFIG_OVERWRITE=true`，目标文件已存在时直接原子替换并返回 `overwritten`。
- 写入时会创建父目录，并以 `0600` 权限保存文件。

从设备导入配置时，后端调用 `read_runtime_auth_file` 读取目标文件，校验 JSON 后加密保存；读取到的内容不会返回给前端。手动上传 auth 后，如果已配置从设备，后端也会 best-effort 同步到这些从设备。

## 扩展运行时

新增运行时需要扩展后端运行时注册表，至少声明：

- 运行时标识，例如 `claude`
- 展示名称
- 认证文件目标路径
- 格式校验策略

扩展后可复用同一组 `/users/me/runtime-configs/{runtime}` API、设置页开关、加密存储和主从设备同步逻辑。

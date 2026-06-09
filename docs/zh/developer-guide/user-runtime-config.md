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
      "updatedAt": "..."
    },
    "updatedAt": "..."
  }
}
```

资源仍按 Kind 规则用 `user_id + namespace + name` 定位。`name` 是运行时标识，例如 `codex`；后续扩展 Claude 时新增 `claude` 资源即可。

“是否启用个人配置”不存放在 `UserRuntimeConfig` 中，而是作为用户偏好存放在 `users.preferences`：

```json
{
  "runtime_configs": {
    "codex": {
      "use_user_config": true
    }
  }
}
```

## 安全规则

- 上传内容必须是合法 JSON，并且顶层必须是 object。
- 后端使用 `shared.utils.crypto.encrypt_sensitive_data()` 加密后存储。
- API 响应只返回是否已配置、更新时间、目标路径和摘要，不返回明文或密文。
- 前端不得在状态、toast 或同步结果中展示认证内容。

## 设备心跳同步

用户启用个人配置后，executor 会在设备心跳中上报本机是否存在 Codex auth 文件。后端发现某个在线设备缺少 `~/.codex/auth.json`，且用户偏好启用了 Codex 个人配置、系统已保存 auth 内容时，会在后台把 auth 下发到该设备。

下发链路复用 Local Device Command RPC：后端调用白名单命令 `sync_runtime_auth_file`，通过环境变量传递认证内容，避免把密文或明文放到命令行日志。会话启动时只注入是否启用个人配置的状态，不再负责解密或下发 auth 文件。

设备端写入规则：

- 目标路径必须在当前用户 home 目录内。
- 目标文件已存在时返回 `skipped_existing`，不覆盖。
- 目标文件不存在时创建父目录，并以 `0600` 权限写入。

从设备导入配置时，后端调用 `read_runtime_auth_file` 读取目标文件，校验 JSON 后加密保存；读取到的内容不会返回给前端。

## 扩展运行时

新增运行时需要扩展后端运行时注册表，至少声明：

- 运行时标识，例如 `claude`
- 展示名称
- 认证文件目标路径
- 格式校验策略

扩展后可复用同一组 `/users/me/runtime-configs/{runtime}` API、设置页开关、加密存储和设备心跳同步逻辑。

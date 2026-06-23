---
sidebar_position: 1
---

# Codex Auth 主从同步设计

## 背景

当前 Codex `auth.json` 由 `UserRuntimeConfig` 保存为用户级加密 Kind。设备心跳只上报 `~/.codex/auth.json` 是否存在；后端发现某台在线设备缺失 auth 文件时，会通过 `sync_runtime_auth_file` 写入保存的 auth。设备端写入规则是“已有文件则跳过”，因此无法修复已有但过期的 `auth.json`。

这次需求要把 Codex auth 同步改成用户可控的主从模型：主设备负责提供最新 auth，从设备负责接收覆盖同步。主设备不接收覆盖。

## 目标

- 用户可以为 Codex auth 选择一台主设备和多台从设备。
- 主设备只作为来源。后端读取主设备的 `~/.codex/auth.json`，不会向主设备写入 auth。
- 从设备只作为目标。收到同步时直接覆盖已有 `~/.codex/auth.json`，不再跳过已有文件。
- 手动上传 auth 后，后端保存版本更新，并覆盖所有在线从设备；主设备仍不被覆盖。
- 主设备心跳能携带 auth 文件摘要和修改时间。后端发现主设备 auth 比保存版本新时，自动导入并同步到从设备。
- 离线从设备上线后应被补同步，补同步同样覆盖已有文件。
- auth 明文只在后端解密下发和设备命令环境变量中短暂存在，不进入 API 响应、日志、toast 或前端状态。

## 非目标

- 不支持多主自动取最新。
- 不合并多份 auth，也不尝试解析 Codex token 的真实过期时间。
- 不改变 Codex 代理配置逻辑。
- 不把 auth 明文暴露给前端或设备列表 API。

## 用户模型

Codex 认证页增加一个“设备同步”区域：

- 主设备：单选，只能选择在线或已登记的 Claude Code 设备。未设置主设备时，不执行主设备自动导入。
- 从设备：多选，不能包含主设备。保存后立即触发一次同步到在线从设备。
- 手动上传：仍允许没有主设备时使用。上传成功后覆盖所有在线从设备。

主设备和从设备的语义必须在界面上直接可见：主设备是来源，从设备会被覆盖。

## 存储设计

auth 内容继续保存在 `UserRuntimeConfig/codex` 的 `spec.auth` 中：

```json
{
  "auth": {
    "format": "json",
    "targetPath": "~/.codex/auth.json",
    "encryptedValue": "...",
    "sha256": "...",
    "updatedAt": "...",
    "sourceDeviceId": "macbook-pro",
    "sourceModifiedAt": "2026-06-23T10:00:00+08:00"
  }
}
```

主从拓扑属于用户偏好，保存到 `users.preferences.runtime_configs.codex.auth_sync`：

```json
{
  "runtime_configs": {
    "codex": {
      "use_user_config": true,
      "use_proxy": false,
      "auth_sync": {
        "master_device_id": "macbook-pro",
        "slave_device_ids": ["linux-box", "office-mac"]
      }
    }
  }
}
```

拓扑不是凭据，不需要加密。保存时后端要保证 `master_device_id` 不出现在 `slave_device_ids` 中，并去重从设备。

## 心跳元数据

executor 的 `build_runtime_auth_file_report()` 从只上报存在状态扩展为：

```json
{
  "codex": {
    "target_path": "~/.codex/auth.json",
    "exists": true,
    "sha256": "...",
    "modified_at": "2026-06-23T10:00:00+08:00"
  }
}
```

当文件不存在时只返回 `exists: false` 和 `target_path`。摘要基于文件原始字节计算；修改时间来自文件系统 mtime，使用带时区的 ISO 字符串。

## 后端流程

### 获取配置

`GET /users/me/runtime-configs/codex` 返回现有状态，并新增同步拓扑字段：

```json
{
  "auth_sync": {
    "master_device_id": "macbook-pro",
    "slave_device_ids": ["linux-box", "office-mac"]
  }
}
```

响应不返回主设备文件内容。

### 保存拓扑

`PUT /users/me/runtime-configs/codex` 接受可选 `auth_sync`。后端保存拓扑后，如果已有保存的 auth 且有在线从设备，立即触发一次从设备覆盖同步。

### 主设备自动导入

设备心跳到达后：

1. 如果该设备不是当前 Codex 主设备，不做主源导入判断。
2. 如果心跳没有 `exists: true`、`sha256` 或 `modified_at`，不导入。
3. 如果心跳 `sha256` 与后端保存的 `spec.auth.sha256` 相同，不导入。
4. 后端计算当前版本基准时间：优先使用 `sourceModifiedAt`，没有时使用 `spec.auth.updatedAt`。
5. 如果心跳 `modified_at` 不晚于当前版本基准时间，不导入。
6. 后端通过 `read_runtime_auth_file` 从主设备读取 auth，校验 JSON，加密保存，并记录 `sourceDeviceId` 与 `sourceModifiedAt`。
7. 保存成功后，把新版本覆盖同步到所有在线从设备。

如果后端没有保存版本，只要主设备上报有效 auth，就导入并同步。

### 手动上传

`POST /users/me/runtime-configs/codex/auth-json` 继续校验 JSON 并加密保存。上传保存时清空或改写来源元数据为手动来源：

```json
{
  "sourceDeviceId": null,
  "sourceModifiedAt": null
}
```

上传成功后覆盖所有在线从设备，仍不覆盖主设备。

主设备后续仍可成为来源，但只有当主设备文件 `modified_at` 晚于手动上传产生的 `spec.auth.updatedAt` 时才会自动导入，避免旧的主设备文件覆盖刚上传的版本。

### 从设备补同步

任意从设备心跳到达后，如果用户启用 Codex 个人配置且后端已有 auth，后端对该从设备发起覆盖同步。该逻辑不依赖“文件缺失”，从设备已有文件也覆盖。

## 设备命令

`sync_runtime_auth_file` 增加覆盖语义。后端同步到从设备时传入：

```bash
WEGENT_RUNTIME_CONFIG_OVERWRITE=true
```

命令行为：

- 目标路径必须在当前用户 home 内。
- 内容必须是 JSON object。
- `WEGENT_RUNTIME_CONFIG_OVERWRITE=true` 时，使用原子写入覆盖目标文件，并设置权限为 `0600`。
- 未传覆盖开关时保留旧行为：已有文件返回 `skipped_existing`。

保留旧行为可以避免其他调用方被隐式改变；Codex 主从同步路径始终使用覆盖开关。

## 错误处理

- 主设备离线：不导入，保留后端当前版本。
- 从设备离线：跳过本次同步，上线心跳后补同步。
- 主设备读取失败：记录 warning，不覆盖后端保存版本，也不同步从设备。
- 从设备覆盖失败：单设备返回失败状态，不影响其他从设备。
- 拓扑中设备被删除或不属于当前用户：保存时拒绝；已有旧拓扑在读取时过滤不可见设备，并在下次保存时清理。

## 测试策略

- 后端服务测试：
  - 保存拓扑时去重，并拒绝主设备同时作为从设备。
  - 主设备心跳 `sha256` 不变时不读取设备。
  - 主设备心跳版本更新时导入并同步从设备。
  - 手动上传后同步从设备但不同步主设备。
  - 从设备心跳会触发覆盖补同步。
- 设备命令测试：
  - 默认已有文件仍返回 `skipped_existing`。
  - 覆盖开关为 true 时覆盖已有文件并保持 `0600` 权限。
  - 非 JSON object、home 外路径继续失败。
- executor 测试：
  - auth 文件存在时心跳报告包含 `sha256` 和 `modified_at`。
  - auth 文件不存在时只报告 `exists: false`。
- Wework 测试：
  - 能选择一台主设备和多台从设备。
  - 从设备列表不包含当前主设备。
  - 保存同步设置调用 API，并显示保存后的状态。

## 文档更新

实现完成后更新：

- `docs/zh/developer-guide/user-runtime-config.md`
- `docs/en/developer-guide/user-runtime-config.md`

中文文档先更新，再同步英文版本。

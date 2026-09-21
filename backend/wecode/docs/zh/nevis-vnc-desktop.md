---
sidebar_position: 2
---

# Nevis 云设备 VNC 桌面

公开契约见 `docs/zh/wework/developer-guide/wework-device-vnc-desktop.md`，本页是它背后的内网 provider。本页内容、相关配置和 provider 实现都只保留在内网发行版中。

## Provider 配置

```env
NEVIS_BASE_URL=https://nevis.example.com
NEVIS_MANAGER_ID=manager-id
NEVIS_SIGNATURE=<signature>
```

Backend 只在准备或重新授权上游连接时读取这些配置，不写入 REST 响应、Redis 会话记录、浏览器日志或监控标签。

## 注册方式

`wecode/service/vnc_session_provider.py` 向公开 registry 为 `DeviceType.CLOUD` 注册 `NevisVncSessionProvider`，`wecode/api/__init__.py` 通过导入该模块触发注册副作用。其他设备类型都没有 VNC provider，因此远程设备、本地设备和其他类型失败关闭。

## 会话流程

创建 HTTP 会话时和打开上游 WebSocket 前都会执行 `prepare`：

1. `cloud_device_provider` 未配置时直接拒绝。
2. 读取设备状态，要求存在调用方拥有的 sandbox 身份（`cloudConfig.sandboxId`）。
3. 查询 sandbox 实时状态，要求处于就绪状态（`ready` 或 `running`）。
4. 要求 `NEVIS_SIGNATURE` 非空。
5. 拼出只供 Backend 使用的地址
   `{NEVIS_BASE_URL}/apis/sandboxes/v1/managers/{NEVIS_MANAGER_ID}/sandboxes/{sandbox_id}/vnc`
   并附带 `X-Signature` 头返回。

`authorize` 会再次调用 `prepare`，并在 sandbox 身份与会话创建时不一致时拒绝连接，避免重建的 sandbox 继承既有会话。

`vnc_session_provider.py` 同时把 `cloud_device_provider.get_vm_status` 注册为云设备 session host 解析器，保证桌面地址和设备会话地址指向同一个 sandbox。

## 安全保证

- signature 每次 prepare 都从配置即时读取，不落 Redis，也不返回给客户端。
- 客户端和 Wework 只能拿到短时的 `/vnc-proxy/sessions/<id>?ticket=...` 地址；Nevis 地址、manager ID、sandbox ID 和 signature 都留在 Backend。
- provider 不会覆盖 HTTP 鉴权阶段确定的 owner。
- sandbox 身份变化会使既有会话失效，而不是静默重连。

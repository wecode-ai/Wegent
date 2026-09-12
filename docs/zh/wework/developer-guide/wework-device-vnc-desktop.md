---
sidebar_position: 41
---

# Wework 云设备 VNC 远程桌面方案

## 文档状态

本文是 Wework / Wecode 云设备远程桌面的开发级方案。实现以本文为准：远程桌面能力抽象为通用 VNC WebSocket Viewer，设备只需要提供一个通过后端授权后的 VNC WebSocket 地址；云端设备和远程设备复用同一套客户端、后端会话和 Executor 网关链路。

## 目标

1. Wework 客户端能从云设备卡片打开真实 Linux 桌面。
2. Viewer 不感知设备类型、token、RFB 内网地址或容器细节，只接收 `websocketUrl`。
3. 设备能力由在线 Runtime 心跳上报，UI 只在实时可用时展示入口。
4. 后端只为声明了 live desktop capability 的在线设备创建 VNC 会话。
5. VNC 服务只监听容器或本机回环地址，不能暴露公开 `5900/5901/6080` 端口。
6. 键盘、鼠标、屏幕和文本复制粘贴需要有本地验证闭环。

## 总体架构

```mermaid
flowchart LR
  A[Wework UI] -->|deviceId| B[Backend POST /devices/{id}/vnc]
  B -->|device:start_vnc_session| C[Executor]
  C --> D[Session Gateway /s/{session}/websockify?token=...]
  D -->|raw TCP proxy| E[127.0.0.1:5901 TigerVNC]
  E --> F[XFCE Desktop]
```

客户端边界固定为：

```ts
<VncViewer websocketUrl={session.url} />
```

`VncViewer` 不接收 device、token、protocol 或 capability。所有鉴权、地址转换、能力判断都在 UI 上层、后端和 Executor 内完成。

## 设备能力模型

Runtime 心跳的 `runtime_features` 使用 schema v4：

```json
{
  "schemaVersion": 4,
  "shells": {
    "terminal": { "available": true },
    "codeServer": { "available": true }
  },
  "desktop": {
    "version": 1,
    "available": true,
    "protocol": "rfb",
    "transport": "websocket",
    "clipboard": "extended-text"
  }
}
```

设备 VNC 能力通过三层体现：

1. **镜像/运行时配置**：设备容器安装 TigerVNC、XFCE、xclip，并设置 `DEVICE_VNC_DESKTOP_ENABLED=true`、`DEVICE_VNC_RFB_ADDR=127.0.0.1:5901`。
2. **Executor live probe**：Executor 心跳前探测本机回环 RFB banner；探测成功才上报 `desktop.available=true`。
3. **UI fail-closed**：Wework 只在设备是 cloud/remote、状态可用且 live capability 为 `rfb + websocket` 时展示“桌面”入口。

如果 VNC 进程未启动、RFB 地址不是回环地址、Session Gateway 未启用，或者后端收到的 live capability 不合法，入口不会出现，会话接口也会拒绝创建。

## 运行时配置

设备容器默认启用 VNC 桌面：

| 变量                             | 默认值           | 说明                                                       |
| -------------------------------- | ---------------- | ---------------------------------------------------------- |
| `DEVICE_SESSION_GATEWAY_ENABLED` | `true`           | 必须启用，VNC 只通过 token-gated gateway 暴露              |
| `DEVICE_VNC_DESKTOP_ENABLED`     | `true`           | 是否启动和上报 VNC 桌面                                    |
| `DEVICE_VNC_RFB_ADDR`            | `127.0.0.1:5901` | Executor 连接的内网 RFB 地址，设备镜像中固定要求为回环地址 |
| `DEVICE_VNC_CLIPBOARD_MODE`      | `extended-text`  | 上报给客户端的剪贴板能力                                   |
| `DEVICE_VNC_GEOMETRY`            | `1440x900`       | TigerVNC 虚拟桌面尺寸                                      |

容器只 `EXPOSE 17888 18080`。`5901` 不映射到宿主机，不允许外部直连。VNC 使用 `SecurityTypes None` 是因为它只监听 `localhost`，真实访问控制由设备 Session Gateway 的 session token 完成。

远程设备如果要演示同一能力，也按同样原则部署：设备内部启动 VNC server，Executor 只接受回环地址，外部只访问后端下发的 VNC WebSocket session URL。

## 会话链路

1. UI 调用 `POST /api/v1/devices/{device_id}/vnc`。
2. 后端读取设备 live `runtime_features.desktop`，要求：
   - `available=true`
   - `protocol=rfb`
   - `transport=websocket`
   - 设备在线且当前用户有权限
3. 后端发送 `device:start_vnc_session` RPC。
4. Executor 创建 `SessionType::Vnc` 本地会话，检查 `DEVICE_VNC_RFB_ADDR` 是 loopback，并确认 RFB TCP 可连接。
5. Executor 返回 `ws://.../s/{session_id}/websockify?token=...`。
6. Viewer 使用 noVNC 直接连接 WebSocket；Gateway 将 WebSocket binary frame 代理到 `127.0.0.1:5901`。

## 客户端交互

云设备和远程设备共用一个 DSH 内部页面 `/device-desktop?deviceId=...`。路由只携带 `deviceId`，不把 session token 存入 tab URL。

Viewer 提供：

- 连接状态；
- 粘贴按钮；
- Ctrl+Alt+Del；
- 只读/控制切换；
- 全屏；
- 断开连接。

Electron 环境下，VNC 剪贴板通过主进程能力 `vncClipboard.*` 访问系统剪贴板，并要求当前 Wework 窗口获得焦点且 lease 匹配；浏览器环境下使用标准 Clipboard API。

## 复制粘贴验证

VNC 剪贴板需要验证两个方向：

1. **远端到本机**：在 VNC 桌面复制文本，noVNC 收到 `clipboard` event，Wework 写入本机剪贴板。
2. **本机到远端**：在本机复制文本，点击 Viewer 的“同步本机剪贴板”按钮，Viewer 调用 `clipboardPasteFrom(text)` 发给远端。该动作只更新远端剪贴板，不假设远端操作系统或当前应用的粘贴快捷键；同步成功后还要在远端应用中执行粘贴。Linux 图形终端通常使用 `Ctrl+Shift+V` 或 `Shift+Insert`，普通编辑器通常使用 `Ctrl+V`。

Linux 终端向本机复制时，应先选中文本，再使用终端自己的复制快捷键（通常是 `Ctrl+Shift+C`）；不能把 macOS 的 `Command+C` 直接当成远端 Linux 应用的复制快捷键。Viewer 收到远端剪贴板更新后会显示“远端文本已复制到本机剪贴板”。

验证文本应包含 ASCII、中文、emoji、换行和制表符，例如：

```text
UNICODE-L2R-R2L-中文-🙂-20260912
line-2	末尾
```

通过标准：同步后在远端应用执行粘贴，远端文本编辑器中的内容与原始文本字节级一致；远端应用执行复制后，本机剪贴板读回也一致。

## 本机完整验证

本机演示使用真实 VNC 桌面而不是 mock：

1. 启动一个带 XFCE + TigerVNC + noVNC 的本地容器。
2. 仅将演示端口绑定到 `127.0.0.1`。
3. 用 noVNC 打开桌面，验证画面、鼠标和键盘输入。
4. 通过 noVNC extended clipboard 验证 Unicode 文本双向复制粘贴。
5. 构建设备镜像，运行设备 entrypoint，确认容器内 `127.0.0.1:5901` 返回 `RFB 003.008` banner，且 Docker 只发布 session gateway / code-server 端口。
6. 运行后端、Executor、Wework 和 Electron 相关单元测试，再用 Wework AI 验证工具做真实 Electron smoke。

## 安全边界

- 不允许把 VNC 原始端口公开给浏览器或互联网。
- 不允许客户端自己拼 token 或 RFB 地址。
- 不允许后端在缺少 live desktop capability 时创建 VNC 会话。
- 不允许 Executor 代理非 loopback RFB 地址。
- 剪贴板访问必须绑定当前聚焦窗口和 lease，避免后台页面读写系统剪贴板。

## 验收清单

- `runtime_features.schemaVersion` 升级到 4，旧字段兼容读取。
- 设备有 live desktop capability 时才显示桌面入口。
- `/devices/{device_id}/vnc` 返回 `type=vnc`、`transport=websocket`、`url=ws(s)://...`。
- Viewer 只依赖 `websocketUrl`。
- Gateway 能将 WebSocket 代理到回环 RFB server。
- 设备镜像启动 TigerVNC/XFCE，且不暴露 VNC 原始端口。
- 复制粘贴双向通过真实 VNC 桌面验证。

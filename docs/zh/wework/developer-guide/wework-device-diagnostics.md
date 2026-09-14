---
sidebar_position: 31
---

# Wework 设备诊断接口

Wework 为核心 DSH 和独立 Smart App 提供只读能力 `deviceDiagnostics.microphone`。
首版检测 macOS 麦克风系统权限、合盖状态、硬件断开支持、主程序与音频 Helper 的
Hardened Runtime 音频授权，以及麦克风用途说明。其他平台返回 `unsupported`。
接口不申请权限、不启动录音、不修改系统设置，也不读取 TCC 数据库。

## DSH 接入

在声明依赖 `weworkDesktop` 服务的插件中，服务端和浏览器端使用相同接口：

```ts
const result = await ctx.weworkDesktop.deviceDiagnostics.microphone({
  inputDeviceKind: "built-in",
});
```

`inputDeviceKind` 可为 `built-in`、`external` 或 `unknown`，默认 `unknown`。
它表示调用方已确认的当前输入设备类型，不会切换系统设备。无法确认时应省略，
不要仅凭设备 ID 为 `default` 就认定是内置麦克风。
类型从 `@wegent/dsh-electron-host/desktop-service` 导出。

也可使用插件所在 DSH 的同源 Host HTTP 接口：

```http
POST /wework/electron-host/v1/invoke
Content-Type: application/json

{"capability":"deviceDiagnostics.microphone","params":{}}
```

正常诊断返回 HTTP 200、`{ok: true, result}`，即使检测到了阻断。
非法设备类型返回 HTTP 400、`error.code: invalid_params`。
接入旧版 Wework 时先通过服务的 `describe()` 查询能力列表；未提供此能力表示宿主需要升级，
不能将接口不存在解释为设备正常。

## 返回约定

`result` 包含 `schemaVersion: 1`、`platform`、ISO 时间 `checkedAt`、总体 `status`、
主状态码 `code`、全部问题 `issues`、调用方设备类型和原始检测结果 `checks`。
每个问题包含 `code`、`severity`（`error` / `warning` / `info`）以及建议动作 `actions`。
建议动作只是标识符，Wework 不会自动执行。

| status        | 含义                                             |
| ------------- | ------------------------------------------------ |
| `blocked`     | 至少一个确定阻断                                 |
| `warning`     | 需要授权，或存在尚未确定影响当前设备的情况       |
| `unknown`     | 关键检测结果无法读取，且没有更高优先级问题       |
| `ok`          | 本次检查没有发现已知宿主阻断，不代表已经采到声音 |
| `unsupported` | 当前平台不支持此版本诊断                         |

`code` 优先取 error，再取 warning，最后取 info；同级按 `issues` 顺序。
签名配置问题先于权限和合盖问题。DSH 应保留全部问题，避免只处理主状态码而漏掉其他阻断。

| 状态码                                    | 建议用户提示 / actions                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `MICROPHONE_PERMISSION_DENIED`            | 系统未允许 Wework 使用麦克风；`open_microphone_settings`                                        |
| `MICROPHONE_PERMISSION_RESTRICTED`        | 系统策略限制麦克风；`contact_administrator`                                                     |
| `MICROPHONE_PERMISSION_NOT_DETERMINED`    | 尚未申请授权，点击开始录音后申请；`request_microphone_access`                                   |
| `MICROPHONE_APP_ENTITLEMENT_MISSING`      | 当前客户端主程序缺少录音签名授权；`update_application`                                          |
| `MICROPHONE_HELPER_ENTITLEMENT_MISSING`   | 当前客户端音频 Helper 缺少录音签名授权；`update_application`                                    |
| `MICROPHONE_USAGE_DESCRIPTION_MISSING`    | 当前客户端缺少麦克风用途说明；`update_application`                                              |
| `MICROPHONE_BUILT_IN_DISABLED_LID_CLOSED` | 合盖已禁用所选内置麦克风，请打开屏幕或使用外接麦克风；`open_lid` / `select_external_microphone` |
| `MICROPHONE_LID_CLOSED`                   | 检测到合盖；若使用内置麦克风，请打开屏幕或改用外接麦克风；同上                                  |
| `MICROPHONE_DIAGNOSTICS_INCOMPLETE`       | 暂时无法完整检测设备状态；`retry_diagnostics`                                                   |
| `MICROPHONE_DIAGNOSTICS_UNSUPPORTED`      | 当前平台暂不支持宿主诊断                                                                        |
| `MICROPHONE_NO_KNOWN_BLOCKER`             | 未发现已知宿主阻断，继续检查实际音频信号                                                        |

## 检测边界与调用时机

- `checks.permission` 读取 Electron 的系统权限状态；它不代表浏览器 origin 已获授权。
  开发工具代为启动应用时，macOS 的责任进程归属也可能影响权限，应使用独立启动的安装包验证。
- 签名检查读取当前应用和同包通用 Helper（承载音频服务）的签名元数据。
  仅在 Hardened Runtime 已开启且确认缺少音频授权时返回授权缺失。
  这不是完整的签名真实性、公证或官方发布身份验证。
- 当前仅能确认 Apple Silicon 的合盖硬件断开支持；Intel/T2 支持状态返回 `null`。
  只有确认硬件支持、正在合盖、调用方明确选择内置麦克风时，才返回合盖阻断。
  外接设备不会收到合盖问题；类型未知时仅返回条件提示。
- 读取失败、超时或内容无法解析时返回 `unknown` / `null`，不能据此断言缺少授权。
  每个原生命令最多等待 2 秒；每次调用重新读取状态，便于打开屏幕后重试。
- 推荐在录音前、权限失败或持续静音时调用，并在用户处理后提供重试。
  不应按音频帧轮询。DSH 仍负责采样检测、设备选择、录音中断处理和用户提示。
  持续静音只能证明未检测到信号，不能单独确定是宿主权限问题。

签名缺陷必须通过 Wework 的正式签名打包流程修复；DSH 的提示无法补齐宿主授权。

## 回归验证

单元测试覆盖状态优先级、缺失与未知的区别、内置/外接设备、授权状态、异常和重试恢复。
DSH 服务测试覆盖浏览器和服务端映射与生命周期。CI 已有的 `dsh-owner-capture`
checkpoint 同时验证核心 DSH 和独立 Smart App 的真实接口、非法参数与恢复。
正式包的签名授权由 `release-package-startup` checkpoint 检查。

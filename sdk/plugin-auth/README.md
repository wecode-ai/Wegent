---
sidebar_position: 1
title: Python 插件账号认证 SDK
---

# Python 插件账号认证 SDK

这是 `accountAuth` 协议草案 v1 的公共 Python 实现，SDK 版本为 `0.7.1`。
支持 Python 3.9+，只使用标准库；SDK 源码随插件打包，不依赖运行时安装。
邮箱插件已使用此实现。当前提供原生 `export`、`run` 和公开业务命令委托，
已接入桌面与独立设备的 Backend Runner。OAuth 授权、刷新回调已接入原生链路；真实后端/桌面已通过合成 OAuth 服务的端到端验证，提供方撤销已接入持久化任务；真实服务方与 Windows 实机验收待完成，协议继续作为草案。

SDK 根据宿主 capabilities 清单中的 `store_path`、`runtime.codex_link` 和
`runtime.claude_link` 识别安装身份，支持运行时复制目录。未登记、禁用、非托管
或映射不唯一的路径不能发起账号代理请求；原生宿主继续校验包哈希与设备权限。

## 新插件接入

从 Wegent 仓库根目录执行：

```bash
uv run --no-project python sdk/plugin-auth/tool.py scaffold my-service \
  --parent ../plugins --credential-type password
```

`--credential-type` 可选 `password`、`bearer`、`oauth2`。生成的目录包含：

- `.codex-plugin/plugin.json`：connector 与 `accountAuth` 声明。
- `scripts/account-auth.py`：原生代理入口，通常无需修改。
- `scripts/auth_provider.py`：开发者实现的提供方回调。
- `scripts/cli.py`：公开业务命令入口，云端自动委托原生执行。
- `scripts/wegent_plugin_auth/`：SDK、许可证、版本及 SHA-256 清单。

模板是开发骨架，默认拒绝导出与执行，不会自动启用连接，也不会新增登录 UI、
Skill 或 MCP。现有插件的 `localAuth` 和业务入口由插件维护；不要把原生适配器
暴露为模型工具或在 Skill 中让模型执行。

开发者只需要填写以下内容，不需要手写管道和帧协议：

| 接口                             | 职责                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| `export_local()`                 | 读取已有本机认证并返回 JSON 字典；不删除、重置或替换原认证 |
| `account_id(credential)`         | 返回稳定的公开账号标识，绝不能返回密码、Token              |
| `ALLOWED_COMMANDS`               | 明确允许的业务命令，排除登录、登出、认证导出等管理命令     |
| `execute(credential, arguments)` | 在进程内使用凭据执行现有业务；通过上下文管理器恢复状态     |
| `validate(credential)`           | 可选的服务方字段校验；不需要重复 SDK 的基础校验            |

基础字段约定：password 为非空 `username`、`password`；bearer 为非空 `token`；
oauth2 为非空 `access_token`。提供方可以携带服务器地址等额外 JSON 字段，
但不能用钥匙串数据库或操作系统加密文件代替可用凭据。

OAuth 模板生成 `authorize()`、`refresh(credential)`、`revoke(credential)` 回调，
并通过 `accountAuth.oauth2` 声明支持的操作。授权通过本机一次性意图启动；刷新
由平台租约限制为一台原生设备执行，结果提交后业务代码仅收到 Access Token。
回调返回绝对时间 `expires_at`，轮换时返回新的 `refresh_token`；SDK 自动保留
未变化的账号字段与未轮换的 Refresh Token。提供方回调不要重试不确定的刷新。
设备权限变更、重建、账号断开与重新授权不会被迟到的刷新结果覆盖。

授权、刷新或撤销专用的其他秘密放入 `provider_private` 对象；后端不会向业务
回调下发该对象、`refresh_token`、`client_secret` 和 `persistent_code`。
已有 CLI 若能安全转移唯一刷新权，可声明 `exportMode: "exclusive"`，并提供
`detach(migration_id, credential)` 回调。宿主先加密暂存，再调用此回调，最后激活。
回调必须持久化可恢复记录、只移除对应旧授权、幂等处理确认丢失，并在异常时抛错。
`export` 不能自行删除源凭据。普通密码和 API Key 接入无需实现 `detach`。

如果导出后源凭据已轮换，`detach` 可抛出 `SourceChanged`，但必须先在提供方存储锁内
持久化该迁移 ID 的作废记录，保证迟到或重启的同 ID 操作永远不能删除凭据。
SDK 仅返回固定 `source_changed` 元数据；原生宿主随后取消旧暂存，用户再次迁移会
取得新 ID 和最新凭据。无法证明旧 ID 已作废时应抛普通异常，保留暂存以便恢复。

`revoke` 已接入持久化任务：断开立即停止业务访问，在线原生设备领取撤销任务，
回调成功后擦除保留凭据。回调必须幂等；网络中断与确认丢失后可能重试。界面区分
平台断开、服务方回执及用户自行撤销的确认。外部 CLI 原有 OAuth 授权仍可能
自行刷新；只有提供方支持转移唯一刷新管理权时才能迁移该授权，否则应创建独立
的 Wegent 授权。插件授权回调负责提供方支持的浏览器流程、state 和 PKCE S256。
DWS 等自行管理认证的 CLI 还需要受支持的专用迁移/执行适配，不能直接套用
密码模板。JavaScript/PowerShell 原生 SDK 尚未提供。

## 本机认证存储配置

已有 CLI 若通过环境变量选择认证目录，可在 `accountAuth` 中添加可选声明：

```json
{
  "localEnvironment": {
    "DWS_CONFIG_DIR": { "type": "directory" },
    "DWS_KEYCHAIN_DIR": { "type": "directory" },
    "DWS_DISABLE_KEYCHAIN": { "type": "enum", "values": ["1"] }
  }
}
```

变量名只允许大写字母、数字和下划线，最多 64 字符、16 项。`directory` 必须是
本机存在的绝对目录；枚举最多 16 个不同的公开固定值，每值最多 64 字符，仅包含
字母、数字、点、下划线和短横线。未设置或空值使用提供方原有默认行为；非法值
直接失败。不得用此字段传递密码、Token、秘密客户端配置或任意字符串。

`export_local`、`authorize`、`detach` 回调调用 `local_configuration()` 取得字典。
SDK 不会直接修改进程环境；适配第三方 CLI 时，由适配器明确映射需要的设置。
配置通过宿主限定的本机配置通道提供，总大小不超过 16 KiB，不上传后端，不写入
账号凭据。`run`、`refresh`、`revoke` 不接收源设备配置，避免云端依赖本机路径。
Go SDK 对应接口为 `LocalConfiguration()`。Wegent 仅处理统一声明和类型验证，
新增插件无需在设备逻辑中增加环境变量白名单。

## 给现有插件打包与升级 SDK

```bash
uv run --no-project python sdk/plugin-auth/tool.py vendor ../plugins/my-service
uv run --no-project python sdk/plugin-auth/tool.py vendor ../plugins/my-service --check
```

SDK 的唯一维护源位于本目录。修改此处、运行测试，再使用 `vendor` 更新插件。
`--check` 会逐字节比较源码、版本、文件列表和许可证；`vendor.json` 支持插件
仓库独立校验包内文件是否被修改，但它不是密码学签名，也不替代来源信任。
不要手工修改插件内的 SDK 副本，不要从插件跨目录导入 Wegent 开发仓库。
升级 SDK 后按插件仓库规则提升插件版本并发布；本次开发尚未发布软件包。

## 传输与错误边界

- 默认使用下述认证 loopback Socket；原生宿主也可通过 `WEGENT_PLUGIN_AUTH_FD`
  传递私有 FD（≥3）。凭据不走环境变量、命令参数或 stdout；拒绝普通文件和标准流。
- 帧为四字节大端长度 + UTF-8 JSON，完整 envelope 上限为 65536 字节。
  顶层字段严格为 `protocolVersion`（整数 1）、`connectorSlug`、`credentialType`、
  `credential`。拒绝重复 JSON key、非有限数值、截断及超限数据。
- `export` 将凭据写入管道，只在 stdout 返回账号元数据。`run` 读取并关闭管道，
  执行业务回调；SDK 不写任何认证存储。授权校验必须在宿主启动进程前完成。
- SDK 抑制认证回调的 Python 标准输出和错误输出，并隐藏捕获异常的内容；
  业务输出由插件负责，不能打印凭据、原始上游错误或通过子进程输出秘密。
- 宿主负责超时、进程清理、设备身份、插件来源、授权版本与操作权限。
  管道不隔离同一 OS 用户的恶意代码；Windows 复用原生 Executor 的进程树终止器，实机验证仍待执行。

## 验证

```bash
uv run --no-project python -m unittest discover -s sdk/plugin-auth/tests -v
```

测试使用合成凭据，包含真实子进程认证 Socket、ZIP 解包后独立运行、密码/API
Key/OAuth token 校验、异常脱敏、消息边界与 SDK 副本一致性。
`.github/workflows/plugin-auth-sdk.yml` 配置 Linux/macOS/Windows、Python 3.9/3.12 测试。
远端 CI 和真实云端认证闭环需要分别验证。

## 原生跨平台通道（SDK 0.4.0）

Executor 原生适配器执行器使用仅监听 `127.0.0.1` 的随机端口，通过
`WEGENT_PLUGIN_AUTH_PORT` 告知子进程地址。父进程用 CSPRNG 生成 32 字节的
一次性通道令牌，只经子进程 stdin 交接；SDK 连接后先提交令牌，验证通过
才传输凭据帧。stdin 不传输真实提供方凭据。端口变量不包含秘密。

SDK 负责选用显式指定的通道。PORT 与 FD 同时出现会失败，不会自动降级到
另一通道。原来的专用 FD 协议仍可用于明确配置的宿主；新的原生执行器使用
Socket，因此不依赖 Windows CRT 文件描述符继承。进程 stdin 此时由宿主
保留，业务命令不能再把 stdin 当作交互输入。

NativeAdapter 只接受已安装包中与后端授权相同的 connector/accountAuth 定义；
调用方必须从受管理的安装记录解析包目录，不能接受模型传入的任意路径。
原生读取及登记使用已有设备 Socket 的专用事件，Credential 不实现 Debug
或 Serialize。业务 stdout 有 1 MiB 上限，错误只返回固定代码，进程有期限。
Unix 超时/取消会终止专用进程组；Windows 复用 Executor 的进程树清理，原生验证仍待执行。

原生运行器、桌面迁移入口和云端 CLI 委托已有实现及真实子进程测试，
真实后端/桌面检查点已验证合成密码和 OAuth 授权、刷新、撤销链路。真实提供方
与 DWS 仍需分别验收，不能据此宣称所有插件均已完成云端免认证交付。

## 现有业务 CLI 接入

在读取本机认证之前调用 SDK；CLI 仍执行同一份业务代码，不在插件里实现网络凭据交换。

```python
from pathlib import Path
from wegent_plugin_auth import delegate_cloud_command

def main(argv):
    delegated = delegate_cloud_command(
        Path(__file__).resolve().parents[1], "my-service", argv,
        account_id=None,  # Pass a public account ID when more than one is granted.
    )
    if delegated is not None:
        return delegated
    return existing_local_main(argv)
```

Runner 将业务代理能力和设备模式注入任务环境，SDK 从受管理安装记录解析插件 ID。
云端业务只接受授权连接；失败不会降级到本机认证或触发云端登录。本机普通命令
不依赖此代理；显式传入 `account_id` 时，本机也可以使用已授权的账号连接。
工作目录随请求传递，正文文件与附件目录仍相对于原任务目录解析。

原生适配器调用公开 CLI 时，SDK 的作用域标记阻止循环委托，并在结束后恢复。
业务代理令牌只授权本机业务调用，不能读取凭据；提供方密码和 Token 不进入
此 HTTP API、环境变量或 stdout。业务输出允许包含业务数据，插件不能主动打印认证字段。

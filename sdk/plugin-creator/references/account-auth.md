---
sidebar_position: 1
title: Wework 插件认证接入
---

# Wework 插件认证接入

适用于插件自身管理的本机认证。已有平台托管的远程 Connector 继续复用平台连接。
本机登录入口由 `localAuth` 描述，跨设备账号能力由 `accountAuth` 描述；二者职责不同。
宿主在本机登录后后台同步账号凭据，并按设备权限为云端业务调用提供临时凭据。
插件不实现凭据上传 API，不增加同步按钮，也不让模型调用认证导出入口。

## 生成与修改

从此 skill 根目录运行，`<parent>` 必须是任务确定的源码父目录：

```bash
uv run --no-project python scripts/auth-sdk/tool.py scaffold my-service \
  --parent <parent> --credential-type password
```

类型可选 `password`、`bearer`、`oauth2`。工具随 Executor 分发，源码与模板来自同一份
Wegent 公共 SDK；不用下载另一份 SDK，也不需要访问 Wegent 开发仓库。

生成 `scripts/account-auth.py`、`scripts/auth_provider.py`、`scripts/cli.py` 和
`scripts/wegent_plugin_auth/`，并声明：

```json
{
  "connectors": [
    {
      "slug": "my-service",
      "authPolicy": "optional",
      "accountAuth": {
        "protocolVersion": 1,
        "credentialType": "password",
        "adapter": "scripts/account-auth.py"
      }
    }
  ]
}
```

该骨架默认拒绝导出和执行，不是已完成的插件。修改现有插件时，在临时目录生成骨架，
合并对应 Connector 的 `accountAuth`，保留已有 slug、`localAuth`、MCP 和其他 manifest 字段。
通过 `tool.py vendor <plugin-root>` 更新 SDK；不要手改 SDK 副本。

实现 `export_local()`（只读本机认证）、`account_id()`（稳定公开账号标识）、
`ALLOWED_COMMANDS`（业务命令白名单）、`execute()`（内存中使用凭据）。按需实现
`validate()`。不要把登录、登出、认证导出放入业务命令白名单。

已有业务 CLI 应在读取本机认证之前调用 `delegate_cloud_command()`；返回非 `None`
时传播退出码。本机普通命令继续原有实现；云端授权失败不得退回本机认证或发起云端登录。
MCP 服务若调用业务 CLI，应使用这一入口。长期驻留且自行读取凭据的 MCP 服务不能只加
manifest 就算完成适配，必须验证实际业务路径通过平台代理执行。

## 本机登录入口

保留已有原生 Connector 登录流程。新插件需要原生入口时，可声明 `localAuth`：

```json
{
  "kind": "local_qr",
  "health": ["python3", "scripts/login.py", "health"],
  "start": ["python3", "scripts/login.py", "start"],
  "poll": ["python3", "scripts/login.py", "poll"],
  "logout": ["python3", "scripts/login.py", "logout"],
  "statusField": "status",
  "okValues": ["ok"],
  "qrField": "qr_path"
}
```

这只是协议示例，不提供登录实现。按服务真实能力选择 `local_qr` 或 `browser_oauth`，
不要把密码/API Key 输入伪装成扫码。如果没有适合的原生登录机制，说明缺失的宿主能力。
命令使用包内相对路径；公共状态只包含状态码、二维码路径等必要元数据。

## OAuth 与特殊 CLI

OAuth 模板包含 `authorize`、`refresh`、`revoke` 回调，通过 `accountAuth.oauth2`
声明支持的操作；只声明已实现的操作。处理 state、PKCE S256、绝对时间 `expires_at`
和 Refresh Token 轮换。业务回调只拿 Access Token 等业务必要字段，刷新秘密放入
`provider_private`。不要在业务回调自行刷新或重试结果不确定的刷新。

已有 CLI 会自行刷新 OAuth 时，先确认能否转移唯一刷新权。支持时才使用
`exportMode: "exclusive"` 并实现可恢复、幂等的 `detach`；不支持时创建独立的 Wegent
授权。DWS 等自带原生认证的 CLI 需要其专用构建与迁移适配，不能直接套密码模板。
本 skill 的脚手架提供 Python SDK；不宣称已提供 JavaScript/PowerShell SDK。

自定义本机认证目录通过 `accountAuth.localEnvironment` 声明，在源设备回调中调用
`local_configuration()`。只允许目录和公开枚举，不存秘密，也不把本机路径上传后端。
完整回调、OAuth、通道与配置规范见 [SDK 协议](../scripts/auth-sdk/README.md)。

## 验收

- 结构：完整 manifest 通过 Wework 校验；SDK `vendor --check` 通过；解包后仍含入口、
  SDK、依赖及声明的原生产物。适配器不得从包外的 Wegent 源码导入模块。
- 提供方：用合成凭据覆盖允许/拒绝命令、退出码、日志脱敏；OAuth 覆盖过期、刷新和撤销。
  不把适配器注册为模型工具，不在 Skill 中要求模型读取本机凭据或执行导出。
- 本机：用户通过原生入口登录后，后台同步成功；重新登录、登出后连接状态符合预期。
- 云端：在无该服务本机凭据的设备上调用真实业务；未授权/断开时失败，不触发登录。

无法执行某一层时记录具体未验证项；不要把脚手架成功等同于云端可用。

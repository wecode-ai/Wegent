---
sidebar_position: 1
---

# Go 插件认证 SDK

版本 `0.3.0`，实现 `accountAuth` 草案 v1 的原生私有通道。提供方实现
`Provider` 的 `Export` / `Authorize` / `Refresh` / `Revoke` / `Allowed` / `Run`
回调，调用 `Serve` 即可；DWS companion 是首个接入实例。

SDK 负责一次性 nonce、仅回环 TCP、长度和身份校验、认证回调输出抑制、固定错误。
`Run` 的公开业务输出由插件负责，`Allowed` 必须拒绝认证管理、令牌覆盖与调试参数。
刷新回调返回完整 `Account`；与 Python SDK 的增量合并接口不同，Go 提供方必须
保留稳定账号字段与未轮换的 Refresh Token，后端还会校验账号未改变。

`Detach(ctx, migrationID, credential)` 是独占迁移的可选回调：只能在后端已持久化
暂存后由原生宿主调用，必须完成可恢复、幂等的源存储交接才返回 nil。
不要在 `Export` 内删除源凭据。声明 `exportMode: "exclusive"` 后，宿主会走
暂存→detach→激活流程；没有受支持的迁移接口时不要声明该能力。

源凭据轮换时，只有在提供方锁内持久化旧迁移 ID 的作废记录、阻止所有迟到操作
删除凭据后，才能返回 `ErrSourceChanged`。宿主随后取消旧暂存，用户可使用新 ID
迁移最新凭据。记录无法持久化或源状态不明时返回普通错误，保留可恢复暂存。

源存储有自定义目录或公开开关时，在 `accountAuth.localEnvironment` 声明
`directory` 或有限 `enum`，通过 `LocalConfiguration()` 读取宿主校验后的配置。
配置仅提供给 `Export`、`Authorize` 和 `Detach`，不会自动合并到进程环境；
`Run`、`Refresh` 和 `Revoke` 不接收源设备配置。不要把本机目录加入导出的凭据。
声明格式和边界见 [Python SDK](../plugin-auth/README.md)。

仅刷新、授权、撤销需要的额外材料放在 `provider_private` 对象内，后端不会向
业务回调下发该对象、Refresh Token、`client_secret` 或 `persistent_code`。
该库暂不提供公开 CLI 的 broker 委派接口，也不负责钥匙串、设备授权或提供方网络协议。

```bash
cd sdk/plugin-auth-go
go test -race ./...
```

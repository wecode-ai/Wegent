---
sidebar_position: 59
---

# 插件本机执行与设备注册解耦

本机安装、卸载、版本更新和完整对账使用账号 HTTP 与本机 IPC，不要求 Device 注册、设备号、Socket 在线或其他设备 ACK。仍需要登录和访问 Backend。本机对话的普通插件命令保留原本机认证路径；托管账号调用使用下面的 Native 插件授权通道。云设备及旧客户端仍走原有 Device／Socket 安全路由。

## 状态与职责

- `InstalledPlugin/default` 仍是账号期望状态的唯一来源，原安装、更新、卸载和包下载能力继续复用。
- 不新增表、迁移或 `plugin-local-sync` 命名空间记录；不保存独立操作、执行快照或回执账本。
- 原 `PluginSyncState/plugin-sync/account` 继续保存 generation 和设备水位。`spec.localIntentOrders` 保存每实例、每插件的顺序水位；`spec.localIntents` 每实例、每插件仅保留一个最新受理标记，包含 operation ID、请求摘要、顺序、安装 ID、动作及安装 revision，不包含完整插件副本或历史。
- 期望状态、最新受理标记与顺序水位在原账号 Redis 写锁和 revision CAS 下同事务提交。旧客户端的写入和 Socket generation 更新保留这些字段。
- Native journal 按 Backend 和账号隔离，原请求在 HTTP 之前原子落盘，不保存 token。实际文件、manifest 和运行时配置由统一安装器管理。HTTP 和 Socket 共享安装器、generation、tombstone、校验与发布保护。

## 核心流程

1. 能力探测：Rust `POST /api/plugins/local-sync`，`probeOnly=true`，要求 `protocolVersion=1`、`contractRevision=3`。服务端探测不写数据库。
2. Native 先保存 operation ID、intentOrder、动作、目标和 payload，再通过原 Python 写接口携带 `delivery_mode=local_pull_v1` 提交。
3. Backend 同事务保存账号期望状态和最新受理标记，返回匹配请求的受理头。相同标记及摘要重试不重新执行写操作。
4. Native 从同一 Rust 接口读取当前执行计划，通过本机 IPC 调用统一安装器；计划直接返回，不持久化，不使用 snapshot ID 或回执接口。
5. 本机实际执行成功即更新 journal 和界面，不等待云设备。单插件操作使用 delta；完整对账负责发现旧客户端变更及隐式删除。
6. 提交后继续复用原后台 Socket 分发，云设备上线使用原期望状态同步。缺少或无法解析可选来源设备号不阻止本机操作。自动更新复用原账号批量推进。

## pending、顺序与并发

网络超时、5xx、401、408、429、未知冲突、丢失或不匹配受理确认均保留原请求，不创建新 ID，不自动切回旧协议。重试使用原 ID、顺序、动作和 payload。

最新受理槽位被后续操作覆盖后，旧请求仍受持久化顺序水位约束。Backend 明确返回匹配 ID/顺序的 `409 INTENT_SUPERSEDED` 和 `X-Plugin-Operation-State: superseded` 时，Native 才将原请求转存 superseded 终态。已受理请求之后被旧接口、其他实例或自动更新改变安装 revision，也不能再次执行旧动作。普通业务拒绝只有在取得写锁、没有匹配受理标记且请求顺序高于已有实例水位时才返回 `rejected`；标记已压缩不能被当成从未受理的证明；已知受理请求不会因普通拒绝被清理。

完整对账独立恢复原 pending；恢复 HTTP 不持有前台执行锁或 journal 文件锁。结果写回时重读并合并 journal。快照 HTTP、合同或安装失败不取消恢复，恢复失败不阻止对账。自动更新与完整对账独立合并触发；实际包发布仍串行。账号切换阻止旧配置的排队请求和文件发布。

## 部署与验证

默认 `PLUGIN_LOCAL_SYNC_ENABLED=false`。全部 Python、Rust、网关和 Runtime 副本部署完成后才启用。未携带新模式的旧接口逻辑不变；旧客户端仍走原路径。合同 3 与原 PR 内的合同 2 不混用，不能把新查询参数被旧副本忽略视为受理成功。

关闭受理开关时保留当前 HTTP/IPC 恢复能力；已受理标记可重放，已有实例可继续对账，未知新操作不能受理。本机旧 journal 的 pending 原样保留，已删除协议的回执不再补报。

聚焦回归覆盖无 Device 安装/更新/卸载、最新标记容量、重复请求、摘要冲突、原子回滚、旧接口变更后迟到重试、标记压缩后防乱序、账号/实例隔离、恢复与对账互不阻塞。真实 HTTP/MySQL/Redis 测试及桌面 `plugin-write-coordination` checkpoint 接入现有 CI；本地执行情况以 PR 记录为准。尚无 1.0.0、1.1.0、1.1.1 实际发行制品的完整兼容验证。

## 本机对话中的托管账号调用

新增 Rust `POST /api/plugins/native-auth/exchange`。桌面主进程用原桌面 refresh token
及其绑定私钥签名的请求证明换取一小时以内的 `plugin_native` 会话；证明绑定此接口、
请求方法、时间和 refresh token，Redis 的短 TTL 标记拒绝证明重放。该会话只能访问
插件接口，不能作为共享用户、设备、任务或工作区 API 的凭据。私钥和会话不进入 renderer。
没有新接口的旧 Backend 返回 404 时保留原 Socket 通道；新 HTTP 请求失败不隐式改用 Socket。

Executor 复用现有 Broker、统一适配器及后台认证循环。Broker 随账号／Backend 切换取消；
同账号 access token 轮换保留业务端口。Native 会话绑定当前 Backend 和账号 token，迟到的
旧账号响应不会交给适配器。设备注册状态仍如实返回失败，不伪造在线状态；云设备授权
仍检查原 `deviceGrants` 和 Runtime 绑定。

复用 `ConnectorConnection`、`ConnectorMigration`、`ConnectorTransfer`、本机认证策略及
原账号写锁，不新增表、列或独立执行账本。现有 JSON 增加本机密钥授权 `localGrants`、
来源观察值 `nativeAuthSources`、待登录 generation 和 Native 刷新／撤销租约归属。
旧接口写凭证时保留适用的本机字段，认证定义变化或退出认证时撤销本机授权。
独占转移先持久化原 escrow，再由统一适配器确认本机 detach；丢失受理响应不得覆盖 escrow。
OAuth 刷新结果不确定时要求重新登录，不重复消费可能已旋转的 refresh token。

没有新增定时器：认证及撤销复用现有 15 秒循环，失败冷却和撤销退避保持原机制；
无已安装插件时自动导出直接结束。原凭证交换由 Socket 改为小型账号 HTTP 查询，
业务读取、状态查询及 prepare 不推进数据库 revision；会话续期复用桌面现有刷新定时器，
临时失败复用 30 秒重试。安装 pending 的原请求、顺序保护和完整对账调度不变。

真实 HTTP／MySQL／Redis 回归覆盖无 Device 会话、跨用户／密钥隔离、Python 密文格式、
刷新与撤销、独占 escrow 重放；现有 `plugin-account-auth-password` CI checkpoint 追加
真实 Backend 拒绝注册后本机对话执行及安装／更新／卸载，保留旧协议原测试断言。

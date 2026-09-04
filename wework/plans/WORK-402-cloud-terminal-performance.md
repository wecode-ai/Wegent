---
sidebar_position: 13
---

# WORK-402 云端终端性能优化方案

更新日期：2026-09-04

## 目标与边界

目标是降低云端终端交互延迟，避免大输出冻结 Renderer，并让临时断线后的输出
可恢复。实现遵守以下边界：

- 终端事件不访问 SQL。
- Redis 只访问 `terminal_session:{session_id}` 精确 key，禁止 `SCAN`、`KEYS`
  和模式遍历。
- 同一个 key 存储有效 session record 或 revoked tombstone。
- Redis 不在逐事件热路径中；本地授权每 5 秒最多按 session 精确重校验一次。
- 终端原始内容不进入通用 trace、span 或日志。
- PTY、回放、浏览器乱序和输入队列全部有界。
- 保留现有 Socket.IO 主链，不提前增加第二套二进制通道。

## 当前数据链路

```text
PTY reader
  -> Executor 3ms 微批、sequence、有界 replay
  -> Backend call ACK（确认 Backend 已接受）
  -> Browser room
  -> xterm.write callback
  -> Browser cumulative ACK
  -> Backend call ACK
  -> Executor 释放 replay、解除背压
```

关键代码位置：

| 环节                    | Wegent 代码                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| PTY reader              | `executor/src/local/pty.rs`                                        |
| sequence、replay、背压  | `executor/src/local/session.rs`                                    |
| Executor Socket.IO 转发 | `executor/src/local/backend.rs`                                    |
| Browser namespace       | `backend/app/api/ws/terminal_namespace.py`                         |
| Executor namespace      | `backend/app/api/ws/device_namespace.py`                           |
| session cache 与 Redis  | `backend/app/services/device/terminal_session_service.py`          |
| Backend 指标            | `backend/app/services/device/terminal_metrics.py`                  |
| Wework 终端             | `wework/src/components/layout/workspace-panels/RemoteTerminal.tsx` |
| Wework Socket client    | `wework/src/lib/remote-terminal-socket.ts`                         |
| 主题同步                | `wework/src/lib/xterm-theme.ts`                                    |
| terminal context        | `wework/src/lib/runtime-terminal-context.ts`                       |
| 本地负载入口            | `scripts/run-terminal-load.sh`                                     |

## 开源参考源码

参考固定到 commit。采用的是机制和不变量，不直接复制实现。

| 机制               | 项目与固定版本                                      | 代码位置                                                                                                                                                                                                                                           | 本方案采用方式                          |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 输出微批           | VS Code `85ce8ef0824ac5afb363e3fa3483ada007791785`  | [`terminalDataBuffering.ts`](https://github.com/microsoft/vscode/blob/85ce8ef0824ac5afb363e3fa3483ada007791785/src/vs/platform/terminal/common/terminalDataBuffering.ts)                                                                           | 短时间窗口和字节阈值合并                |
| PTY 高低水位       | VS Code `85ce8ef0824ac5afb363e3fa3483ada007791785`  | [`terminalProcess.ts`](https://github.com/microsoft/vscode/blob/85ce8ef0824ac5afb363e3fa3483ada007791785/src/vs/platform/terminal/node/terminalProcess.ts)                                                                                         | replay 高水位暂停、低水位恢复           |
| xterm 消费后 ACK   | VS Code `85ce8ef0824ac5afb363e3fa3483ada007791785`  | [`terminalInstance.ts`](https://github.com/microsoft/vscode/blob/85ce8ef0824ac5afb363e3fa3483ada007791785/src/vs/workbench/contrib/terminal/browser/terminalInstance.ts)                                                                           | `terminal.write` callback 后确认        |
| xterm 写入队列     | xterm.js `c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2` | [`WriteBuffer.ts`](https://github.com/xtermjs/xterm.js/blob/c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2/src/common/input/WriteBuffer.ts)                                                                                                              | callback 作为浏览器消费边界             |
| WebSocket 流控     | xterm.js 官方文档                                   | [Flow Control](https://xtermjs.org/docs/guides/flowcontrol/)                                                                                                                                                                                       | 应用层累计 ACK，而非只看 WebSocket 送达 |
| 事件驱动 PTY       | ttyd `2922cb89f518bae4d0fcf4d757a7419638fc71fc`     | [`pty.c`](https://github.com/tsl0922/ttyd/blob/2922cb89f518bae4d0fcf4d757a7419638fc71fc/src/pty.c)                                                                                                                                                 | reader 通知输出 pump，背压时停止消费    |
| pause/resume 协议  | ttyd `2922cb89f518bae4d0fcf4d757a7419638fc71fc`     | [`protocol.c`](https://github.com/tsl0922/ttyd/blob/2922cb89f518bae4d0fcf4d757a7419638fc71fc/src/protocol.c)                                                                                                                                       | 参考流控语义，不新增一套协议            |
| 稳定 session ID    | Coder `80de54591580c888e750e5f6847e8327ba23a50b`    | [`server.go`](https://github.com/coder/coder/blob/80de54591580c888e750e5f6847e8327ba23a50b/agent/reconnectingpty/server.go)                                                                                                                        | 同一 session 断线重新附着               |
| 有界回放           | Coder `80de54591580c888e750e5f6847e8327ba23a50b`    | [`buffered.go`](https://github.com/coder/coder/blob/80de54591580c888e750e5f6847e8327ba23a50b/agent/reconnectingpty/buffered.go)                                                                                                                    | 保存未 ACK 输出并设置硬上限             |
| 鉴权后转发         | Coder `80de54591580c888e750e5f6847e8327ba23a50b`    | [`proxy.go`](https://github.com/coder/coder/blob/80de54591580c888e750e5f6847e8327ba23a50b/coderd/workspaceapps/proxy.go)、[`token.go`](https://github.com/coder/coder/blob/80de54591580c888e750e5f6847e8327ba23a50b/coderd/workspaceapps/token.go) | attach 鉴权，字节路径不查数据库         |
| 控制面与数据面分离 | ShellHub `ef2e2056e0ae4e575b60b79d5fde0365799b2a1c` | [`revdial.go`](https://github.com/shellhub-io/shellhub/blob/ef2e2056e0ae4e575b60b79d5fde0365799b2a1c/pkg/revdial/revdial.go)                                                                                                                       | 稳定连接负责路由和生命周期              |

## 已实现方案

### Wework

- 删除每批 output 后重复应用主题；主题仅在主题变化或终端激活时同步。
- terminal context 关闭时直接退出，不再清洗和解析输出。
- output 按 sequence 排序、去重；只有 xterm callback 完成后才发送累计 ACK。
- 乱序缓存上限 256 批、1 Mi 字符；持续 gap 自动重新 attach，重试最长 10 秒。
- Socket 断开立即进入 detached 状态；重连 attach 合并为单个在途请求。
- 每个 Wework 终端实例使用独立 consumer ID；旧窗口收到 takeover 后的输出会忽略，
  旧 consumer 的 ACK、输入、resize 和 close 由 Executor 拒绝。
- 输入统一进入 64 Ki 字符有界队列，仅在 attach 成功后串行发送。
- attach 后同步当前 cols/rows；隐藏终端激活后再执行布局和 resize。

### Backend

- session ID 限制为 256 字符和 `[A-Za-z0-9:_-]+`，避免构造非预期 key。
- register 使用单 key `SET EX`；cache miss/重校验使用单 key `GET`。
- close/exit 使用 Lua 将同一 key 原子替换为 revoked tombstone 并发布失效事件。
- Executor socket 变化时使用单 key Lua 校验用户、设备和 TTL 后完成 rebind。
- 每个 Backend 进程复用一个 Redis pool；Pub/Sub 使用池中的独占连接。
- 不设置终端专属连接数上限，连接容量由共享 Redis 和部署配置统一管理。
- 本地 LRU cache 上限 8192；授权按 session ID 稳定错峰在 4～5 秒重校验，
  并发相同 key miss 使用 singleflight。
- 每个 Backend 进程一个 Pub/Sub listener；撤销跨实例失效。
- listener 断线时 fail closed；重连清空 cache 并推进 authorization epoch。
- attach 查询设备当前在线的 Executor SID，并只向该 SID 发起 call；成功后用单 key
  Lua 精确 rebind，避免同一 device room 内多个 Executor 同时响应。
- output/exit 进入 session 专属 Browser room，并携带 consumer ID；新 attach 在
  Executor 原子接管 consumer，旧 Browser 即使仍在 room 中也不能消费或控制会话。
- attach、output、ACK、close 和 exit 使用 Socket.IO call ACK 确认接收结果；
  close 只有在 Executor 成功关闭 PTY 后才持久撤销 session。
- input/resize 保持低开销 emit；所有事件校验已绑定授权，过期授权才精确重校验。
- 指标只记录事件、cache 和 store 操作，不记录 payload 内容或大小。

### Executor

- 每个 PTY 使用独立 reader 和 child watcher；shell 退出后先上报 exit，再清理同一
  process group 中仍持有 slave PTY 的后台进程，避免终端永久等待 EOF。
- reader 使用 64 个 8 KiB 槽位；输出 pump 由通知唤醒，取消固定 25ms 轮询。
- 相邻输出按 3ms 微批，每个 session 每轮最多读取 16 个 chunk。
- 每轮最多处理 32 个 session，并轮转起点；session 内串行、不同 session 最多 8 路
  并发转发，慢 ACK 不阻塞其他终端。
- 终端 relay 与设备 heartbeat 独立运行，慢 Backend/Browser ACK 不暂停心跳。
- UTF-8 跨 chunk 流式解码；非法或 EOF 截断字节转换为替换字符。
- output sequence 从 1 单调递增。
- replay 上限 512 KiB；384 KiB 暂停读取，降到 128 KiB 后恢复。
- output 在调用 Backend 前标记为在途，避免 Backend ACK 快于本地状态更新。
- Backend call 失败时回滚发送位置；重连后从 Executor ACK 位置重新发送。
- Browser ACK 只释放已连续消费的 replay；历史最高发送 sequence 独立保存，允许
  ACK 尚未到达时重连，但不允许 attach 到已无法回放的位置。
- 每次 attach 生成新的 consumer 所有权；旧 consumer 的 ACK 和控制事件无副作用。
- PTY 退出后等待 replay 清空，再发送 exit；过期 session 由 heartbeat 回收。

## 多 Backend 与 Redis 压力

多副本通过 Redis 精确 key 和 Pub/Sub 失效协作，不要求 Browser 与 Executor 落在
同一个 Backend 进程。

Redis 操作预算：

- SQL：终端流量始终为 0。
- cache 命中期间：单个事件 Redis 为 0。
- 持续活跃 session：每个处理该 session 的 Backend 进程每 4～5 秒最多 1 次精确
  `GET`；稳定 jitter 分散刷新，同 key 并发重校验合并为一次。
- 1000 个持续活跃 session 全落在一个 Backend 时，平均重校验约 222 GET/s。
- 8192 个持续活跃 session 全落在一个 Backend 时，平均重校验约 1820 GET/s。
- register：1 次 `SET`；首次 attach/reconnect：1 次 `GET`。
- close/exit：1 次单 key `EVAL`，脚本内 `SET` tombstone 和 `PUBLISH`。
- socket rebind：1 次单 key `EVAL`，脚本内 `GET/PTTL/SET/PUBLISH`。
- 每个 Backend 常驻 1 个 Pub/Sub 连接；普通命令按 Redis pool 复用。
- cache 超过 8192 后会发生精确 GET 增长，应通过 eviction/miss 指标观测。

Redis 中不会存终端输出，只存少量 session 路由元数据或 revoked tombstone。

Socket 预算：

- 有效输出经过 Executor -> Backend -> Browser，应用层总传输约为有效输出的 2 倍，
  不含 Socket.IO/WebSocket framing。
- 每个 output 有 Executor -> Backend 的 call ACK；Browser 累计 ACK 再跨两跳返回。
- 最坏消息操作量约为 `2 * output_events + 2 * browser_ack_events`。
- 3ms 微批降低交互延迟；高吞吐时每批最多约 128 KiB，减少消息数。

内存预算：

- Executor：replay 512 KiB + PTY reader 512 KiB；加微批、字符串和序列化临时副本，
  每个拥塞活跃终端按约 1–2 MiB 预算。
- Wework：乱序输出最多 1 Mi 字符，输入最多 64 Ki 字符，另计 xterm scrollback。
- Backend 不保存输出 replay，仅保存上限 8192 的 session 路由 cache。

## 本地压测

```bash
./scripts/run-terminal-load.sh quick
./scripts/run-terminal-load.sh baseline
./scripts/run-terminal-load.sh capacity
./scripts/run-terminal-load.sh over-capacity
```

默认 Backend 压测启动绑定 `127.0.0.1` 的临时隔离 Redis，结束后销毁；不会扫描、
清空或连接现有 Redis。若设置 `TERMINAL_LOAD_REDIS_URL`，只删除本轮已知的精确
session key。共享 Redis 的 `INFO` 计数包含其他客户端流量，只作观测，不作为本轮
成败判据。

Executor 压测复用生产 `LocalSessionHandler`，验证 sequence、ACK、consumer 替换后
的有序 replay、旧 consumer ACK 拒绝和高低水位背压，但使用内存 PTY，不包含真实
Socket.IO、网络和 Renderer，因此不能替代 Electron E2E 或生产环境压测。

本地压测不需要真实密码、用户 Token 或 API Key。`load-token` 仅为内存模型的固定
占位值，不发送到外部服务。

## 验收矩阵

提交前门禁：

```bash
cd backend
uv run pytest \
  tests/api/ws/test_terminal_namespace.py \
  tests/api/ws/test_device_capabilities_state.py \
  tests/services/device/test_terminal_session_service.py \
  tests/scripts/test_terminal_session_cache_load.py

cd ../executor
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings

cd ../
pnpm --filter wework test \
  RemoteTerminal.test.tsx \
  remote-terminal-socket.test.ts \
  runtime-terminal-context.test.ts
pnpm --filter wework typecheck
pnpm --filter wework e2e:desktop -- --cloud-only --segment core-task-flow

./scripts/run-terminal-load.sh baseline
./scripts/run-terminal-load.sh capacity
```

生产环境至少执行 30 分钟：

| 会话数 | 单会话输出 | ACK 延迟 | 目的                     |
| ------ | ---------- | -------- | ------------------------ |
| 100    | 10 KiB/s   | 0ms      | 基线                     |
| 500    | 10 KiB/s   | 50ms     | 常规并发                 |
| 1000   | 100 KiB/s  | 200ms    | 高吞吐                   |
| 3000   | 1 KiB/s    | 50ms     | 大量低频终端             |
| 8192   | 10 KiB/s   | 200ms    | 单 Backend cache 容量    |
| 9000   | 1 KiB/s    | 50ms     | eviction/miss 超容量行为 |
| 1000   | 100 KiB/s  | 1000ms   | 强制高低水位背压         |

每组覆盖随机断开 10% Browser、3 秒后重连，ACK 延迟/丢失，10 MiB burst，
五终端并行，主题切换、隐藏和重新激活。

验收标准：

- 隔离 Redis 的 `INFO commandstats` 中压测增量 `SCAN=0`、`KEYS=0`；共享 Redis
  通过代码审查和精确 key 操作计数验证，不使用服务端全局计数归因本轮流量。
- sequence gap、重复写入和静默丢失为 0。
- replay 不超过 512 KiB；384 KiB 暂停，128 KiB 或以下恢复。
- 30 分钟内存形成平台，不随输出总量线性增长。
- 同地域输入回显 P95 不高于 50ms；扣除网络 RTT 后链路 P95 不高于 20ms。
- 连续 `yes` 后 Ctrl-C 停止 P95 不高于 200ms。
- 断网 3 秒后，连接恢复 1 秒内重新 attach 并开始补发。
- 10 MiB burst 后 Renderer 仍可交互，结束标记和后续命令正常显示。

## 观测指标

Backend：

- `terminal_ws_events_total{source,event}`
- `terminal_session_cache_requests_total{result}`
- `terminal_session_cache_evictions_total`
- `terminal_session_store_operations_total{operation,result}`
- `terminal_session_store_duration_seconds{operation}`

Executor `/metrics`：

- `terminal_output_batches_total`
- `terminal_output_bytes_total`
- `terminal_replayed_batches_total`
- `terminal_replay_bytes`
- `terminal_ack_lag_bytes`
- `terminal_backpressured_sessions`

Wework 性能诊断：

- `remote-terminal-write`：sequence、字符数和 xterm callback 耗时。
- `remote-terminal-replay-request`：最后消费 sequence、乱序缓存量和重试次数。

所有指标均不记录终端原始内容。正式压测使用应用指标和 Redis
`INFO commandstats`，禁止使用 `SCAN`、`KEYS` 或 `MONITOR` 做观测。

## 交付状态

实现和本地验收已完成：聚焦测试、静态检查、三档本地负载和真实打包 Electron
云端终端流程均通过。生产 30 分钟矩阵仍是部署环境上线门禁，不以本机内存压测
替代。

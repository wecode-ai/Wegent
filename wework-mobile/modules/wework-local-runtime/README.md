---
sidebar_position: 1
---

# 手机本地执行原生层

此模块仅适配平台，不重新定义任务协议。RPC 使用 PC 执行器的
`{type:"request", id, method, params}` / `response` / `event` JSONL；请求和事件在
原生层处理，JS 暂停不会丢掉正在等待的 RPC。账号、任务内容、模型配置属于各账号的
执行器数据库。Android 和未包含运行资源的安装包明确报告 `supported: false`，云设备功能保持可用。

```mermaid
flowchart TD
  JS[Mobile services: accountScope + existing Runtime RPC] --> N[Expo native supervisor]
  N --> Q[Dedicated kernel owner thread: virtual PID 1]
  Q --> F[Active account fakefs root]
  Q --> E[Joinable executor child: independent stdin / stdout / stderr pipes]
  E --> C[Codex app-server and guest children]
  E --> J[Account-protected bounded event journal]
  J --> JS
  N --> B[UIKit short background grace: generation + task revision lease]
  B -->|System expiration| X[Cancel actual task]
  C --> T[Native thread completion counter]
  T --> G[Stop gate: zero live guest threads + reap]
  G -->|Only then| F
```

PC 依据：`wework/electron/src/host/system-sleep-controller.ts` 及对应测试的
`response.created/completed/failed/incomplete`；`wework/src/api/backend/backendServices.ts`
与 `wework/src/e2e/desktop-cloud-environment.test.ts` 的设备和 Home 所有权；
`executor/src/local/app_ipc.rs` 的 wire 协议和 `runtime_work/handler/lifecycle.rs` 的
`runtime.turn.updated` 终态；
`packages/chat-core/src/runtime-task-api-types.ts` 的执行状态。
本次用户明确要求手机本地 executor，因此本模块使用 PC 本地执行器协议，和云设备路由隔离。

## 生命周期和隔离

- 每个 `accountScope` 使用独立完整 fakefs root（包括 SQLite 元数据）。设备 ID 为
  `mobile-local:<installation UUID>:<scope SHA256>`。每个原生请求都重新验证 scope。
- PID 1 不执行 guest 程序，也不调用上游会结束宿主的 `do_exit(init)`。
  普通退出先等待宿主线程真正完成，再 join 和 reap。停止只发送 guest 信号。
  线程未结束会返回明确错误，禁止换根；不会伪报停止，也不杀宿主 App。
- 文件导入通过 owner 线程的 `generic_open` 写入 guest，更新 fakefs 元数据。
  不直接向宿主 `data/` 复制文件。账号切换首先清空旧事件视图。
- 账号目录使用 `completeUntilFirstUserAuthentication` 文件保护；请求和 stderr 不持久化。
  事件回放仅在内存保留，最多 8 MiB 序列化数据 / 2048 条，按最早事件淘汰；完整历史由 executor transcript 恢复。
- 「设置 → 诊断 → 诊断日志」默认关闭，覆盖 App、运行层与内核宿主日志输出；不关闭内存安全检查，内核有界环形缓冲及系统、Codex 错误日志仍可保留。启动时清理旧诊断文件，并在 guest 进程全部退出后通过 fakefs 回收程序生成的模型目录；不会清理项目或会话。
- 前台任务使用 UIKit `UIApplication.beginBackgroundTask` 申请切到后台后的短时宽限。
  不使用 `BGContinuedProcessingTask`，不把未知总量的输出字节伪装为完成进度。
  系统决定是否授予时间以及何时到期；到期取消实际任务并报告 `expired`，不承诺后台完成。
  前台任务没有人为的后台倒计时；回到前台后按真实任务状态处理。
  终止事件后还会查询 `runtime.tasks.get`，自动续跑处于 active phase 时不提前结束 lease。
  Lease 按运行 generation 和每次前台提交的 task revision 隔离；旧轮状态查询不能结束新轮
  Lease。状态未知时保留任务并报告错误，不伪造完成。
- 锁屏会暂停内存采样定时器。内存准入发现样本超过 2 秒时，通过同步宿主查询获取真实
  内存状态，再执行原有压力、余量和滞回规则；查询失败、无效读数和真实内存不足仍拒绝
  分配。同步查询不打印内核日志，也不获取 guest 锁，避免在分配或 syslog 路径内重入。
- iOS 回收 TCP 监听端点时，在宿主关闭事件进入 guest reactor 或执行 accept 前，按记录的
  地址、端口、backlog、选项和标志重建端点。保留 guest 文件身份和宿主 fd 编号，通过
  完整查询 `POLLIN | POLLOUT | POLLPRI` 并在同一次采样中判断恢复；iOS 的只读查询可能
  隐藏失效监听器的 HUP，不能作为独立预检查。通过 descriptor generation 重新注册各
  poll/epoll 后端，清理旧边沿状态并保留 ONESHOT 禁用
  状态。主动成功 shutdown 不恢复，恢复失败保留真实错误，不无限重试或重启环境。
- 解锁回前台时，先等待尚未结束的停止过程，再确保本机执行环境已启动并恢复活动会话
  日志。恢复不重发用户消息，也不自动刷新项目或会话列表。主动停止和环境切换会撤销
  原环境的运行意图，等待中的启动可取消，旧环境不能在切换后重新启动。
- 使用 `jit=true` / `jit_emit=false`，运行预编译解释器 gadgets；不申请 JIT entitlement，
  不包含 AOT 镜像、Minis offload 或 FFmpeg。Linux namespaces/seccomp 不可用，
  受限 Linux 沙盒请求明确拒绝，不能静默升级权限。

## 已安装环境升级

程序更新沿用 PC 的组件校验、停止后准备、持久数据保留原则，参考
`wework/electron/src/runtime/component-update-manager.ts`、`release-after-stop-target.ts`
及其对应测试。Mobile 的 fakefs 是平台适配边界；不改变 executor RPC、账号或项目所有权。

```mermaid
flowchart TD
  S[Supervisor stopped / no process] --> V[Read delivered manifest and installed image record]
  V --> N{Guest root exists?}
  N -->|No| F[Verify archive / extract / verify executor / publish fresh guest]
  N -->|Yes| B[Require identical base image and a recognized installed executor]
  B --> H{Executor hash matches target?}
  H -->|No| P[Verify archive and staged executor]
  P --> O[Kernel owner: require zero guest threads / mount existing root]
  O --> R[Write app-owned temporary executable / fsync / guest rename]
  R --> C[Verify installed executor / atomically commit image record]
  H -->|Yes| C
  C --> E[Launch delivered executor in the same guest root]
  F --> E
```

`runtime-version` 从旧的归档哈希升级为一个原子 JSON 记录，包含归档、基础系统和 executor
哈希。已分发的两个旧归档有显式的不可变身份记录；它们包含相同的 1,286 个成员，除
`opt/wegent-executor` 外的路径、内容和权限相同。不会把未知版本当作兼容环境。
基础系统未变化时，仅通过 guest 文件 API 替换 `/opt/wegent-executor`，不移动、合并或
重建用户环境，不修改项目、会话、模型配置、Codex 凭据或 fakefs 数据库结构。
升级要求所有 guest 线程退出；程序替换后、版本记录提交前中断，下一次启动可校验并完成。
基础系统不兼容、程序被用户修改、符号链接或完整性错误均隔离在本机启动，保留数据。
此流程不宣称支持任意基础 Linux 系统升级。

`RuntimeImageInstallerTests.swift` 覆盖新装、原地升级、数据保留、替换前后中断恢复、
旧哈希记录、损坏归档/程序、未知版本及符号链接。可使用
`scripts/test-local-runtime-upgrade.py` 指定旧版和新版资源、锁定 iSH 源码及 macOS ARM64
静态库，验证实际 fakefs 迁移、字节级用户数据保留、executor.ready、health 和重启。
该集成验证使用临时合成数据，不访问模型或真实凭据，也不代替 TestFlight 真机验收。

GitHub CI 的 `Wework Mobile Native Upgrade` 使用两个固定工具链构建的静态 ARM64
协议探针，执行同一个 Swift/C 测试。它检查实际 iSH/fakefs 的原地替换、版本记录、用户
数据保留和重启。验证旧版本发布包时，仍给 Python 测试脚本传入对应的包内资源。

## 构建

先通过 `scripts/prepare-ish-source.py` 准备锁定源代码。所有大文件和构建目录放在仓库外。
`wework-mobile/scripts/build-local-runtime-ios.py` 接收明确的 clean rootfs 和 Linux ARM64
executor 输入，检查 rootfs SHA256、固定 iSH revision 和完整补丁，构建 iPhoneOS ARM64 库，
封装官方 fakefs 导入器，并生成带校验和的资源 manifest。

```sh
uv run --no-project wework-mobile/scripts/build-local-runtime-ios.py \
  --source /external/prepared-ish \
  --rootfs /external/clean-rootfs.tar.gz --rootfs-sha256 <verified-sha256> \
  --executor /external/wegent-executor --output /external/ios-runtime --link-module
cd wework-mobile/ios
pod install
```

本地模块在 `expo-module.config.json` 显式声明根目录的 `apple.podspecPath`。
仅被 CocoaPods/RN 链接不代表已向 Expo 注册；生成的 `ExpoModulesProvider.swift`
必须包含模块 import 和 `WeworkLocalRuntimeModule.self`。完成真机 Release 构建后，
安装前执行下面的产物门禁，检查生成 provider、实际二进制注册、真机 bridge、签名、
rootfs、executor、源码锁、补丁和许可证的校验和。它不能代替正常 App 内的设置/启动验证。

```sh
uv run --no-project wework-mobile/scripts/verify-local-runtime-ios.py \
  --app /external/DerivedData/Build/Products/Release-iphoneos/WeWork.app
```

`vendor/` 是忽略提交的真实目录，内部逐文件链接到仓库外的构建产物，确保 CocoaPods
可以完整枚举库和资源。不要把整个 `vendor/` 替换成目录符号链接。
不提交库、rootfs、截图或构建日志。
构建器依赖 Xcode、uv 和 Zig 的 LLD；Meson/Ninja 版本在脚本中固定。
运行时不下载或执行原生插件。第三方许可证和源代码锁位于 `native/`；随安装包分发
iSH 的 GPL 许可证、iOS 附加条款和对应源代码信息。原生桥接源码遵循仓库 Apache-2.0 许可证。

## 验证边界

在 macOS 上运行 `uv run --no-project wework-mobile/scripts/test-local-runtime-swift.py`，
使用 `swiftc -warnings-as-errors` 验证事件隔离、任务 lease 顺序和真实 Darwin 管道增量读取。
测试编译产物仅位于临时目录，完成后自动清理。管道测试必须在写端仍保持打开时收到短消息，
不能依赖写端关闭或攒够固定字节数才收到 executor ready/流式输出。

`tests/RuntimeEventJournalTests.swift` 覆盖切账号和启动失败窗口的事件隔离。
内核回归见 `native/tests/` 与 `scripts/test-ish-runtime.py`。
`regress_memory_resume.c` 覆盖暂停采样后的同步恢复、真实压力和滞回、无效宿主读数、
超额申请及并发准入，并验证分配路径不写内核日志。完整 runner 的宿主部分包含此测试。
`regress_listener_recovery.c` 按真机的查询掩码差异注入 HUP，覆盖 IPv4/IPv6、多次回收、多个 poll、dup、
ONESHOT、端口/选项/标志保留、真实连接和恢复失败。成功 shutdown 的禁用恢复场景使用
mock，因为 Darwin 对正常监听端点的 shutdown 返回 ENOTCONN；此断言不代表真机行为。
宿主测试不替代实际 iPhone 锁屏后的 RPC 和流式输出验收。
`regress_poll_waiters.c` 验证真实并发修改 poll 集合时的等待线程生命周期。注册和注销必须
归属于同一次阻塞调用，不能分别按变化前后的 fd 集合计数，避免 task 释放后仍留在恢复队列。
`regress_ldpsw.c/.S` 使用真实 ARM64 硬件校准的向量，覆盖有符号双字装载、寻址、
写回和跨页访问。上游 LDPSW 的零扩展错误会破坏 OpenSSL X25519 公钥计算并导致
HTTPS 握手失败；补丁修正指令语义，不修改密码算法或关闭证书验证。

`regress_simd_lane.c/.S` 与 `regress_simd_lane_cases.inc` 使用原始 ARM64 指令编码，
覆盖 560 项 LD1–LD4 / ST1–ST4 lane、奇偶半字、寄存器环绕、未改动 lane 保留、
非写回与立即数/寄存器后索引写回，以及保留编码的 SIGILL 行为；B/S/D 作为对照。
全部向量已在原生 Apple ARM64 硬件校准。上游把半字 lane 的 `size[1]` 误取为
`size[0]`，会破坏 ML-KEM 的消息多项式加法，使默认 X25519MLKEM768 TLS 握手失败。
补丁修复两种寻址分支的指令解码，保留默认密码算法和证书验证。
这些原生回归由本地 runner 执行；当前 GitHub CI 尚未调用该 runner。

`regress_mount_boundary.c` 验证 guest 无法通过 mount/umount 暴露宿主目录或修改跨环境共享的
挂载表。挂载操作只由原生宿主管理；普通 guest 文件读写、宿主建立的 proc/devpts 挂载保持可用。
App 沙盒仍是最外层边界，不能把 guest 的完整访问权限当作工作区之间或凭据之间的隔离。

`regress_socket_timeout.c` 验证 ARM64 的 `SO_RCVTIMEO` / `SO_SNDTIMEO` OLD（20/21）
和 NEW（66/67）选项。补丁显式转换 Linux 的两个 64 位字段与 Darwin 的 `timeval`，
只读写 ABI 结构所需字节；超长长度不触碰后续保护页，短长度和非法微秒明确报错。
接收轮询按单次系统调用保持超时预算，正的微秒超时向上取整到毫秒，不再变成无限等待；
`{0,0}` 仍表示无限等待。原生回归覆盖真实收发超时、`recvmsg` / `sendmsg`、
`read` / `write`、dup 共享选项及清零后等待延迟数据。

```mermaid
flowchart LR
  G[Guest setsockopt / getsockopt] --> Q{Timeout option?}
  Q -->|OLD / NEW| A[Fixed-size signed Linux timeval]
  A --> V[Length / microseconds / range validation]
  V --> D[Explicit Darwin timeval conversion]
  D --> H[Host socket]
  Q -->|Other option| E[Existing option path]
  R[Guest recvfrom / recvmsg] --> P[One elapsed-time budget per call]
  P --> W[Bounded poll with ceil milliseconds]
  W --> H
```

这是 Codex 所需的非负超时兼容修复，不是完整 Linux socket 一致性实现。
Linux 的负秒数代表立即超时，但现有 Darwin 阻塞架构无法表达此状态；该输入明确返回
`EDOM`，不伪装成成功或一微秒超时。超过 `INT64_MAX / 1000 - 1` 秒明确返回
`EOVERFLOW`，避免换算溢出；不模拟 Linux 的超大值饱和及内核 tick 舍入。
此验证不代表 iPhone 浏览器 OAuth 或完整产品登录已经通过。
外部协议验证应至少覆盖：真实 executor.ready/health、两账号独立文件导入、正常退出、
所有 guest 线程归零、再次启动、宿主标准 IO 不变。静态链接通过不等于真机运行通过。
iOS 27.3 真机已通过真实 executor health、Codex config/read、停止后重启，以及直接官方
Codex 文件写入、Git 暂存/diff 和真实输出通知；这不是产品任务到模型的完整验证。
已淘汰的 Continued Processing 探针使用未知总量的 Progress，系统 dasd 明确记录其
fraction 为 0 并判为 stalled，一次测试进入后台约 20 秒后过期。这是改用 UIKit 短时宽限的
依据，不能当作 UIKit 固定时限。当前支持前台执行、后台尽力，未知长度模型任务不保证后台完成。
新 UIKit 宽限已在真机后台触发到期回调并取消真实 Codex 命令（exit 137、后续文件未写入），
随后停止/重启健康检查通过。独立纯前台探针持续 45.088 秒，严格记录
`backgroundTransitions=0`、exit 0，真实文件/Git 操作正常且未被误取消。
真实模型、产品任务流式和产品取消全流程不能沿用上述原生探针结论。
锁屏任务仍未验证。已安装环境的程序升级边界见上文；基础 Linux 系统升级仍需独立迁移方案。

# Native on-device runtime

The module preserves the PC executor JSONL protocol and account ownership. A dedicated
native PID 1 thread owns guest operations; executor and Codex run as children with private
host pipes. Each account has an independent fakefs root. Root switching requires all guest
threads to finish and be reaped. Failed cleanup is visible and never shuts down the host app.

Build with the command above using a verified clean rootfs and a Linux ARM64 executor.
The native LDPSW regression uses vectors calibrated on real ARM64 hardware. The compatibility
patch fixes signed pair-load semantics that otherwise corrupt OpenSSL X25519 public keys;
it does not alter cryptographic algorithms or disable certificate verification.
The socket timeout regression covers ARM64 OLD (20/21) and NEW (66/67) options with explicit
Linux/Darwin timeval conversion, bounded memory accesses, real send/receive deadlines,
sub-millisecond waits, shared options across dup, and resetting to an infinite wait.
Receive retries keep one elapsed-time budget per syscall. This supports the nonnegative
timeouts used by Codex; it is not full Linux socket conformance. Negative seconds return
`EDOM` because the existing Darwin blocking architecture cannot represent Linux's immediate
timeout state. Values above `INT64_MAX / 1000 - 1` seconds return `EOVERFLOW`; Linux's huge-value
saturation and kernel-tick rounding are not emulated. No one-microsecond substitution or
false success is used. These probes do not establish that iPhone browser OAuth succeeds.
The explicit root-level `apple.podspecPath` is required for Expo registration, independently
of CocoaPods linking. Run `verify-local-runtime-ios.py` against the signed, unstripped
Release iPhone app before installation. It verifies generated and compiled Expo registration,
device support, signing, and packaged resource integrity. Starting the runtime through the
normal app on a real phone remains a separate required verification.
Run `test-local-runtime-swift.py` on macOS for event isolation, lease ordering, and
real Darwin pipe regression tests. Short ready/streaming messages must arrive while
the writer remains open. Test executables are created in a temporary directory and removed.
The native runner also covers 560 raw-encoding SIMD lane assertions, calibrated on Apple ARM64:
LD1–LD4/ST1–ST4, odd/even halfwords, preserved lanes, register wrap, post-index writeback,
reserved encodings, and B/S/D controls. The halfword decoder must read `size[1]`, not `size[0]`;
the incorrect lane corrupts ML-KEM message addition and default X25519MLKEM768 TLS handshakes.
The fix preserves default cryptography and certificate verification. This native runner is
currently executed locally and is not invoked by GitHub CI.
The mount-boundary regression rejects guest mount/umount syscalls, including read-only host
mounts and shared proc/tmpfs/devpts changes. Only the native host owns mounts; ordinary guest
file I/O and host-created mounts remain available. Full guest access does not isolate one
workspace or its credentials from other files in the same guest environment.
Artifacts stay outside Git. Missing artifacts explicitly disable local execution while the
app remains available. UIKit `beginBackgroundTask` provides only a system-controlled short
background grace period. Expiration cancels the actual task and is reported explicitly;
foreground execution is not subject to an artificial background deadline. Generation and task
revision tokens prevent stale releases from canceling newer work.

The retired Continued Processing probe expired after system logs reported stalled, zero-fraction
progress for unknown-length output. Its observed 20 seconds is not a UIKit allowance. The current
implementation does not use that API or fabricated progress. Executor health/config/restart and
direct Codex file/Git/output checks passed on iPhone. The actual UIKit implementation also
expired and canceled a real Codex command while backgrounded (exit 137, no subsequent file
write), then passed native shutdown/restart checks. A separate foreground probe completed
after 45.088 seconds with `backgroundTransitions=0`, exit 0, and real file/Git operations,
without premature cancellation. Model execution, product task streaming/cancellation, and
lock-screen behavior still need their own evidence.

Installed images now store archive, base-system and executor hashes in one atomic record.
The recognized legacy archives share the same base and differ only in the executor.
After all guest threads stop, the host verifies the delivered payload and replaces only
`/opt/wegent-executor` through the guest filesystem, preserving the existing root and all
user data. An interrupted replacement is completed idempotently on the next start. Unknown
images, changed base systems, modified executors and symlink conflicts fail visibly without
deleting data. This does not implement arbitrary Linux base-image upgrades. The native unit
and real fakefs integration runners above cover the supported upgrade and recovery paths;
TestFlight device acceptance remains separate.

The `Wework Mobile Native Upgrade` CI job runs the same Swift/C integration using two
static ARM64 protocol probes built with a pinned toolchain. It checks in-place replacement,
the image record, user data preservation, and restart through real iSH/fakefs. To verify
specific delivered versions, pass their packaged resources to the Python integration runner.

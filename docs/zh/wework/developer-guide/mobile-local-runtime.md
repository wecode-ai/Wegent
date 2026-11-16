---
sidebar_position: 42
---

# 手机本地执行器

手机本地执行复用 PC Wework 的本地执行器、Codex app-server 和 Runtime RPC。
手机不注册一个虚拟云设备，也不把本地任务转交远端机器。当前嵌入实现面向
ARM64 iPhone；Android 需要独立的原生执行后端，不能将 iOS 验证结果当作 Android 支持证据。
模型请求仍由 Codex 按用户选择的 provider 和模型配置发出。

## 本机优先与可选后端

App 启动即进入现有任务列表，不以 Backend 登录作为入口条件。包含原生组件时自动准备
本机执行；可在“设置 → 本机执行”查看状态和重试。未登录 Backend 时隐藏“全部 / 这台手机”
设备筛选，新会话默认在手机上执行。已有会话保持原来的执行设备，新聊天页面保持现有布局。

“设置 → 模型与账号”提供官方 OpenAI 浏览器登录、显式设备码登录和自定义 Responses 模型。
自定义模型的 API Base URL、模型 ID、API Key 保存在本机安全存储；运行时配置和真实工具调用
连接测试复用 PC 实现，仅支持 Responses 协议。不会读取桌面 Codex 登录文件。

“设置 → 登录 Wegent”中配置 Backend 地址并完成现有授权后，才启用后端模型和授权云设备，
同时显示设备筛选。后端模型也可在手机执行；模型服务的位置与执行设备分开。

本机可用状态直接来自当前手机环境的原生 supervisor，独立于 Backend 设备请求；云端响应
和缓存恢复不能覆盖最新的本机状态。停止本机后，新建会话不能继续选择该设备。
设备合并和响应排序参照 PC `hybridServices.ts` 与 `useWorkbenchDataRefresh.ts`。

## 数据和进程所有权

```mermaid
flowchart TD
    PC[PC 本地执行语义和测试] --> Shared[chat-core 共享模型 / 执行配置 / 引用]
    Shared --> Mobile[Mobile 界面与 Runtime API]
    Phone[持久手机身份 / 旧环境继承] --> Scope[本机环境 scope]
    Account[可选 Backend 地址和账号] --> Cloud[隔离的云设备 / 模型 / 缓存]
    Mobile --> Cloud
    Scope --> Native[原生 supervisor]
    Mobile -->|私有 stdio RPC| Native
    Native --> Guest[iSH ARM64 / 无运行时 JIT]
    Guest --> Executor[同一个 Rust wegent-executor]
    Executor --> Codex[官方 Codex app-server]
    Scope --> Store[独立 fakefs / 项目 / SQLite / Codex 登录]
    Guest --> Store
    Native -->|原生事件 journal| Mobile
    Native --> Background[UIKit 短时后台宽限]
    Background -->|系统到期| Cancel[取消实际任务并报告过期]
```

- PC 对照入口是 `wework/electron/src/runtime/managed-executor-runtime.ts`、
  `runtime-supervisor.ts` 及 `runtime-supervisor.process-group.test.ts`。
  设备、工作区、任务和请求参数继续使用现有 executor 协议。
- 模型选择和执行权限来自 `packages/chat-core/src/local-runtime-model.ts`、
  `local-runtime-execution.ts`；编辑器引用来自 `runtime-composer-references.ts`。
- 手机文件系统、executor 数据目录、Codex 登录和本机模型属于持久手机身份。
  Backend 登录、退出或换账号不会切换本机根目录或停止本机任务。浏览器和设备码登录使用官方 app-server 协议，完成通知需要同时匹配
  登录 ID 和进程 generation；旧进程的登录结果不能覆盖新进程状态。
- transcript 持久化由 executor 负责。原生事件 journal 只补偿 JS 暂停期间的通知，
  不替代任务历史，也不能跨本机环境回放。
- 升级时只继承原环境，不移动、删除或合并旧根；未确定身份且发现多个旧环境时，在
  “设置 → 本机执行”显式选择。原生发现接口只读合法根目录元数据，不读取认证和聊天内容。
- 云端 HTTP、Socket.IO、设备缓存和文件预览按 Backend 地址与用户隔离。账号变化撤销旧请求、
  连接和远端文件缓存，保留本机预览与阅读位置。缓存恢复完成前不写入该 scope，防止空状态覆盖离线数据。

## 停止和显式切换本机环境

退出 Wegent 只撤销云连接。下列进程排空流程仅用于停止本机运行时，或在“设置 → 本机执行”
明确确认切换保留的本机环境；后端账号变化不触发此流程。

```mermaid
sequenceDiagram
    participant UI as Mobile
    participant N as Native supervisor
    participant G as Guest threads
    participant F as Mounted fakefs
    UI->>N: 停止当前本机环境
    N->>G: 关闭 IPC / guest SIGTERM
    opt 仍有活线程
        N->>G: guest SIGKILL
    end
    G->>G: 每个线程自己释放 mm / files / fs
    G-->>N: 最后线程退出，leader 可 wait
    N->>N: native count = 0；join；reap
    alt 全部清理完成
        N->>F: 卸载旧环境，挂载所选环境
    else 超时或清理失败
        N-->>UI: 明确失败，保留旧环境边界
    end
```

不能把“主进程退出”当作“所有子进程和宿主线程都结束”。兼容补丁删除了上游
`do_exit_group` 的超时强制移除活线程、延迟释放和伪造退出逻辑。活线程继续留在进程组；
只有最后一个线程完成自己的资源释放后，leader 才能成为可回收 zombie。
线程退出前清除 TLS `current`，避免父进程回收 task 后，pthread cleanup 再访问它。

原生入口在创建 pthread 前计数，创建失败回滚计数，在最外层 cleanup 最后减计数。
未归零时禁止切换挂载。停止超时必须可见，不能改写成成功，也不能调用宿主 `_exit()`
或用宿主信号杀掉整个 App。启动、解压、登录和停止错误只使本机能力不可用，远端功能仍应可打开。

## 执行权限边界

本机模式的文件范围由 App 沙箱和当前本机环境挂载决定。它不提供完整 Linux 内核的
namespace、seccomp 或 Landlock 隔离。

挂载表由原生宿主管理。guest 的 `mount` / `umount` 一律返回 `EPERM`，防止通过
`real` 文件系统挂载宿主路径，或留下跨环境的共享挂载；宿主的 fakefs、proc 和 devpts
初始化不受影响。明确指向手机的附件在环境未就绪或不匹配时必须失败，不能改走 Backend 上传。

同一本机环境中的任务不具有工作区级安全隔离。完整访问能够读取该环境其他项目和
Codex 认证文件；API Key 的原始配置保存在 Keychain，但执行时仍需交给 guest 中的运行时。
因此不能将不可信仓库脚本当作受限沙盒任务运行。模拟器与 App 共用宿主进程，原生崩溃或
极端内存压力仍可能终止整个 App；内存监控不等于进程级故障隔离，也不提供磁盘或 CPU 配额。

固定版本的官方 Codex `0.167.0` 可在此环境中运行；其受限 Linux sandbox 不能工作：

- `readOnly` 和 `workspaceWrite` 命令返回失败，不能自动转换成更高权限。
- 官方附带的 bubblewrap `--version` 可以运行；最小隔离命令
  `bwrap --ro-bind / / --unshare-user --unshare-pid -- /bin/true` 实测失败于
  `prctl(PR_SET_NO_NEW_PRIVS)`，返回 `EINVAL`。
- 固定 iSH 源码没有对应的完整 namespace / seccomp 实现，`clone` 的允许标志也不包含
  namespace 创建标志。将这些调用伪实现为成功会造成错误的安全保证。
- 命令执行验证使用显式 `dangerFullAccess`。产品必须让用户明确选择与此能力相符的权限，
  不能声称只读或工作区隔离已经生效。

上游依据：
[Linux PR_SET_PDEATHSIG](https://man7.org/linux/man-pages/man2/PR_SET_PDEATHSIG.2const.html)、
[PR_GET_PDEATHSIG](https://man7.org/linux/man-pages/man2/PR_GET_PDEATHSIG.2const.html)、
[固定 iSH 源码](https://github.com/OpenMinis/ish-arm64/tree/0fd17a135e78b7a0cf08a4f5831217bbb76ed22f)。

## 固定源码与构建

`wework-mobile/modules/wework-local-runtime/native/ish-source-lock.json` 锁定上游 revision、
补丁、许可证、探针 Alpine 镜像及 Codex npm 包的 SHA-256。源码准备脚本校验这些输入，
对已有目录核对完整已应用补丁，拒绝混用其他 revision 或本地修改。

```bash
uv run --no-project python \
  wework-mobile/modules/wework-local-runtime/scripts/prepare-ish-source.py \
  --output /external/ish-source

node wework-mobile/scripts/build-local-executor.mjs \
  --repo "$PWD" --output /external/executor-cache

uv run --no-project python wework-mobile/scripts/build-local-runtime-ios.py \
  --source /external/ish-source \
  --rootfs /external/clean-rootfs.tar.gz \
  --rootfs-sha256 VERIFIED_ROOTFS_SHA256 \
  --executor /external/executor-cache/wegent-executor \
  --output /external/ios-runtime --link-module
```

executor 工具链固定为 Rust `1.94.1`、Zig `0.15.2`、cargo-zigbuild `0.23.0`、
OpenSSL `3.5.9`；使用 `--openssl-archive` 可提供已下载的归档，仍需通过脚本的哈希校验。
iSH 使用 `guest_arch=arm64`、`engine=asbestos`、`jit=true`、`jit_emit=false`。
其中 `jit=true` 选择带 AOT 支持的引擎，`jit_emit=false` 禁止生成运行时可执行代码。

生产 rootfs 是显式传入并校验哈希的独立制品，包含 Alpine、bash、git、CA 证书和
官方 Codex 完整资源目录；构建脚本再加入本次 Rust executor。不能从开发者的活跃 rootfs
直接复制 `meta.db`：fakefs 的 inode 映射与宿主文件关联，移动后可能损坏软链接。
使用上游 `fakefsify` / `unfakefsify` 导入导出，并在独立目录验证。交付归档的 `/root`
和 `/tmp` 必须为空，不包含探针、日志、账号或会话文件。

大文件、工具链缓存、静态库、rootfs、日志和设备安装制品放在仓库外。模块 `vendor`
只是本机构建生成的链接，不能提交。

## 针对性验证

`native/tests` 提供 22 项 guest C 断言：父线程退出通知、fork/exec/身份切换语义、
阻塞管道读写退出、快慢读路径的 `EINTR` / `SA_RESTART`、保留 zombie 与活 worker 的
`/proc/<pid>/stat`。额外宿主探针故意阻塞 native worker 超过上游旧超时，验证进程不能被
提前 wait/reap；worker 真正退出后，计数才归零并允许回收。
宿主探针还验证已构造并加载程序、但 native thread 尚未启动的 child 能完整回滚，
释放描述符、注销 PID，并继续创建下一 child。

```bash
uv run --no-project python \
  wework-mobile/modules/wework-local-runtime/scripts/test-ish-runtime.py \
  --ish /external/ish-source/build-host/ish \
  --fakefsify /external/ish-source/build-host/tools/fakefsify \
  --rootfs-archive /external/alpine-minirootfs-3.21.0-aarch64.tar.gz \
  --output /external/probe-results \
  --native-source /external/ish-source
```

每次使用新输出目录，避免覆盖账号文件系统；结果写入 `results.json`。宿主探针要求
Apple ARM64；不传 `--native-source` 时只运行 guest 断言。脚本同时校验 guest 自己的
退出码和断言数量，因为上游 CLI 的 PID 1 halt 路径可能把 guest 失败转换成宿主退出码 0。

macOS ARM64 上已验证无 JIT iSH、上述针对性探针、真实 Rust executor IPC、官方 Codex
initialize、命令执行、文件写入、Git 操作、流式输出、取消及关闭。

2026-11-14 的 iPhone iOS 27.3 独立原生 harness 已验证真实 executor 的 health、经 executor
调用 Codex `config/read`、停止后重启，以及直接启动官方 Codex 后的 initialize、文件写入、
Git 暂存/diff 和真实 `command/exec/outputDelta`。该 harness 使用相同原生运行时和 rootfs；
直接 Codex 探针仅在外部测试副本中切换程序入口，不扩展产品 executor 的 RPC 白名单。
随后使用实际 UIKit 宽限实现的探针，已在后台完成系统到期回调、真实 Codex 命令取消
（exit 137、后续文件未写入），以及停止/重启健康检查。独立前台探针持续 45.088 秒，
严格记录 `backgroundTransitions=0`、exit 0，真实文件写入和 Git 操作正常，未被误取消。
上述结果不等于产品任务到模型的完整链路：真机模型推理、
产品任务流式、产品取消全流程和持续后台尚未验证通过，Android 也未验证。
默认不运行 E2E 或 AI verify。

现有 CI 的 `core:native-lifecycle` 套件增加了 `mobile-local-payload.scenario.mjs`，
加载真实共享模型和执行配置 builder，通过真实 executor 与 Codex 执行两轮创建/发送，
验证同一 thread、消息 ID 和状态；只模拟模型 SSE。该新增场景已做语法、lint、模块加载
和 CI 归类检查，未在本次开发中执行 E2E，不能视为真机覆盖。

## iOS 后台和分发

当前实现支持前台执行，并使用 UIKit `UIApplication.beginBackgroundTask` 申请切到后台后的
短时宽限。它不依赖 `BGContinuedProcessingTask`、固定百分比或输出字节数。系统决定是否
给予时间以及何时到期，不能承诺固定秒数、锁屏持续运行或后台完成任意长度任务。
宽限到期必须取消实际任务并报告 `expired`；已经完成的内容由 executor transcript 保留。
前台任务不能因一个人为后台时限被提前取消。Lease 继续按运行 generation 和 task revision
匹配，旧轮释放和旧状态查询不能取消新轮任务。

选择短时宽限的依据来自已淘汰的 Continued Processing 探针。该 API 要求及时、可衡量的
真实工作进度。有限工作量可以用真实总量和已完成项更新 `Progress`，但未知总量的模型
输出字节只说明收到数据，不构成其所需的完成进度。禁止虚构总量、百分比或无意义保活。

旧探针将 `totalUnitCount` 设为 `-1`、持续累加实际输出字节。iOS 27.3 上后台约 20 秒
后收到 expiration，尽管期间每秒都有真实输出。系统 `dasd` 日志明确记录
`Task has not reported progress within expected cadence, marking stalled`，并由
`Activity Progress Policy` 暂停任务；系统记录的 fraction 为 0。
`NSProgress` 对负总量的定义是 indeterminate，`fractionCompleted` 始终为 0，因此这个旧方案
不能支持未知长度 Codex 任务持续在后台运行。20 秒只是该次观测，不是 UIKit 宽限或系统的固定配额；
其他过期事件仍需结合系统日志归因。回到前台后恢复输出，也不能算后台持续成功。

原生事件 journal 解决 JS 暂停后的通知回放，不授予后台执行权。产品必须如实呈现后台
不可保证和任务过期状态，不能用宿主测试或有限工作量对照替代真实模型任务的真机验证。

Apple 依据：
[UIKit 后台宽限](<https://developer.apple.com/documentation/uikit/uiapplication/beginbackgroundtask(withname:expirationhandler:)>)、
[BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)、
[长任务执行指南](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados)、
[Progress.isIndeterminate](https://developer.apple.com/documentation/foundation/progress/isindeterminate)、
[WWDC25 session 227](https://developer.apple.com/videos/play/wwdc2025/227/)、
[Apple DTS 关于未知总量工作的讨论](https://developer.apple.com/forums/thread/840384)。
其中 DTS 讨论说明该 API 主要适配固定工作量；不能采用虚构进度建议来规避系统要求。

模块保留 iSH 原始 `LICENSE.md`、`LICENSE.IOS` 和 GPLv3 全文。iSH 的 App Store 附加条款
只处理与商店服务条款的冲突，不免除 GPL 的源码和许可证提供义务。发布时必须同时提供
匹配上游 revision、兼容补丁和构建步骤；Wegent 代码的许可证不会替代这些上游条款。

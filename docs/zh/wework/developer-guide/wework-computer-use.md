---
sidebar_position: 39
---

# 电脑操控

Wework 的电脑操控能力让本地 Codex 会话在用户授权后操作桌面应用。它使用
`@trycua/cua-driver` 访问系统辅助功能和屏幕内容，但会话、权限状态、操作确认、
中止以及 MCP 暴露仍由 Wework 管理。

电脑操控只用于 Wework 内置浏览器之外的桌面应用。网页任务继续使用
`wework_browser`，不要使用电脑操控模拟浏览器点击。

## 架构

调用链如下：

```text
Codex
  -> wework_computer MCP
  -> 打包内的 wegent-executor
  -> 带 Bearer Token 的 loopback HTTP bridge
  -> Electron ComputerUseService
  -> Electron Node Helper 子进程（Node IPC）
  -> @trycua/cua-driver
  -> 平台辅助功能与屏幕捕获接口
```

Electron 主进程拥有 CUA Driver 的生命周期。启用电脑操控且系统权限满足后，
`ComputerUseService` 在独立的 Electron Node Helper 子进程中创建 Driver，主进程监听
随机的 `127.0.0.1` 端口，并把主进程 PID、地址、
随机 token 和启动时间原子写入当前 Executor Home 的
`runtime/computer-use-bridge.json`。关闭功能或退出应用时必须中止当前动作、关闭
bridge、停止 Driver 并删除该文件。

原生工具不得在 Electron 主进程内执行：macOS 对同进程的辅助功能调用可能直接
进入 AppKit，而 CUA 的后台线程不能操作 AppKit 窗口。独立子进程让窗口调用跨进程
交由宿主主线程处理，并隔离原生崩溃。子进程以 `ELECTRON_RUN_AS_NODE=1` 运行打包
内的 Helper，沿用宿主的 TCC 责任链，权限请求仍由 Wework 主进程负责。取消信号通过
Node IPC 传入对应的原生调用；宿主 IPC 断开时子进程立即退出。

桥接使用 Node 的 `child_process.fork` 和带错误回调的 `send`。Electron 43.0.0 的
`utilityProcess.postMessage` 在子进程退出时存在主进程原生崩溃问题，不能用它承载
这条崩溃隔离链路，见 [Electron #53293](https://releases.electronjs.org/pr/53293)。

Driver 异常退出后，主进程清理 bridge、显示错误，并保留启用偏好；状态查询不会
自动重启 Driver 或重放结果未知的动作。用户关闭再开启电脑操控后创建新进程。

Executor 启动 Codex 会话时读取这份 runtime record。文件不存在、内容无效或功能
尚未就绪时，不注入 `wework_computer`。文件有效时，Executor 以自身的
`computer-use-mcp-server` 子命令启动 stdio MCP server，并只通过带 token 的本机
HTTP 请求调用 Electron。写操作使用 `default_tools_approval_mode = "writes"`，
读取屏幕或工具目录不需要复用写操作确认。

每次只能执行一个桌面动作。用户点击停止或按 Esc 时，Electron 通过
`AbortSignal` 请求取消当前 Driver 调用；不得仅隐藏状态浮层而让底层动作继续。

MCP 在等待工具结果时仍读取输入，处理 `notifications/cancelled` 和 ping。取消或
stdio EOF 会丢弃对应 HTTP 请求；Electron 在响应连接异常关闭时请求取消 SDK 调用。
工具执行和目录查询都使用 90 秒宿主截止时间，低于 HTTP 客户端的 120 秒截止时间。
已派发的工具调用取消时返回原始原因及 `action outcome is unknown`，不得视为动作
未执行；派发前取消及目录查询保留原始取消原因。迟到的结果不得覆盖取消错误。

子进程从 SDK 自身目录的 `readOnlyHint` 获取只读标记，不维护手写工具分类。
只读调用与目录查询直接取消 SDK Future。写操作不提前丢弃 Future：CUA 0.22.1 的
后台原生输入仍可能继续，并跳过鼠标释放等收尾；动作占用因此保持到原生调用真实
完成或驱动进程退出。关闭驱动也要等到进程实际退出，才能创建下一代驱动。
目录查询与工具调用共用取消协议；子进程在取消后 5 秒内仍未应答时，宿主强制结束
该进程并报告动作结果未知。此时沿用异常退出的恢复流程，由用户关闭再开启电脑操控，
不得自动重放动作。重新启用只重建运行时；强制结束进程不证明系统中的鼠标按键或
修饰键状态已释放。

主进程日志中的 `[computer-use]` 记录操作编号、宿主及原生子进程 PID、工具名、开始、
完成、取消、失败阶段与耗时，不记录参数、截图、会话内容或 token。排查卡住时先
核对阶段，再对该操作的 `nativePid` 采样；聚合调用的显示名称不能证明实际阻塞在
`start_session`。
CUA 0.22.1 的 AX 遍历有 20 秒截止时间，但取消 Rust Future 不能强制停止已开始的
`spawn_blocking` 原生工作。因此 SDK 取消成功本身不是原生线程退出的证据。

## 权限与设置

macOS 需要向实际运行的 Wework 应用授予：

- 辅助功能权限；
- 屏幕与系统音频录制权限。

正式包请求权限的主体是签名后的 `WeWork.app`。源码开发模式下主体可能显示为
`Electron`。macOS 修改权限后通常需要重启对应应用进程。Windows 和 Linux
不显示 macOS 权限引导，但仍由 Driver 报告平台能力和运行错误。

总开关保存在 Wework 桌面偏好中。Electron 配置 Desktop Runtime 时创建
`ComputerUseService` 实例。当前首屏的数据与可操作条件就绪后，Renderer 通过
`renderer.startupReady` 发起窗口交接。启动页完成 100% 呈现与淡出关闭、主窗口获得
焦点后，Electron 调度一次后台偏好恢复，由它读取启用偏好并初始化 Driver。CUA
原生模块加载和 macOS 权限检查在这条后台流程中执行。

后台恢复开始前会重新读取最新偏好；功能已关闭或应用正在退出时不启动 Driver。权限
尚未满足时保持启用意图但不创建 bridge，设置页持续显示缺少的权限。权限满足后状态
查询会再次尝试启动。

## 发布集成

CUA 不是独立 sidecar，也不从用户环境或网络动态安装。Electron 包固定依赖
`@trycua/cua-driver`，pnpm 根据构建平台选择对应的原生包，例如
`@trycua/cua-driver-darwin-arm64`。

JavaScript 文件进入 `app.asar`，原生 `.node`、`.dylib`、`.so` 和 `.dll` 文件通过
Electron 打包配置解包到 `app.asar.unpacked`。原生动态加载不能直接读取 ASAR
虚拟路径，因此 `wework/electron/patches/` 中的 pnpm 依赖补丁会把 CUA 计算出的
`app.asar` 路径改写为对应的 `app.asar.unpacked` 路径。升级 CUA 版本时必须同步
更新补丁声明、锁文件和打包验证。

CUA 属于 Electron 宿主的原生依赖，不能通过独立组件清单热更新。CUA 版本、原生
库或桥接协议变化必须发布完整 Electron 安装包，并经过各平台签名流程。安装包还会
把 CUA 的 MIT License 放入 `Resources/licenses`。

macOS ARM64 产物应至少包含：

```text
WeWork.app/Contents/Resources/
├── app.asar
├── app.asar.unpacked/node_modules/@trycua/cua-driver-darwin-arm64/
│   ├── cua_driver_node_runtime.node
│   └── libcua_driver_sdk.dylib
└── licenses/cua-driver-LICENSE.md
```

## 安全边界

- bridge 只监听 loopback 地址，并要求随机 Bearer Token。
- runtime record 和父目录只允许当前用户访问；token 不得写入日志或遥测。
- Wework 持有启用状态、写操作确认和中止语义，不能把 Driver 的默认模式当作产品
  授权模型。
- 截图、辅助功能树和输入内容默认不落盘；测试证据不得包含凭据或用户隐私。
- 不支持用 npm、Shell 或外部 daemon 绕过 Wework 的权限和确认链路。

## 验证

针对性验证至少包括：

```bash
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test \
  src/host/computer-use-startup.test.ts \
  src/host/computer-use-service.test.ts
pnpm --filter wework test \
  src/components/settings/ComputerUseSettingsPage.test.tsx \
  src/features/computer-use/ComputerUseActivityIndicator.test.tsx \
  scripts/desktop-resource-migration.test.mjs
cargo test --manifest-path executor/Cargo.toml computer_use --lib
bash .github/scripts/test-classify-ci-changes.sh
```

发布资源或原生加载路径变化还必须构建真实安装包，并通过桌面 E2E 的
`computer-use` checkpoint。验证应确认原生库位于 `app.asar.unpacked`、许可证已
包含、设置可以持久化，以及权限满足时 Driver 能发布工具目录。系统权限缺失是可见
的产品状态，不能让 E2E 静默跳过。

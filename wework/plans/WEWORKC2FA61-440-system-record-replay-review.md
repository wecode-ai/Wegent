# WEWORKC2FA61-440 系统录制回放验收

## 结论

2026 年 8 月 29 日完成系统级 Record & Replay 重写。原浏览器 DOM 录制实现已删除，DSH 模块现通过 Electron host 调用 macOS 原生 helper，录制全局鼠标、键盘、滚动以及前台应用、窗口和辅助功能元素上下文，并按时间顺序回放。

录制数据仅保存在当前设备。密码等敏感输入不保存键码；删除、支付、安装等高风险目标会标记为不可自动回放并暂停。

## 核心流程截图

| 步骤 | 验证点                                               | 截图                                                                                        |
| ---- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | DSH 模块加载；辅助功能与输入监控权限就绪；录制库为空 | [01-system-ready.png](assets/dsh-record-replay/01-system-ready.png)                         |
| 2    | 输入跨应用系统录制名称                               | [02-named-recording.png](assets/dsh-record-replay/02-named-recording.png)                   |
| 3    | 启动系统录制；持续接收系统操作步骤                   | [03-recording-system-actions.png](assets/dsh-record-replay/03-recording-system-actions.png) |
| 4    | 停止并保存；展示步骤数和涉及应用数                   | [04-recording-saved.png](assets/dsh-record-replay/04-recording-saved.png)                   |
| 5    | 启动系统回放；回放期间可主动停止                     | [05-replaying-system-actions.png](assets/dsh-record-replay/05-replaying-system-actions.png) |
| 6    | 回放完成并恢复空闲状态，录制仍保留在本机库中         | [06-replay-complete.png](assets/dsh-record-replay/06-replay-complete.png)                   |

截图链已逐张检查，未发现遮挡、溢出、错位、错误浏览器文案或状态跳转缺失。

## 验证记录

- Swift 原生 helper 编译通过。
- 本机权限探测：`accessibilityGranted=true`、`inputMonitoringGranted=true`。
- 真实系统事件闭环：原生监听捕获到由 macOS System Events 产生的 Escape 键事件，包含 `loginwindow` 应用、窗口标题、AX 角色、键码和修饰键上下文。
- Electron 与 Wework TypeScript 类型检查通过。
- Electron host 聚焦测试：3 个用例通过。
- Wework 聚焦测试：58 个用例通过；DSH UI 插件契约 4 个用例通过。
- ESLint、Prettier 和 `git diff --check` 通过。
- 当前分支 Electron macOS arm64 打包通过，原生 helper 已进入 `Contents/Resources/bin`。
- CI 注册的桌面检查点 `system-record-replay` 通过：独立用户目录中完成权限状态、开始录制、保存、回放、删除与空状态恢复。

桌面检查点证据目录：

`wework/test-results/desktop-e2e/2026-08-29T04-09-23-186Z-89150`

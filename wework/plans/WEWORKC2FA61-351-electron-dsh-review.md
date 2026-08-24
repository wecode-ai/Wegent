# Electron + Core DSH 核心流程验证记录

验证日期：2026-08-24

## 结论

本轮验证确认 Wework 保留原生工作台外壳，并由 Core DSH 提供通用扩展宿主。
`betterSidebar` 只是兼容适配器，不是产品主协议。真实 DSH 插件、底部终端和
Wework 内置浏览器均在最终 Electron 打包产物中完成验证。

主协议与命名：

- DSH 宿主服务：`ctx.wework`（`wework.host.v1`）
- 扩展注册表：`ctx.wework.extensions`（`wework.extensions.v1`）
- 首个扩展点：`wework.workspace.sidebar.tab`
- 命名规则：`wework.<surface>.<slot>.<kind>`
- 候选后续扩展点：
  `wework.workspace.bottom-panel.tab`、
  `wework.workspace.toolbar.action`、
  `wework.composer.action`
- 兼容旁路：`ctx.betterSidebar`、
  `window.__WEWORK_DSH_BETTER_SIDEBAR__`

这里刻意没有把正式协议命名为 sidebar。`wework` 是产品所有者命名空间，
`extensions` 是通用注册服务，具体 UI 能力才落在 extension point 中。这样未来
发布底部面板、工具栏、输入区或其他 surface 时，插件继续使用同一个宿主和注册
协议，不需要引入第二套 API。`better-sidebar` 仅将它已有的 sidebar descriptor
转换为 `wework.workspace.sidebar.tab` contribution。

## 环境

- 分支：`feature/electron-dsh-codex-poc`
- Electron 应用：
  `wework/electron/release/WeWork-darwin-arm64/WeWork.app`
- `ai:verify` 会话：
  `test-results/ai-verify/2026-08-23T20-27-15-096Z-75951`
- 插件：`github:ChenRuoT/dsh-sidebar-qa`，版本 `0.4.0`
- 浏览器验证页：Example Domain

## 截图链

| 步骤 | 操作与断言                                                                                                                                                                                                                               | 证据                                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1    | 在插件管理界面手工安装真实 Git 插件；插件状态为“已激活”。截图拍摄时界面仍显示早期服务名 `weworkExtensions`，本轮已将正式 API 收敛为 `ctx.wework.extensions`；扩展点保持 `wework.workspace.sidebar.tab`，`betterSidebar` 仍仅为兼容适配层 | [01-plugin-manager-installed.png](assets/WEWORKC2FA61-351/01-plugin-manager-installed.png)     |
| 2    | 重启 Core DSH 后打开 Wework 原右侧栏；原生 launcher 中出现插件贡献的“追问”和“追问记录”，没有第二套 sidebar 壳                                                                                                                            | [02-extension-launchers.png](assets/WEWORKC2FA61-351/02-extension-launchers.png)               |
| 3    | 点击“追问记录”；扩展 surface 的 `data-wework-extension-mount-state` 为 `mounted`，显示插件真实空态                                                                                                                                       | [03-extension-history.png](assets/WEWORKC2FA61-351/03-extension-history.png)                   |
| 4    | 点击“追问”；扩展 surface 的 mount state 为 `mounted`，真实 textarea、模型选择与动作控件可见                                                                                                                                              | [04-extension-ask.png](assets/WEWORKC2FA61-351/04-extension-ask.png)                           |
| 5    | 从同一工作台打开底部 Terminal；Core DSH PTY 返回当前仓库路径和真实 shell prompt，不再显示“启动失败”或黑色空截图                                                                                                                          | [05-terminal-working.png](assets/WEWORKC2FA61-351/05-terminal-working.png)                     |
| 6    | 从同一右侧栏新增 Wework 内置浏览器并提交 `https://example.com`；原生网页正常加载，插件 tab、浏览器 tab 与右侧动作按钮保持同一标题行                                                                                                      | [06-browser-integrated.png](assets/WEWORKC2FA61-351/06-browser-integrated.png)                 |
| 7    | 打开浏览器更多菜单；菜单层覆盖原生网页内容且可点击，不再被 WebContentsView / webview 遮挡                                                                                                                                                | [07-browser-menu-overlay.png](assets/WEWORKC2FA61-351/07-browser-menu-overlay.png)             |
| 8    | 启动真实 OpenCode harness 后同时打开 Wework 原右侧工作区和底部 Terminal；两个终端共享 Core DSH 事件流，Renderer 保持可交互                                                                                                               | [08-opencode-workbench-panels.png](assets/WEWORKC2FA61-351/08-opencode-workbench-panels.png)   |
| 9    | 切换到真实 Kimi Code 会话并再次同时打开右侧工作区、底部 Terminal；Kimi TUI、launcher 和 shell 终端同时可见                                                                                                                               | [09-kimi-code-workbench-panels.png](assets/WEWORKC2FA61-351/09-kimi-code-workbench-panels.png) |
| 10   | 启动真实 Claude Code，完成并行 tool 回归；结果、工作区环境卡片与 composer 同时可见，证明第三种 harness 也完成端到端验证                                                                                                                  | [10-claude-code-conversation.png](assets/WEWORKC2FA61-351/10-claude-code-conversation.png)     |

浏览器原生内容的独立捕获：
[06-browser-content.png](assets/WEWORKC2FA61-351/06-browser-content.png)。

## 自动验证

本轮相关聚焦验证：

```bash
pnpm run typecheck
pnpm --dir electron typecheck
pnpm --dir electron exec vitest run \
  src/host/electron-capabilities.test.ts \
  src/runtime/core-dsh-runtime.test.ts
pnpm exec vitest run \
  src/api/dsh/terminalTransport.test.ts \
  scripts/ai-verify.test.mjs \
  src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx \
  src/components/layout/workspace-panels/rightWorkspaceSidebarRegistry.test.ts
node --test \
  dsh/app-wework/client.test.mjs \
  dsh/app-wework/plugin-manager.test.mjs \
  dsh/electron-host/client.test.mjs
npm_config_registry=https://registry.npmjs.org pnpm --dir electron build:package
WEWORK_E2E_APP_BIN=/absolute/path/to/WeWork \
WEWORK_E2E_EXECUTOR_BIN=/absolute/path/to/wegent-executor \
  pnpm e2e:desktop:local-terminal
```

真实 local-harness 场景通过，证据目录：
`test-results/desktop-e2e/2026-08-24T00-00-46-823Z-96548`。场景完整覆盖
OpenCode、Kimi Code、Claude Code、会话恢复、右侧工作区和底部 Terminal；
未修改原 E2E 断言。

Wework 内置浏览器工具栏场景通过，证据目录：
`test-results/desktop-e2e/2026-08-24T11-03-47-620Z-95221`。场景完整覆盖
响应式 390px viewport、旋转 844px、自定义尺寸、设备缩放、页面缩放、查找、
下载和清理浏览数据；设备模式使用 CDP metrics 的 image scale，不再将宿主适配
缩放叠加到 Electron page zoom。macOS detached Inspector 打开后，Host 等待
child WebView frame 连续稳定再返回，原 frame 不变断言未修改。

## PR #2945 回归截图链

最新 Electron 打包产物对历史 CI 失败项逐个复核，全部退出码为 0：

| 流程             | 关键截图顺序                                                                                                                                                                                                                                            | 证据目录                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 核心任务与侧边栏 | `system-drag-panel.png` → `system-drag-popout-window.png` → `guidance-scroll-01-message-visible.png` → `02-background-request-user-input-visible.png` → `03-sidebar-manual-scroll-preserved.png` → `04-delayed-answer-completed.png`                    | `test-results/desktop-e2e/2026-08-24T11-00-36-491Z-61150`                  |
| Goal 生命周期    | `goal-idle-01-running.png` → `goal-idle-02-automatic-continuation.png` → `goal-idle-03-reloaded-continuation.png` → `goal-restart-01-working-before-restart.png` → `goal-restart-03-opened-waiting-for-user.png` → `goal-restart-06-completed-read.png` | `/Users/axb-mac/.wework/e2e-results/pr2945/2026-08-24T07-00-15-426Z-80509` |
| 云项目创建       | `00-cloud-work-page.png` → `project-shared-root-both-visible.png`                                                                                                                                                                                       | `/Users/axb-mac/.wework/e2e-results/pr2945/2026-08-24T07-02-14-894Z-23119` |
| 附件与托盘重开   | `01-attachment-only-first-submitted.png` → `02-attachment-only-first-completed.png` → `04-attachment-only-two-tasks-after-refresh.png` → `05-attachment-only-current-image-after-reopen.png` → `06-attachment-only-first-image-after-reopen.png`        | `test-results/desktop-e2e/2026-08-24T11-04-47-507Z-6156`                   |

截图 review 结论：

- 系统拖拽面板与 Popout Window 均由 Electron 原生窗口承载，弹出后焦点不回落
  到主窗口。
- guidance 前的 pre-tool 文本只出现一次，并位于 process block；guidance 后的
  continuation 顺序正确。
- 420px 高窗口中活动任务可被滚出视口，运行时状态刷新后侧边栏保持同一
  `scrollTop`，证明 Electron 已恢复旧 Tauri 的窗口调整语义。
- Goal 自动续跑、重载、整应用重启、等待用户恢复和最终已读状态均连续。
- macOS Inspector 回归使用原 `browser-toolbar-actions` 场景复核：
  `test-results/desktop-e2e/2026-08-24T11-03-47-620Z-95221`。
  打开 detached Inspector 后，Wework 主 Renderer 与所有内置浏览器 child
  WebView frame 均保持稳定；Host 不再采样 DevTools detach 的过渡帧。
- 附件截图 review 确认关闭到托盘再按绝对 `.app` 路径重开后，当前与历史纯附件
  任务图片都恢复，环境侧栏、标题栏和 composer 布局没有错位。
- 云项目创建使用真实 Git 临时仓库完成，不存在 `spawn git ENOENT`。

`git push` 会按仓库约定执行完整 pre-push 验证；不通过重试、跳过或修改旧 E2E
断言换取通过。

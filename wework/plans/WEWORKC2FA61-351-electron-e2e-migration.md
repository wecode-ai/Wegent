# Desktop E2E 与 `ai:verify` Electron 迁移清单

更新日期：2026-08-24

## 审计基线与结论

- 合并时 `origin/main`：`e36f29ed4`
- PR 基线 HEAD：`14f04e765b13eae2276096d26c18d8e1b83e9ea1`
- `origin/main` 定义 44 个 desktop checkpoint、4 个 plugin segment，并包含
  22 个独立 scenario 文件。
- 当前分支定义 48 个 desktop checkpoint、4 个 plugin segment；新增的
  `cloud-space-mention` 将 main 已存在但未注册的
  `cloud-space-mention.scenario.mjs` 纳入 checkpoint runner，并新增
  `native-window-startup`、`native-window-chrome`、`tray-lifecycle` 三项真实
  Electron 原生窗口覆盖。
- 当前 25 个独立 scenario 均由 `run-checkpoints.mjs` 显式映射到 checkpoint，
  不存在仅能本地单独运行、但不进入统一 runner 的 scenario。
- Desktop E2E 与 `ai:verify` 只启动真实 Electron app。运行时选择器、旧宿主
  build/launch/wrap/config/log/origin 分支已从
  `wework/e2e/**` 与 `wework/scripts/ai-verify*.mjs` 删除。
- Desktop E2E 必须提供 `WEWORK_E2E_APP_BIN`，该文件必须是预构建 Electron
  可执行文件；runner 不再现场构建其他桌面宿主。

## 代码事实来源

| 事实                                    | 代码来源                                             |
| --------------------------------------- | ---------------------------------------------------- |
| checkpoint 与 plugin segment 总表       | `wework/e2e/desktop/checkpoints.mjs`                 |
| checkpoint 到 scenario 的映射           | `wework/e2e/desktop/run-checkpoints.mjs`             |
| 真实 Electron app 启动与控制            | `wework/e2e/desktop/modules/task-flow-main.mjs`      |
| Electron app 产物约束                   | `wework/e2e/desktop/modules/desktop-build-flows.mjs` |
| Core、Cloud、Plugins CI 分片            | `.github/scripts/classify-wework-desktop-e2e.sh`     |
| CI 中 Electron 二进制注入与 runner 调用 | `.github/workflows/wework-e2e.yml`                   |
| Playwright Web E2E 收集目录             | `wework/playwright.config.ts`                        |

CI 对应关系说明：

- `Core`：Linux Electron 预构建包，
  `wework-desktop-core-e2e` 调用 `run-checkpoints.mjs --parallel-segments`。
- `Cloud`：同一个 Linux Electron 预构建包，
  `wework-desktop-cloud-e2e` 以 cloud scope 调用同一 runner。
- `Plugins`：`wework-desktop-e2e` 调用 `e2e:desktop:plugins`。
- `macOS Inspector`：macOS Electron 真实包单独执行
  `browser-toolbar-actions`，是该 checkpoint 的额外平台覆盖。
- `组合入口`：`cloud-git-worktree` 本身不直接进入 CI 矩阵；runner 将它展开为
  6 个 `cloud-worktree-*` checkpoint，这 6 项均进入 Cloud CI。

## Desktop checkpoint 全量对照

“main”列表示该 checkpoint 是否存在于上述 `origin/main` 基线；“当前 CI”列
表示当前代码中的 CI 分片归属。

|   # | Checkpoint                        | main                        | 当前执行入口                                    | 当前 CI                |
| --: | --------------------------------- | --------------------------- | ----------------------------------------------- | ---------------------- |
|   1 | `remote-device-onboarding`        | 是                          | 主流程                                          | Core                   |
|   2 | `workspace-tabs`                  | 是                          | 主流程                                          | Core + Cloud           |
|   3 | `cloud-project-creation`          | 是                          | 主流程                                          | Cloud                  |
|   4 | `cloud-space-mention`             | 否；main 仅有 scenario 文件 | `cloud-space-mention.scenario.mjs`              | Core                   |
|   5 | `priority-filter`                 | 是                          | 主流程                                          | Core + Cloud           |
|   6 | `telemetry-consent`               | 是                          | 主流程                                          | Cloud                  |
|   7 | `automation-lifecycle`            | 是                          | 主流程                                          | Core + Cloud           |
|   8 | `project-automation`              | 是                          | `project-automation.scenario.mjs`               | Core + Cloud           |
|   9 | `project-assignment-notification` | 是                          | `project-assignment-notification.scenario.mjs`  | Core                   |
|  10 | `offline-local-project-space`     | 是                          | `offline-local-project-space.scenario.mjs`      | Core                   |
|  11 | `plugin-auto-update`              | 是                          | 主流程                                          | Cloud                  |
|  12 | `project-ai-settings`             | 是                          | 主流程                                          | Core                   |
|  13 | `model-routing`                   | 是                          | 主流程                                          | Core + Cloud           |
|  14 | `permission-modes`                | 是                          | 主流程                                          | Core                   |
|  15 | `core-task-flow`                  | 是                          | 主流程                                          | Core + Cloud           |
|  16 | `task-attachments`                | 是                          | `task-attachments.scenario.mjs`                 | Core                   |
|  17 | `cloud-git-worktree`              | 是                          | 组合入口，展开后执行 6 个子 checkpoint          | Cloud（通过展开项）    |
|  18 | `cloud-worktree-capability`       | 是                          | 云工作树流程                                    | Cloud                  |
|  19 | `cloud-worktree-create`           | 是                          | 云工作树流程                                    | Cloud                  |
|  20 | `cloud-worktree-queued-cancel`    | 是                          | 云工作树流程                                    | Cloud                  |
|  21 | `cloud-worktree-tools`            | 是                          | 云工作树流程                                    | Cloud                  |
|  22 | `cloud-worktree-archive-restore`  | 是                          | 云工作树流程                                    | Cloud                  |
|  23 | `cloud-worktree-device-restart`   | 是                          | 云工作树流程                                    | Cloud                  |
|  24 | `context-compaction`              | 是                          | `context-compaction.scenario.mjs`               | Core                   |
|  25 | `runtime-task-queue`              | 是                          | `runtime-task-queue.scenario.mjs`               | Core                   |
|  26 | `runtime-terminal-convergence`    | 是                          | `runtime-terminal-convergence.scenario.mjs`     | Core                   |
|  27 | `running-conversation-history`    | 是                          | `running-conversation-history.scenario.mjs`     | Core                   |
|  28 | `codex-notification-isolation`    | 是                          | `codex-notification-isolation.scenario.mjs`     | Core                   |
|  29 | `split-workbench`                 | 是                          | `split-workbench.scenario.mjs`                  | Core                   |
|  30 | `native-window-startup`           | 否                          | `native-window-startup.scenario.mjs`            | Core                   |
|  31 | `native-window-chrome`            | 否                          | `native-window-chrome.scenario.mjs`             | Core                   |
|  32 | `tray-lifecycle`                  | 否                          | `tray-lifecycle.scenario.mjs`                   | Core                   |
|  33 | `window-lifecycle`                | 是                          | 主流程                                          | Core + Cloud           |
|  34 | `goal-lifecycle`                  | 是                          | 主流程                                          | Core + Cloud           |
|  35 | `supervisor-lifecycle`            | 是                          | 主流程                                          | Core + Cloud           |
|  36 | `resilience`                      | 是                          | 主流程                                          | Core + Cloud           |
|  37 | `conversation-state`              | 是                          | `conversation-mention.scenario.mjs`             | Core + Cloud           |
|  38 | `temporary-chat`                  | 是                          | `temporary-chat.scenario.mjs`                   | Core                   |
|  39 | `workspace-attachments`           | 是                          | 主流程                                          | Core + Cloud           |
|  40 | `rendering-extensions`            | 是                          | `streaming-text.scenario.mjs`                   | Core + Cloud           |
|  41 | `change-request-status`           | 是                          | `change-request-status.scenario.mjs`            | Core                   |
|  42 | `claude-runtime`                  | 是                          | `claude-runtime.scenario.mjs`                   | Core                   |
|  43 | `local-file-preview`              | 是                          | `local-file-preview.scenario.mjs`               | Core                   |
|  44 | `local-harness`                   | 是                          | `local-terminal.scenario.mjs`                   | Core                   |
|  45 | `harness-apps`                    | 是                          | `harness-apps.scenario.mjs`                     | Core                   |
|  46 | `browser-multi-tabs`              | 是                          | `embedded-browser-multi-tabs.scenario.mjs`      | Cloud                  |
|  47 | `embedded-browser`                | 是                          | `embedded-browser-agent.scenario.mjs`           | Core + Cloud           |
|  48 | `browser-toolbar-actions`         | 是                          | `embedded-browser-toolbar-actions.scenario.mjs` | Core + macOS Inspector |

## 独立 scenario 全量对照

`origin/main` 中的 22 个 scenario 文件当前全部映射到统一 Electron checkpoint
runner；当前分支新增 3 个原生窗口 scenario，25 个 scenario 均进入 Core 或
Cloud CI。

|   # | Scenario                                        | 当前 checkpoint                   | 当前 CI                |
| --: | ----------------------------------------------- | --------------------------------- | ---------------------- |
|   1 | `change-request-status.scenario.mjs`            | `change-request-status`           | Core                   |
|   2 | `claude-runtime.scenario.mjs`                   | `claude-runtime`                  | Core                   |
|   3 | `cloud-space-mention.scenario.mjs`              | `cloud-space-mention`             | Core                   |
|   4 | `codex-notification-isolation.scenario.mjs`     | `codex-notification-isolation`    | Core                   |
|   5 | `context-compaction.scenario.mjs`               | `context-compaction`              | Core                   |
|   6 | `conversation-mention.scenario.mjs`             | `conversation-state`              | Core + Cloud           |
|   7 | `embedded-browser-agent.scenario.mjs`           | `embedded-browser`                | Core + Cloud           |
|   8 | `embedded-browser-multi-tabs.scenario.mjs`      | `browser-multi-tabs`              | Cloud                  |
|   9 | `embedded-browser-toolbar-actions.scenario.mjs` | `browser-toolbar-actions`         | Core + macOS Inspector |
|  10 | `harness-apps.scenario.mjs`                     | `harness-apps`                    | Core                   |
|  11 | `local-file-preview.scenario.mjs`               | `local-file-preview`              | Core                   |
|  12 | `local-terminal.scenario.mjs`                   | `local-harness`                   | Core                   |
|  13 | `offline-local-project-space.scenario.mjs`      | `offline-local-project-space`     | Core                   |
|  14 | `project-assignment-notification.scenario.mjs`  | `project-assignment-notification` | Core                   |
|  15 | `project-automation.scenario.mjs`               | `project-automation`              | Core + Cloud           |
|  16 | `running-conversation-history.scenario.mjs`     | `running-conversation-history`    | Core                   |
|  17 | `runtime-task-queue.scenario.mjs`               | `runtime-task-queue`              | Core                   |
|  18 | `runtime-terminal-convergence.scenario.mjs`     | `runtime-terminal-convergence`    | Core                   |
|  19 | `split-workbench.scenario.mjs`                  | `split-workbench`                 | Core                   |
|  20 | `native-window-startup.scenario.mjs`            | `native-window-startup`           | Core                   |
|  21 | `native-window-chrome.scenario.mjs`             | `native-window-chrome`            | Core                   |
|  22 | `tray-lifecycle.scenario.mjs`                   | `tray-lifecycle`                  | Core                   |
|  23 | `streaming-text.scenario.mjs`                   | `rendering-extensions`            | Core + Cloud           |
|  24 | `task-attachments.scenario.mjs`                 | `task-attachments`                | Core                   |
|  25 | `temporary-chat.scenario.mjs`                   | `temporary-chat`                  | Core                   |

## 原生窗口职责迁移对照

| 原生职责     | Electron 实现                                                        | E2E checkpoint                            | 强断言                                                    |
| ------------ | -------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------- |
| 启动 loading | `StartupSplash` + 独立安全 `BrowserWindow`                           | `native-window-startup`                   | created → shown → animation-ready → closed；真实 PNG 证据 |
| Tray 托盘    | `ElectronTrayManager` + `Tray` + `Menu.buildFromTemplate`            | `tray-lifecycle`                          | Tray 创建、菜单、设置跳转、隐藏主窗、Tray 点击恢复        |
| macOS Dock   | `app.dock.hide()` / `app.dock.show()`                                | `tray-lifecycle`                          | close-to-tray 后 Dock 隐藏；Tray 恢复后 Dock 显示         |
| titlebar     | Electron frame 参数、macOS drag region、Windows/Linux 自定义窗口按钮 | `native-window-chrome`                    | drag/no-drag、最小化、最大化/恢复、关闭确认与原生窗口状态 |
| 窗口关闭偏好 | `WindowClosePolicy` + `PreferencesStore`                             | `tray-lifecycle`、既有 `window-lifecycle` | 首次确认、取消、确认持久化、后台运行、重新激活            |

## Plugin segment 全量对照

| Segment                        | main | Electron runner                                              | 当前 CI                                     |
| ------------------------------ | ---- | ------------------------------------------------------------ | ------------------------------------------- |
| `plugin-marketplace-lifecycle` | 是   | `e2e:desktop:plugins --segment plugin-marketplace-lifecycle` | Plugins，可独立执行；`plugins:all` 全量覆盖 |
| `plugin-lifecycle`             | 是   | `e2e:desktop:plugins --segment plugin-lifecycle`             | Plugins，可定向                             |
| `skill-mention-rendering`      | 是   | `e2e:desktop:plugins --segment skill-mention-rendering`      | Plugins，可定向                             |
| `sites-plugin-auto-install`    | 是   | `e2e:desktop:plugins --segment sites-plugin-auto-install`    | Plugins，可定向                             |

## Playwright Web E2E

这些文件由 `playwright.config.ts` 的 `testDir: './e2e/tests'` 收集，并由
`wework-e2e` CI job 执行。它们不启动桌面进程，但属于 Wework E2E 总覆盖。

| 文件                                  | CI           |
| ------------------------------------- | ------------ |
| `e2e/tests/app-shell.spec.ts`         | `wework-e2e` |
| `e2e/tests/response-api-mock.spec.ts` | `wework-e2e` |
| `e2e/tests/upstream-mocks.spec.ts`    | `wework-e2e` |

## Electron-only 门禁

以下扫描在代码与测试范围内应无旧宿主命中：

```bash
rg -n -i \
  'tauri|WEWORK_E2E_DESKTOP_RUNTIME|desktopRuntime[[:space:]]*[:=]|data-tauri' \
  wework/e2e wework/scripts/ai-verify*.mjs
```

允许的桌面运行时环境值只有显式的：

```text
WEWORK_DESKTOP_RUNTIME=electron
```

`ai:verify start` 不接受 runtime 参数；Desktop E2E 不接受 runtime 环境选择器。

## 2026-08-24 最终验证结果

- 覆盖审计：48 个清单项全部有 Electron runner 与 CI 入口；其中
  `cloud-git-worktree` 是组合入口，展开后实际执行 47 个唯一 checkpoint。
  `origin/main` 的 22 个独立 scenario 全部迁移，另新增 3 个 Electron 原生职责
  scenario，共 25 个；4 个插件 segment 和 3 个 Playwright Web E2E 仍由 CI
  调用。
- 全量 Desktop E2E：Core 37 项和 Cloud 24 项均完成真实打包 Electron 应用验证。
  并行资源竞争导致 `context-compaction`、`embedded-browser`、
  `conversation-state`、`project-automation` 出现一次超时，串行复验全部通过；
  对应证据分别为 `2026-08-24T17-07-20-140Z-3131`、
  `2026-08-24T17-09-28-077Z-6008`、
  `2026-08-24T17-10-39-430Z-7732`、
  `2026-08-24T17-11-52-498Z-9885`，未为获得通过而加入重试或放宽断言。
- `cloud-project-creation` 的 `spawn git ENOENT` 串行稳定复现。失败证据
  `2026-08-24T17-08-40-023Z-4874` 同时显示目标目录尚不存在、UI 仍为“克隆中”、
  后端仍在执行 `git clone`，证明 Node 报错来自缺失 `cwd`，而不是 Git
  可执行文件丢失。E2E 改为等待克隆 operation 消失、目标目录出现且新项目进入
  sidebar 后再执行原 Git 强断言；修复后证据
  `2026-08-24T17-14-49-653Z-13762` 中两次
  `git rev-parse --is-inside-work-tree` 均返回 `true`。
- 新增原生职责 E2E 均通过：启动 loading
  `2026-08-24T17-36-48-289Z-40795`、titlebar/原生窗口
  `2026-08-24T17-37-12-360Z-41311`、Tray/Dock/close-to-tray
  `2026-08-24T17-37-37-178Z-41887`；合并 main 后新增的 workspace tabs
  状态保持覆盖也通过，证据为 `2026-08-24T17-35-41-358Z-39141`。
- `harness-apps` 在合并 main 后暴露并修复了 3 个 Electron 主流程缺陷：
  空 YAML patch 的模型注入、关联目录卸载误删父目录、工作台 DSH 多版本选择。
  `0.1.0-rc.7` 与 `0.1.0-rc.8` 均重新纳入物化运行时，原 E2E 未修改；完整
  Smart App 创建、预览、插件、导出、关联、导入、多版本启动与停止流程通过，
  证据为 `2026-08-24T17-59-37-880Z-67616`。
- 审计发现 `plugin-marketplace-lifecycle` 虽已注册，但定向执行时原先没有进入
  对应验证函数；runner 已按 segment 拆分执行，未修改原验证逻辑或断言。修复
  多版本运行时目录的 Electron 启动物化条件并重建真实应用后，该 segment
  独立通过，证据为 `2026-08-24T18-26-05-867Z-4699`。
- Electron 单测：35 files / 120 tests；Frontend 聚焦测试：
  3 files / 110 tests；Electron 与 Wework TypeScript 类型检查均通过。
- Tauri 删除门禁：对源码、可执行脚本、配置和 CI 扫描 `tauri`、
  `src-tauri`、`isTauri`、`data-tauri`、`@tauri-apps`、
  `WEWORK_E2E_DESKTOP_RUNTIME`，命中数为 0。迁移前设计稿、历史计划、QA 记录和
  `.live-architecture` 事务文件保留历史文字，不属于可执行逻辑。

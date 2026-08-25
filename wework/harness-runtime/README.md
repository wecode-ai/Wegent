---
sidebar_position: 13
---

# Wework DSH Runtime

该目录定义 Wework 使用的可复现 DeepSeek Harness 多版本运行时。它不是用户的
`~/.dsh`，也不会读取或修改个人 Profile。

## 运行时角色

- Core Runtime：`0.1.1-rc.2`，随 Electron 安装包内置。
- Workbench Runtime：首个兼容版本为 `0.1.0-rc.8`，供智能工作台动态 Tab
  启动独立 DSH 进程。
- 每个版本在 `runtimes/<version>` 中拥有独立的精确依赖和锁文件。
- `wework/scripts/prepare-harness-runtime.mjs` 为每个版本生成独立、不可变的运行时资产。

Core 资产的 `runtime.json` 标记 `role: core`，并自带
`@wegent/dsh-app-wework`、`@wegent/dsh-electron-host` 和
`@wegent/dsh-executor-runtime`。它必须通过真实 executor、本地/云 transport、
Host pipe 和 Renderer service 的完整联调。

Workbench 资产标记 `role: workbench`，不复制上述三个核心插件。每个活动工作台
App Tab 使用一个独立 DSH 进程，只验证安装、启动、页面可达、View 嵌入、关闭
清理和凭据隔离，不重复 Core executor 全链路。

## 准备与物化

```bash
cd wework
pnpm run prepare:harness-runtime
pnpm run prepare:harness-runtime -- --materialize
```

任务、项目空间和智能体三个固定 Tab 共享一个 Core DSH 进程。智能工作台 App
Tab 使用独立 Workbench DSH 进程；关闭 Tab 必须终止对应进程。

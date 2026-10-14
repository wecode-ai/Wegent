---
sidebar_position: 13
---

# Wework DSH Runtime

该目录定义 Wework 使用的可复现 DeepSeek Harness 多版本运行时。它不是用户的
`~/.dsh`，也不会读取或修改个人 Profile。

## 运行时角色

- Core Runtime：`0.2.0-rc.2`，随 Electron 安装包内置。
  构建阶段完成解压，启动时直接引用不可变的组件目录，避免首次启动解压全部依赖。
  内置插件的静态网页目录链接到签名组件，插件代码保留在 Profile 中，
  既避免重复复制网页资源，也保持原有依赖解析路径。
- Workbench Runtime：默认版本为 `0.2.0-rc.2`，供智能工作台动态 Tab
  启动独立 DSH 进程。旧应用声明的 `0.1.0-rc.8` 在首次启动时按需下载，
  校验大小、SHA-256 和运行时身份后缓存；后续启动可离线使用缓存。
- 每个角色在 `runtimes/` 中拥有独立的精确依赖和锁文件。清单通过
  `runtimeRole` 区分 Core 和 Workbench；`runtimeBundled: false` 的运行时
  仅发布下载资产，不放入 Electron 安装包。
- 运行时下载默认使用清单中的发布地址；`WEWORK_HARNESS_RUNTIME_BASE_URL`
  可指定镜像根地址，资产文件名及大小、SHA-256、身份校验保持一致。
- `0.2.0-rc.2` 的浏览器认证使用 DSH 官方启动令牌交换流程。令牌仅在进程内
  使用；Renderer 加载不含令牌的 URL，诊断和运行时清单也不保存令牌。
- `wework/scripts/prepare-harness-runtime.mjs` 为每个版本生成独立、不可变的运行时资产。
  发布阶段从构建缓存收集全部版本的归档和描述文件，不从 Core 组件反向提取。
  Linux E2E 构建额外携带下载服务使用的资产目录；生产安装包仍只内置默认运行时。

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

生成的运行时归档必须完全自包含。准备脚本强制使用归档目录内的
`node_modules/.pnpm`，不能保留指向构建机全局 pnpm store 的依赖链接；归档前会
遍历检查软链接，发现损坏链接或逃出运行时根目录的链接时立即终止构建。修改依赖布局
或归档语义时必须同时升级 `archiveFormatVersion`，避免复用旧格式的已发布资产。

任务、项目空间和智能体三个固定 Tab 共享一个 Core DSH 进程。智能工作台 App
Tab 使用独立 Workbench DSH 进程；关闭 Tab 必须终止对应进程。

Smart app 验证使用独立的空凭据文件，兼容新旧运行时的凭据格式。
验证脚本仅在应用项目中执行，不触发父工作区的依赖安装；验证进程退出时必须清理。
Remote 模板使用新版 Typert `create()` 编解码器工厂，实际验证 `health.ping` 往返。
独立 HTTP 探测只接收当前隔离运行时的会话 Cookie，并从输出日志中移除该凭据；
探测结束后才关闭运行时并删除临时目录。

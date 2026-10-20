---
sidebar_position: 13
---

# Wework DSH Runtime

该目录定义 Wework 使用的可复现 DeepSeek Harness 多版本运行时。它不是用户的
`~/.dsh`，也不会读取或修改个人 Profile。

## 运行时角色

- Core Runtime：`0.2.0-rc.2`，随 Electron 安装包内置。
- Workbench Runtime：默认 `0.2.0-rc.2`，供智能工作台动态 Tab 启动独立 DSH
  进程。安装包只携带默认版本归档；旧版 `0.1.0-rc.8` 按应用 manifest 的版本要求下载。
- 同一版本通过清单中的 `wework.runtimeRoles` 声明角色，共用一份归档及不可变的物化目录。
  目录索引保留各角色的独立记录，并指向相同的资产名、指纹和校验和；不再按角色重复打包。
- 默认版本在 `runtimes/<version>` 中拥有精确依赖和锁文件；旧版本通过
  `published-runtimes.json` 固定各平台已发布归档的描述，不再随构建机重建。
- 普通 Core 插件管理关闭客户端热重载，安装、启停和卸载后通过显式重启生效；
  插件开发模式单独开启热重载，避免依赖安装重写文件元数据时意外重建桌面界面。
- `wework/scripts/prepare-harness-runtime.mjs` 为默认版本生成不可变运行时资产，并保留旧版已发布资产的固定描述。

归档的 `runtime.json` 通过 `roles` 数组声明支持的角色，发布用的归档描述不包含单个角色。
Core 启动时从独立的核心插件组件加载 `@wegent/dsh-app-wework`、
`@wegent/dsh-electron-host` 和 `@wegent/dsh-executor-runtime`。
它必须通过真实 executor、本地/云 transport、Host pipe 和 Renderer service 的完整联调。

Workbench 不复制上述三个核心插件。共享归档只共享不可变依赖，不共享用户 Profile、
会话、凭据或进程。每个活动工作台 App Tab 使用一个独立 DSH 进程，只验证安装、启动、页面可达、View 嵌入、关闭
清理和凭据隔离，不重复 Core executor 全链路。

## 准备与物化

安装包的 `runtimes.json` 用 `runtimes` 记录内置默认版本，用
`downloadableRuntimes` 记录可下载旧版本的精确版本、源指纹、归档大小、SHA-256 和 URL。
Core 启动只物化内置版本；应用启动、项目脚本及隔离验证按 `requirements.dsh`
选择清单中满足要求的最高版本，只准备该版本。清单之外的版本直接报错。

归档默认从 `https://github.com/wecode-ai/Wegent/releases/download/wework-updater/`
下载，文件名为 `harness-runtime-<平台>-<架构>-dsh-<版本>-<源指纹>.tar.gz`。
构建时可通过 `WEWORK_HARNESS_RUNTIME_BASE_URL` 设置地址，运行时使用清单中的固定 URL，
不查找浮动的 latest。`published-runtimes.json` 固定已有资产，避免构建机签名身份改变旧版指纹。
构建只准备默认版本归档，发布流程上传默认版本供将来复用；已固定的旧版本保持在原 Release，
无需重新构建、下载或上传，也不进入安装包或 Core DSH 组件。

下载只允许 HTTPS，流式检查大小和 SHA-256，通过后才发布归档缓存并解压。
连续 60 秒没有下载进展会中止；宿主的应用启动和验证请求使用 15 分钟预算，普通请求仍使用原预算。
归档缓存位于运行时缓存根目录的 `archives/`，解压目录仍按源指纹隔离。
相同源指纹的并发请求共用一次准备过程；已物化的版本可离线复用，重新解压前会再次校验
缓存归档，损坏归档会重新下载。失败会清理临时文件并报告错误，后续请求可重新尝试。

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

新版 DSH 需要浏览器认证。内置 `wework-browser-auth` 插件通过继承的匿名管道（FD 5）把启动认证 URL 交给 Electron；Electron 在探测页面前建立浏览器会话。凭据不进入应用 URL、安装记录或公开 HTTP 接口。旧版 Workbench 保持原有启动方式。

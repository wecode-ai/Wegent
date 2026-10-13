---
sidebar_position: 36
---

# Wework DSH 运行时升级与验证

Wework Core、内置 DSH 插件和新 Smart app 模板使用官方 `0.2.0-rc.2`。
既有 Smart app 根据 manifest 中的 DSH 版本运行；`0.1.0-rc.8` 首次使用时下载，
校验归档大小、SHA-256 和运行时身份后缓存，后续可离线运行。旧运行时不随安装包分发。

构建时实际查询打包 Executor 的 Workbench schema，并将响应写入组件描述。
启动时必须同时验证 schema 和二进制内容哈希；只允许相同内容的 Executor 使用
这份响应。旧组件未携带响应时，可在实际内容哈希相同的前提下使用打包响应；
不同内容的自定义 Executor 仍执行只读 schema 查询。
不兼容或校验失败时禁止迁移 Home。在线组件发布必须保留 schema 响应和内容哈希。
共享 E2E 归档必须保留打包 Executor 的原始字节，不得在生成证明后再次 strip；
归档发布前校验实际 Executor 与组件描述的内容哈希。

主窗口只加载自己的首屏依赖。弹出窗口页面按需加载；服务函数、翻译器和小组件
直接引用协作包的具体模块，避免通过总入口提前加载协作页面。组件组合与只读
Executor 兼容性校验并行执行，但必须全部完成后才返回启动路径。Node 和 CLI
准备与组件准备并行，Home 迁移仍在兼容性校验之后进行。

浏览器认证只交换一次 token。Electron 将 DSH 响应的 Set-Cookie 保存到原有浏览器
分区，保留 Cookie 的域、路径、有效期、Secure、HttpOnly 和 SameSite 属性。

`dsh-runtime-upgrade` 桌面 E2E 验证冷启动和重启均严格小于 5 秒，并覆盖旧配置、
旧应用首次下载与离线重启、新模板、停止应用及进程清理。运行时归档由真实 HTTP
服务提供；Linux 和 Windows CI 需要在共享构建产物中传递测试服务使用的归档，
不能依赖构建用户的私有缓存，也不能将这些测试资源混入正式发行包。
Windows 的启动预算使用 release Executor。Executor 通过原生注册表 API 读取并展开
机器和用户 PATH，保留父进程路径优先级，不在启动时创建 PowerShell 进程。
Windows CI 对比原生读取和 .NET 的实际结果，并验证缺失值不阻止启动。普通用户测试进程的 `PNPM_HOME` 和
pnpm store 必须属于该测试账户，不能继承 CI 管理员的包存储；测试日志实时输出，
以便在进程卡住或诊断包上传失败时保留失败证据。
插件市场注册验证应解析 TOML 后比较市场类型和完整路径；合法的 Windows 单引号
路径不能因为与 JSON 双引号格式不同而被拒绝。精简 Linux E2E 产物须包含
Socket.IO 客户端和 TOML 解析器的独立构建，不依赖测试容器的 `node_modules`。

切换稳定版或测试版更新渠道后，Electron 更新器必须明确禁止自动降级，避免较旧
发行版下载和重启提示干扰当前应用。抽屉动画 E2E 在隔离 Electron 中明确设置
`prefers-reduced-motion: no-preference`，保持生产环境对系统减少动画设置的支持。

内存 E2E 在相同任务和终端界面采样前后内存。Markdown 预渲染距离最多为一个
实际滚动视口，并保留长代码块和快速滚动时的同步渲染。不得通过增大启动或内存
预算、跳过断言或重复运行掩盖失败。

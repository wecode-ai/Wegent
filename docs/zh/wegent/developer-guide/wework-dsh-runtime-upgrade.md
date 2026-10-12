---
sidebar_position: 36
---

# Wework DSH 运行时升级与验证

Wework Core、内置 DSH 插件和新 Smart app 模板使用官方 `0.2.0-rc.2`。
既有 Smart app 根据 manifest 中的 DSH 版本运行；`0.1.0-rc.8` 首次使用时下载，
校验归档大小、SHA-256 和运行时身份后缓存，后续可离线运行。旧运行时不随安装包分发。

构建时实际查询打包 Executor 的 Workbench schema，并将响应写入组件描述。
启动时必须同时验证 schema 和二进制内容哈希；只允许相同内容的 Executor 使用
这份响应。未携带响应的旧组件或自定义 Executor 仍执行只读 schema 查询。
不兼容或校验失败时禁止迁移 Home。在线组件发布必须保留 schema 响应和内容哈希。

浏览器认证只交换一次 token。Electron 将 DSH 响应的 Set-Cookie 保存到原有浏览器
分区，保留 Cookie 的域、路径、有效期、Secure、HttpOnly 和 SameSite 属性。

`dsh-runtime-upgrade` 桌面 E2E 验证冷启动和重启均严格小于 5 秒，并覆盖旧配置、
旧应用首次下载与离线重启、新模板、停止应用及进程清理。运行时归档由真实 HTTP
服务提供；Linux 和 Windows CI 需要在共享构建产物中传递测试服务使用的归档，
不能依赖构建用户的私有缓存，也不能将这些测试资源混入正式发行包。

内存 E2E 在相同任务和终端界面采样前后内存。Markdown 预渲染距离最多为一个
实际滚动视口，并保留长代码块和快速滚动时的同步渲染。不得通过增大启动或内存
预算、跳过断言或重复运行掩盖失败。

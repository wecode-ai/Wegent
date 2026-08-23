# Wework Electron Host 插件

这个 DeepSeek Harness 宿主侧插件通过两条继承的私有管道连接 DSH 进程与
Electron 主进程，并向第一方 Wework DSH 应用提供带版本的、仅限回环地址的
HTTP 载体。

该插件只属于内置 Core Runtime `0.1.1-rc.2`。Workbench Runtime
`0.1.0-rc.8` 不携带它，也不会获得 Electron Host pipe。Electron 新架构不再
支持 `0.1.0-rc.7`。

插件在当前 Cordis generation 内提供类型化的 `ctx.weworkDesktop` Host
service。它只暴露按领域分组的窄能力，不暴露 Electron 对象、文件描述符或鉴权
token。旧 generation 卸载后，保留的 service 引用会立即拒绝调用。

Renderer 不能直接读取 Host Cordis service。浏览器侧仍通过同源 HTTP
route 调用同一套 capability，后续由产品插件封装 client adapter。

同一 DSH 页面中的浏览器插件共享 origin 和 JavaScript 信任域。因此 HTTP
载体可以阻止跨源浏览器访问，但不能声称隔离同一 DSH 组合内安装的不同插件。
第一方桌面 Profile 不得安装不受信任的插件。

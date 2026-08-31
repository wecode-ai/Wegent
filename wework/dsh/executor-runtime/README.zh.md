# Wework DSH Executor Runtime

该插件是 Wework 产品 DSH App 的统一执行面。浏览器侧只访问版本化同源接口，
不会接触 Electron IPC、executor stdio 或 bearer token。

当前物理 transport 接入迁移期的 Electron loopback relay；逻辑 client、结构化
错误、事件序号、有限 ring buffer 和断线续传接口已经固定。后续替换成本地
Unix Domain Socket / Windows Named Pipe 和云 runtime relay 时，不改变产品 App
接口。

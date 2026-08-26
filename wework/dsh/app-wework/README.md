# Wework DSH App

`@wegent/dsh-app-wework` 是 Wework 的第一方模块化单体产品插件。

当前版本在同一个 DSH client context 中注册三个不可关闭的固定 Tab：

- 任务
- 项目空间
- 智能体

智能工作台及其动态 Tab 也由同一插件管理。固定 Tab、动态 Tab、active route、
`WorkbenchBinding` 和 Codex thread 写 lease 持久化在 DSH 页面所属的本地存储中，
不会触发任务或 turn 重放。

Electron 只承载一个主 DSH `WebContentsView`。Wework 内置浏览器、文件选择器、
原生窗口和系统菜单等宿主能力继续由 Electron 实现；本插件后续只通过受限
desktop capability 调用这些能力。

该包必须显式导出 `./package.json`。DSH client module registry 通过这个子路径读取
`dsh.client` 声明；缺少导出会导致插件不进入 browser boot graph。

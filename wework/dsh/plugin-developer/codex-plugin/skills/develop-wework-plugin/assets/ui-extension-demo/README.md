# Wework DSH 扩展 Demo

这是“Wework 插件开发”Skill 携带的可运行 Core DSH 插件示例，覆盖 Wework
当前公开的全部 UI 扩展点。模型可以复制该目录作为实现参考；桌面应用不会自动启用
它。

先把该目录复制到可写的项目目录，再在 Wework 的“插件 → 管理 → Wework 插件”中
输入复制后目录的绝对路径，例如：

```text
file:/absolute/path/to/ui-extension-demo
```

安装完成后重启 Core DSH。左侧会出现 `DSH Demo`，应用切换器、设置页、Composer、
工作区工具栏、底部面板、新建工作区 Tab 菜单和全局 overlay 也会出现对应示例。
示例还注册了一个可从 Composer、工作区工具栏以及 `Command+Shift+D`
（Windows/Linux 为 `Ctrl+Shift+D`）触发的统一命令，并演示上下文条件、配置和
持久化状态。
停用或卸载插件并重启后，所有贡献会随同一 DSH 生命周期一起移除。

关键文件：

- `package.json` 声明 DSH bundle、client 依赖和浏览器平台。
- `cordis.patch.yml` 把插件加入 DSH Loader 树。
- `index.js` 是 host 入口；纯 UI 插件可以保持为空。
- `client.js` 通过 `ctx.wework` 注册命令、菜单、快捷键、配置与状态，并通过
  `ctx.wework.contributions` 注册宿主描述、通过原生 `ctx.slots.register`
  注册自定义 UI。
- 左侧 `DSH Demo` 入口通过公开的 `workspaceTab` 路由参数首次创建独立 Tab，
  后续点击复用同一个 Tab，不会覆盖用户当前正在使用的 Tab。

生产插件应更换包名、ID、文案和样式，并只注册实际需要的扩展点。

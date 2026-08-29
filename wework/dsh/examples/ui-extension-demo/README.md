# Wework DSH 扩展 Demo

这是一个可直接安装的第三方 Core DSH 插件示例，覆盖 Wework 当前公开的全部 UI
扩展点。它不是 Wework 内置插件，也不会随桌面安装包启用。

在 Wework 的“插件 → 管理 → Wework 插件”中输入该目录的绝对路径，或输入：

```text
file:/absolute/path/to/Wegent/wework/dsh/examples/ui-extension-demo
```

安装完成后重启 Core DSH。左侧会出现 `DSH Demo`，应用切换器、设置页、新建工作区
Tab 菜单和全局 overlay 也会出现对应示例。停用或卸载插件并重启后，所有贡献会随
同一 DSH 生命周期一起移除。

关键文件：

- `package.json` 声明 DSH bundle、client 依赖和浏览器平台。
- `cordis.patch.yml` 把插件加入 DSH Loader 树。
- `index.js` 是 host 入口；纯 UI 插件可以保持为空。
- `client.js` 通过 `slots.inject` 和 `ctx.wework.ui.register` 注册 UI。

生产插件应更换包名、ID、文案和样式，并只注册实际需要的扩展点。

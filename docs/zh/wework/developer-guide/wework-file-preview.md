---
sidebar_position: 34
---

# 工作区文件预览

Wework 文件面板使用 Markdown 渲染器预览 Markdown 文档，将其他代码和文本文件交给 Pierre CodeView，并将二进制文件交给 Flyfish Viewer 的浏览器端渲染器。预览数据只从已授权的本地工作区读取，不会上传到第三方服务。

## 支持范围

预览器启用 office、lite 和 engineering 能力：PDF、Word、Excel、PowerPoint、图片、HTML、Markdown、代码、音频、视频，以及 Mermaid 和 PlantUML 图表。未知格式或渲染失败时，macOS Tauri 应用可使用系统默认应用打开文件。

HTML 必须继续使用沙箱预览，不得允许预览内容访问 Wework 主页面的同源状态。

## 图表预览和导出

`.mermaid`、`.mmd`、`.plantuml` 和 `.puml` 文件使用与对话内代码块相同的图表渲染器。预览必须跟随 Wework 当前明暗主题，并在面板尺寸变化时等比例适配，不能裁掉 SVG 边缘。

图表预览提供复制和保存操作。复制会生成 PNG 并通过桌面原生命令写入系统剪贴板；保存会打开系统保存窗口并将 PNG 写入用户选择的位置。Mermaid 的 HTML 标签在导出阶段转换为纯 SVG 文本，避免 macOS WebView 因 `foreignObject` 将 Canvas 标记为不可导出。

PlantUML 默认从 `https://www.plantuml.com/plantuml/svg` 请求 SVG。部署方可以通过运行时配置 `plantumlServerUrl` 或构建环境变量 `VITE_WEWORK_PLANTUML_SERVER_URL` 指向自托管服务；地址应包含 PlantUML 的 SVG 路径。

## Markdown 预览

`.md` 和 `.markdown` 文件默认显示渲染后的文档，并提供“源码/预览”切换。源码模式继续支持代码行选择和本地评论，但不得渲染 Pierre 的文件标题栏；文件路径只由文件面板工具栏显示，避免滚动时出现重复的粘滞标题和闪烁。

Markdown 预览和源码视图都必须拥有独立的纵向滚动区域。软滚动条使用透明轨道和具有足够对比度的灰色滑块，使滚动位置始终可辨认。

## 数据传输

本机工作区的目录枚举、文本读取和二进制分块读取由 Wework Tauri 进程直接访问磁盘，不经过 executor IPC。文本最多读取 256 KiB，二进制通过 `read_local_workspace_file_chunk` 以 1 MiB 分块读取。每个请求都携带工作区根目录并在 Rust 侧执行规范化路径校验，拒绝通过符号链接或相对路径逃逸工作区。前端按顺序组装二进制分块为 `File` 后交给查看器。

通过远端设备打开工作区时仍使用设备侧 workspace API。前端继续校验响应路径、文件名和分块偏移，不能把本机原生命令作为远端读取失败时的回退路径。

本机原生命令 `read_local_workspace_text_file` 会返回 `editable` 和 `revision`；远端设备对应使用 executor IPC 的 `workspace_read_text_file`。只有未截断且可按 UTF-8 解码的文本文件可以进入编辑模式；二进制、超出 256 KiB 的文本和解码失败的文件只能预览。

保存仍由 Rust executor 通过 `workspace_write_text_file` 实现，因为写入需要沿用任务工作区的并发修改检查和原子替换语义。IPC 载荷携带文件内容、文件名和读取时得到的 `revision`。executor 在写入前重新读取磁盘文件并比对 SHA-256 revision；如果文件已被外部修改，保存会失败，前端必须阻止覆盖并提示用户重新加载。写入必须限制在同一工作区根目录内，并通过同目录临时文件原子替换目标文件。通过远端设备打开的文件仍然只能预览。

## 预览状态生命周期

文件面板应按工作区目标的 `deviceId`、`path`、`source`、`taskId` 和 `workspaceSource` 判断工作区是否变化。任务流式更新或后台轮询可能创建字段相同的新目标对象；这种引用变化不得清空目录树、重新读取文件或卸载当前预览。只有目标字段实际变化、用户选择其他文件或主动刷新时才重新加载对应数据。

## 构建资源

`@file-viewer/vite-plugin` 负责在开发和生产构建中复制选中渲染器的 Worker、WASM、字体和其他离线资源。安装 `preset-office`、`preset-lite` 和 `preset-engineering`，但不要使用 `preset-all`，除非产品明确需要全部重型格式。Vite 必须预构建 Mermaid 和 PlantUML 编码依赖，确保 drawing renderer 的动态导入在 WebKit 开发环境中稳定解析。

## 验证

修改预览器时至少验证 Markdown 的默认预览、源码切换、长文档滚动和单一标题栏，以及 PDF、DOCX、XLSX、CSV、PPTX、PNG/JPEG/WebP、HTML、Mermaid、PlantUML、切换文件、取消加载、目录树展开、符号链接工作区和工作区边界拒绝行为。图表还必须覆盖明暗主题、完整 SVG 自适应、复制 PNG 和系统保存窗口。还应在任务流式更新期间持续观察已打开的文本预览，确认等价工作区目标重新渲染时不会重复读取或闪烁。

---
sidebar_position: 34
---

# 工作区文件预览

Wework 文件面板使用 Markdown 渲染器预览 Markdown 文档，将其他代码和文本文件交给 Pierre CodeView，并将二进制文件交给 Flyfish Viewer 的浏览器端渲染器。预览数据只从已授权的本地工作区读取，不会上传到第三方服务。

## 支持范围

预览器启用 office、lite 和 engineering 能力：PDF、Word、Excel、PowerPoint、图片、HTML、Markdown、代码、音频、视频，以及 Mermaid 和 PlantUML 图表。代码和文本预览不得以扩展名白名单作为能力边界：常见扩展名（包括 Dart）直接进入文本读取快速路径；未知扩展名先探测文件内容，只要内容是有效 UTF-8 文本且不包含二进制控制字节，就使用代码预览。已知二进制格式继续直接进入专用渲染器；未知二进制或渲染失败时，macOS Electron 应用可使用系统默认应用打开文件。

HTML 必须继续使用沙箱预览，不得允许预览内容访问 Wework 主页面的同源状态。

## 图片预览

PNG、JPEG、WebP、GIF、BMP、AVIF、TIFF 和 SVG 图片使用 Flyfish Viewer 的图片渲染器。查看器容器必须显式接收 Wework 当前的明暗主题，图片周围的画布使用 Wework 语义背景色。渲染器不得为图片元素强制填充白色背景；带透明通道的图片应直接显示在当前主题背景上，全屏图片预览遵循相同规则。

## 图表预览和导出

`.mermaid`、`.mmd`、`.plantuml` 和 `.puml` 文件使用与对话内代码块相同的图表渲染器。预览必须跟随 Wework 当前明暗主题，并在面板尺寸变化时等比例适配，不能裁掉 SVG 边缘。

Mermaid 可能通过 SVG `foreignObject` 生成包含 `<br>` 的 HTML 标签。渲染器必须启用 Mermaid 严格安全级别，按 HTML 语义解析输出后再导入 SVG；不能先按严格 XML 重解析，否则浏览器序列化后的非自闭合 HTML 标签会触发 XML 标签不匹配。导入前必须移除可执行或可提交内容的元素、根节点及后代元素上的事件处理属性、外部资源属性、不安全 URL 协议和非本地图形引用；仅保留 `#id` 形式的本地 `href` 引用。PlantUML 输出仍按严格 SVG/XML 解析。

图表预览提供复制和保存操作。复制会生成 PNG 并通过桌面原生命令写入系统剪贴板；保存会打开系统保存窗口并将 PNG 写入用户选择的位置。Mermaid 的 HTML 标签在导出阶段转换为纯 SVG 文本，避免 macOS WebView 因 `foreignObject` 将 Canvas 标记为不可导出。

PlantUML 默认从 `https://www.plantuml.com/plantuml/svg` 请求 SVG。部署方可以通过运行时配置 `plantumlServerUrl` 或构建环境变量 `VITE_WEWORK_PLANTUML_SERVER_URL` 指向自托管服务；地址应包含 PlantUML 的 SVG 路径。

## Markdown 预览

`.md` 和 `.markdown` 文件默认显示渲染后的文档，并提供“源码/预览”切换。源码模式继续支持代码行选择和本地评论，但不得渲染 Pierre 的文件标题栏；文件路径只由文件面板工具栏显示，避免滚动时出现重复的粘滞标题和闪烁。

Markdown 预览和源码视图都必须拥有独立的纵向滚动区域。软滚动条使用透明轨道和具有足够对比度的灰色滑块，使滚动位置始终可辨认。

Markdown 代码块保持不换行时，必须显示不依赖操作系统覆盖式滚动条设置的横向滚动条。滑块宽度应反映当前可见范围，并支持拖动到长代码行末尾；流式输出期间继续隐藏滑块，输出完成后再显示。

## 数据传输

本机工作区的目录枚举、文本读取和二进制分块读取由 Wework Electron 进程直接访问磁盘，不经过 executor IPC。文本最多读取 256 KiB，二进制通过 `read_local_workspace_file_chunk` 以 1 MiB 分块读取。未知扩展名使用首个分块探测内容；如果判定为二进制，首个分块必须直接复用于后续组装，不能重复读取。项目空间中的云文件已经下载为 `Blob`，未知类型只检查前 64 KiB。每个工作区请求都携带工作区根目录并在 Rust 侧执行规范化路径校验，拒绝通过符号链接或相对路径逃逸工作区。前端按顺序组装二进制分块为 `File` 后交给查看器。

通过远端设备打开工作区时仍使用设备侧 workspace API。前端继续校验响应路径、文件名和分块偏移，不能把本机原生命令作为远端读取失败时的回退路径。

本机原生命令 `read_local_workspace_text_file` 会返回 `editable` 和 `revision`；远端设备对应使用 executor IPC 的 `workspace_read_text_file`。只有未截断且可按 UTF-8 解码的文本文件可以进入编辑模式；二进制、超出 256 KiB 的文本和解码失败的文件只能预览。

保存仍由 Rust executor 通过 `workspace_write_text_file` 实现，因为写入需要沿用任务工作区的并发修改检查和原子替换语义。IPC 载荷携带文件内容、文件名和读取时得到的 `revision`。executor 在写入前重新读取磁盘文件并比对 SHA-256 revision；如果文件已被外部修改，保存会失败，前端必须阻止覆盖并提示用户重新加载。写入必须限制在同一工作区根目录内，并通过同目录临时文件原子替换目标文件。通过远端设备打开的文件仍然只能预览。

## 预览耗时诊断

桌面应用会把单次文件链接点击和后续预览操作关联到同一个 `traceId`，并将诊断事件写入 Electron 日志目录下的 `file-preview.log`。日志采用 2 MiB 上限并保留两个轮转文件，只记录文件扩展名、路径长度、文件大小、分块数量、阶段和耗时，不记录完整路径、文件内容或凭据。

排查“点击后右侧面板迟迟不出现”时，按同一 `traceId` 检查以下阶段：

1. `message_link_click` 到 `filesystem_stat_end`：在打开右侧面板前判断目标是文件还是目录。
2. `open_file_request_queued` 到 `open_file_request_effect`：文件请求从工作台状态进入文件面板。
3. `parent_tree_start` 到 `parent_tree_end`：读取父目录并确认目标条目。
4. `file_chunk_start` 到 `file_chunk_end`：读取一个二进制分块。
5. `base64_decode_end` 和 `file_constructed`：在 renderer 中解码分块、复制字节并构造浏览器 `File`。
6. `binary_preview_state_queued` 到 `binary_preview_committed`：React 接收预览状态并提交二进制预览。
7. `file_viewer_react_commit`：记录 Flyfish Viewer 的 React commit 耗时和查看器类型。

每个关键阶段后还会安排一个零延迟定时器，并通过 `renderer_queue_probe.lagMs` 测量 renderer 事件队列延迟；达到 50 ms 时记录 `blocked: true`。如果前一阶段已经结束，但该探针明显延后，说明同步 JavaScript、布局、绘制或其它 renderer 长任务正在阻塞队列。`preview_loading_clear_skipped` 表示当前请求已被后续文件请求替换，应按请求竞态排查，而不是把它解释为单次读取未结束。

当读取经过 executor App IPC 时，`executor.log` 会为对应请求记录 `command_key`、处理耗时、响应字节数和 `queue_wait_ms`。`app IPC request finished` 很快但 `app IPC response queued.queue_wait_ms` 很大，表示响应写入队列存在背压；executor 已快速入队但前端的 `file_chunk_end` 明显延后，则继续检查 IPC 传输和 renderer 消息消费。

## 预览状态生命周期

文件面板应按工作区目标的 `deviceId`、`path`、`source`、`taskId` 和 `workspaceSource` 判断工作区是否变化。任务流式更新或后台轮询可能创建字段相同的新目标对象；这种引用变化不得清空目录树、重新读取文件或卸载当前预览。只有目标字段实际变化、用户选择其他文件或主动刷新时才重新加载对应数据。

Pierre CodeView 的 `items`、`options`、`selectedLines` 和选择回调也是预览生命周期的一部分。父级工作台因消息流、状态轮询或加载状态发生无关重渲染时，这些输入必须保持引用稳定；不能用每次渲染新建的对象或函数触发 CodeView 强制重绘。强制重绘会替换 Shadow DOM 文本节点并清除浏览器原生文本选区，导致用户刚选中的代码在几秒后消失。只有文件内容、目标行、主题或真实选择状态变化时才更新相应输入。

## 构建资源

`@file-viewer/vite-plugin` 负责在开发和生产构建中复制选中渲染器的 Worker、WASM、字体和其他离线资源。安装 `preset-office`、`preset-lite` 和 `preset-engineering`，但不要使用 `preset-all`，除非产品明确需要全部重型格式。Vite 必须预构建 Mermaid 和 PlantUML 编码依赖，确保 drawing renderer 的动态导入在 Chromium 开发环境中稳定解析。

## 验证

修改预览器时至少验证 Markdown 的默认预览、源码切换、长文档滚动、长代码行横向滚动和单一标题栏，以及 Dart、未知扩展名的 UTF-8 源码、未知扩展名的二进制文件、PDF、DOCX、XLSX、CSV、PPTX、PNG/JPEG/WebP、HTML、Mermaid、PlantUML、切换文件、取消加载、目录树展开、符号链接工作区和工作区边界拒绝行为。Markdown 长代码行验证必须分别确认流式输出期间隐藏滑块，以及输出完成后滑块持续可见、尺寸与溢出比例一致，并可拖动到行尾。未知二进制文件还必须验证探测分块不会重复读取。图片必须覆盖明暗主题和透明通道，确认预览画布及透明区域不会残留渲染器的浅色背景。图表还必须覆盖明暗主题、包含 HTML 换行标签的 Mermaid、危险元素和事件属性清理、完整 SVG 自适应、复制 PNG 和系统保存窗口。还应在任务流式更新期间持续观察已打开的文本预览，确认等价工作区目标重新渲染时不会重复读取或闪烁；真实桌面 E2E 必须在后台消息持续更新时选中文本、等待多次工作台刷新，并断言浏览器原生选区仍然存在。

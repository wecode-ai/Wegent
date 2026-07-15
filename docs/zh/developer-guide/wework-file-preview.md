---
sidebar_position: 34
---

# 工作区文件预览

Wework 文件面板将代码和文本文件交给 Pierre CodeView，将二进制文件交给 Flyfish Viewer 的浏览器端渲染器。预览数据只从已授权的本地工作区读取，不会上传到第三方服务。

## 支持范围

首批预览器启用 office 和 lite 能力：PDF、Word、Excel、PowerPoint、图片、HTML、Markdown、代码、音频和视频。未知格式或渲染失败时，macOS Tauri 应用可使用系统默认应用打开文件。

HTML 必须继续使用沙箱预览，不得允许预览内容访问 Wework 主页面的同源状态。

## 数据传输

二进制文件通过 `workspace_read_file_chunk` 命令以 1 MiB 分块读取。每个请求仍使用工作区根目录校验，并拒绝符号链接或路径逃逸。前端按顺序组装为 `File` 后交给查看器；代码和文本继续使用 `workspace_read_text_file`，避免无意义的二进制传输。

`workspace_read_text_file` 会返回 `editable` 和 `revision`。只有未截断且可按 UTF-8 解码的文本文件可以进入编辑模式；二进制、超出 256 KiB 的文本和解码失败的文件只能预览。

保存是由 Rust executor 通过 `workspace_write_text_file` 实现的 Wework 本地 IPC 能力，不注册为 Backend 命令。IPC 载荷携带文件内容、文件名和读取时得到的 `revision`。executor 在写入前重新读取磁盘文件并比对 SHA-256 revision；如果文件已被外部修改，保存会失败，前端必须阻止覆盖并提示用户重新加载。写入必须限制在同一工作区根目录内，并通过同目录临时文件原子替换目标文件。通过远端设备打开的文件仍然只能预览。

## 预览状态生命周期

文件面板应按工作区目标的 `deviceId`、`path`、`source`、`taskId` 和 `workspaceSource` 判断工作区是否变化。任务流式更新或后台轮询可能创建字段相同的新目标对象；这种引用变化不得清空目录树、重新读取文件或卸载当前预览。只有目标字段实际变化、用户选择其他文件或主动刷新时才重新加载对应数据。

## 构建资源

`@file-viewer/vite-plugin` 负责在开发和生产构建中复制选中渲染器的 Worker、WASM、字体和其他离线资源。只安装 `preset-office` 和 `preset-lite`；不要使用 `preset-all`，除非产品明确需要 CAD、3D、归档或其他重型格式。

## 验证

修改预览器时至少验证 PDF、DOCX、XLSX、CSV、PPTX、PNG/JPEG/WebP 和 HTML，以及切换文件、取消加载、目录树展开和工作区边界拒绝行为。还应在任务流式更新期间持续观察已打开的文本预览，确认等价工作区目标重新渲染时不会重复读取或闪烁。

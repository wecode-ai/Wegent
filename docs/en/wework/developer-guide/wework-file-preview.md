---
sidebar_position: 34
---

# Workspace File Preview

The Wework file panel renders Markdown documents as formatted content, sends other code and text files to Pierre CodeView, and sends binary files to Flyfish Viewer browser-side renderers. Preview data is read only from authorized local workspaces and is never uploaded to third-party services.

## Supported Formats

The viewer enables the office, lite, and engineering capabilities: PDF, Word, Excel, PowerPoint, images, HTML, Markdown, code, audio, video, Mermaid, and PlantUML diagrams. Unknown formats or rendering failures can be opened with the system default application in the macOS Tauri app.

HTML must remain sandboxed and must not allow preview content to access Wework's same-origin state.

## Diagram Preview and Export

`.mermaid`, `.mmd`, `.plantuml`, and `.puml` files use the same diagram renderer as code blocks in conversations. The preview must follow the active Wework light or dark theme and fit proportionally when the panel changes size without clipping SVG edges.

Diagram previews provide copy and save actions. Copy generates a PNG and writes it to the system clipboard through a native desktop command. Save opens the system save dialog and writes the PNG to the location selected by the user. During Mermaid export, HTML labels are converted to pure SVG text so the macOS WebView does not mark a Canvas containing `foreignObject` as non-exportable.

PlantUML requests SVG from `https://www.plantuml.com/plantuml/svg` by default. Deployments can point to a self-hosted service through the `plantumlServerUrl` runtime setting or the `VITE_WEWORK_PLANTUML_SERVER_URL` build environment variable. The URL should include the PlantUML SVG path.

## Markdown Preview

`.md` and `.markdown` files open as rendered documents by default and provide a Source/Preview switch. Source mode continues to support line selection and local comments, but it must not render Pierre's file header. The file path appears only in the file-panel toolbar so scrolling cannot produce a duplicate sticky header or flicker.

Both the Markdown preview and source view must own a vertical scrolling region. The soft scrollbar uses a transparent track and a sufficiently contrasting gray thumb so the current scroll position remains visible.

## Data Transfer

Binary files are read through `workspace_read_file_chunk` in 1 MiB chunks. Every request keeps workspace-root validation and rejects escapes through symlinks or relative paths. The workspace itself may be opened through a symlink path; when the executor returns a canonical filesystem path, the frontend maps directory entries and file responses back to the workspace path selected by the user while continuing to validate response paths, file names, and chunk offsets. The frontend assembles chunks into a `File` for the viewer; code and text continue to use `workspace_read_text_file` to avoid unnecessary binary transfer.

`workspace_read_text_file` returns `editable` and `revision`. Only untruncated files that decode as UTF-8 can enter edit mode; binary files, text larger than 256 KiB, and decode failures remain preview-only.

Saving is a local Wework IPC capability implemented by the Rust executor through `workspace_write_text_file`; it is not registered as a Backend command. The IPC payload carries the file content, file name, and the `revision` returned by the read command. Before writing, the executor rereads the file on disk and compares the SHA-256 revision. If another process changed the file, saving fails and the frontend must block the overwrite and offer reload. Writes must stay inside the same workspace root and replace the target through a same-directory temporary file. Files opened through remote devices remain preview-only.

## Preview State Lifecycle

The file panel determines workspace changes from the target's `deviceId`, `path`, `source`, `taskId`, and `workspaceSource`. Task streaming and background polling may create new target objects with the same fields; reference-only changes must not clear the directory tree, reread the file, or unmount the current preview. Reload data only when the target fields actually change, the user selects another file, or the user explicitly refreshes.

## Build Assets

`@file-viewer/vite-plugin` copies selected renderer Workers, WASM, fonts, and other offline assets for development and production. Install `preset-office`, `preset-lite`, and `preset-engineering`, but do not use `preset-all` unless every heavy format is explicitly required. Vite must prebundle the Mermaid and PlantUML encoding dependencies so the drawing renderer's dynamic imports resolve consistently in the WebKit development environment.

## Validation

When changing the viewer, validate Markdown's default preview, source switching, long-document scrolling, and single-header behavior, plus PDF, DOCX, XLSX, CSV, PPTX, PNG/JPEG/WebP, HTML, Mermaid, PlantUML, file switching, cancellation, directory expansion, symlinked workspaces, and workspace-boundary rejection. Diagram coverage must include light and dark themes, complete SVG fitting, PNG copy, and the system save dialog. Also observe an open text preview during task streaming and confirm that rerenders with an equivalent workspace target neither reread nor flicker the preview.

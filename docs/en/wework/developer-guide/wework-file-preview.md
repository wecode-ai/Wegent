---
sidebar_position: 34
---

# Workspace File Preview

The Wework file panel renders Markdown documents as formatted content, sends other code and text files to Pierre CodeView, and sends binary files to Flyfish Viewer browser-side renderers. Preview data is read only from authorized local workspaces and is never uploaded to third-party services.

## Supported Formats

The viewer enables the office, lite, and engineering capabilities: PDF, Word, Excel, PowerPoint, images, HTML, Markdown, code, audio, video, Mermaid, and PlantUML diagrams. Code and text preview must not use an extension allowlist as its capability boundary. Common extensions, including Dart, enter the text-read fast path directly. Unknown extensions are inspected by content and use the code preview when they contain valid UTF-8 text without binary control bytes. Known binary formats continue directly to their specialized renderers. Unknown binary formats or rendering failures can be opened with the system default application in the macOS Tauri app.

HTML must remain sandboxed and must not allow preview content to access Wework's same-origin state.

## Image Preview

PNG, JPEG, WebP, GIF, BMP, AVIF, TIFF, and SVG images use Flyfish Viewer's image renderer. The viewer container must receive Wework's active light or dark theme explicitly, and the canvas around the image uses Wework's semantic background color. The renderer must not force a white background onto image elements: images with an alpha channel render directly over the active theme background, including in the full-screen image preview.

## Diagram Preview and Export

`.mermaid`, `.mmd`, `.plantuml`, and `.puml` files use the same diagram renderer as code blocks in conversations. The preview must follow the active Wework light or dark theme and fit proportionally when the panel changes size without clipping SVG edges.

Diagram previews provide copy and save actions. Copy generates a PNG and writes it to the system clipboard through a native desktop command. Save opens the system save dialog and writes the PNG to the location selected by the user. During Mermaid export, HTML labels are converted to pure SVG text so the macOS WebView does not mark a Canvas containing `foreignObject` as non-exportable.

PlantUML requests SVG from `https://www.plantuml.com/plantuml/svg` by default. Deployments can point to a self-hosted service through the `plantumlServerUrl` runtime setting or the `VITE_WEWORK_PLANTUML_SERVER_URL` build environment variable. The URL should include the PlantUML SVG path.

## Markdown Preview

`.md` and `.markdown` files open as rendered documents by default and provide a Source/Preview switch. Source mode continues to support line selection and local comments, but it must not render Pierre's file header. The file path appears only in the file-panel toolbar so scrolling cannot produce a duplicate sticky header or flicker.

Both the Markdown preview and source view must own a vertical scrolling region. The soft scrollbar uses a transparent track and a sufficiently contrasting gray thumb so the current scroll position remains visible.

## Data Transfer

For local workspaces, directory listing, text reads, and binary chunk reads access the disk directly in the Wework Tauri process instead of traversing executor IPC. Text reads are capped at 256 KiB, while `read_local_workspace_file_chunk` reads binary files in 1 MiB chunks. Unknown extensions inspect the first chunk; when the content is binary, that chunk must be reused during assembly instead of being read again. Project-space cloud files are already downloaded as a `Blob`, so unknown types inspect only the first 64 KiB. Every workspace request includes the workspace root and performs canonical-path validation in Rust, rejecting escapes through symlinks or relative paths. The frontend assembles binary chunks into a `File` for the viewer.

Workspaces opened through remote devices continue to use the device-side workspace API. The frontend still validates response paths, file names, and chunk offsets, and must not use the local native command as a fallback for a failed remote read.

The local native command `read_local_workspace_text_file` returns `editable` and `revision`; remote devices use the executor IPC command `workspace_read_text_file`. Only untruncated files that decode as UTF-8 can enter edit mode; binary files, text larger than 256 KiB, and decode failures remain preview-only.

Saving still uses the Rust executor's `workspace_write_text_file` capability because writes retain the task-workspace concurrency check and atomic replacement semantics. The IPC payload carries the file content, file name, and the `revision` returned by the read command. Before writing, the executor rereads the file on disk and compares the SHA-256 revision. If another process changed the file, saving fails and the frontend must block the overwrite and offer reload. Writes must stay inside the same workspace root and replace the target through a same-directory temporary file. Files opened through remote devices remain preview-only.

## Preview State Lifecycle

The file panel determines workspace changes from the target's `deviceId`, `path`, `source`, `taskId`, and `workspaceSource`. Task streaming and background polling may create new target objects with the same fields; reference-only changes must not clear the directory tree, reread the file, or unmount the current preview. Reload data only when the target fields actually change, the user selects another file, or the user explicitly refreshes.

## Build Assets

`@file-viewer/vite-plugin` copies selected renderer Workers, WASM, fonts, and other offline assets for development and production. Install `preset-office`, `preset-lite`, and `preset-engineering`, but do not use `preset-all` unless every heavy format is explicitly required. Vite must prebundle the Mermaid and PlantUML encoding dependencies so the drawing renderer's dynamic imports resolve consistently in the WebKit development environment.

## Validation

When changing the viewer, validate Markdown's default preview, source switching, long-document scrolling, and single-header behavior, plus Dart, UTF-8 source files with unknown extensions, binary files with unknown extensions, PDF, DOCX, XLSX, CSV, PPTX, PNG/JPEG/WebP, HTML, Mermaid, PlantUML, file switching, cancellation, directory expansion, symlinked workspaces, and workspace-boundary rejection. Unknown binary coverage must also confirm that the probe chunk is not read twice. Image coverage must include light and dark themes and alpha transparency, confirming that neither the preview canvas nor transparent image regions retain the renderer's light background. Diagram coverage must include light and dark themes, complete SVG fitting, PNG copy, and the system save dialog. Also observe an open text preview during task streaming and confirm that rerenders with an equivalent workspace target neither reread nor flicker the preview.

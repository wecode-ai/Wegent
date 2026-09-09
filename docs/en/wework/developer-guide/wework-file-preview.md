---
sidebar_position: 34
---

# Workspace File Preview

The Wework file panel renders Markdown documents as formatted content, sends other code and text files to Pierre CodeView, and sends binary files to Flyfish Viewer browser-side renderers. Preview data is read only from authorized local workspaces and is never uploaded to third-party services.

## Supported Formats

The viewer enables the office, lite, and engineering capabilities: PDF, Word, Excel, PowerPoint, images, HTML, Markdown, code, audio, video, Mermaid, and PlantUML diagrams. Code and text preview must not use an extension allowlist as its capability boundary. Common extensions, including Dart, enter the text-read fast path directly. Unknown extensions are inspected by content and use the code preview when they contain valid UTF-8 text without binary control bytes. Known binary formats continue directly to their specialized renderers. Unknown binary formats or rendering failures can be opened with the system default application in the macOS Electron app.

HTML must remain sandboxed and must not allow preview content to access Wework's same-origin state.

## Image Preview

PNG, JPEG, WebP, GIF, BMP, AVIF, TIFF, and SVG images use Flyfish Viewer's image renderer. The viewer container must receive Wework's active light or dark theme explicitly, and the canvas around the image uses Wework's semantic background color. The renderer must not force a white background onto image elements: images with an alpha channel render directly over the active theme background, including in the full-screen image preview.

## Diagram Preview and Export

`.mermaid`, `.mmd`, `.plantuml`, and `.puml` files use the same diagram renderer as code blocks in conversations. The preview must follow the active Wework light or dark theme and fit proportionally when the panel changes size without clipping SVG edges.

Mermaid can generate HTML labels containing `<br>` inside an SVG `foreignObject`. The renderer must enable Mermaid's strict security level and parse the output with HTML semantics before importing the SVG; reparsing it as strict XML first would reject non-self-closing HTML tags produced by browser serialization. Before import, remove executable or form-capable elements, event-handler attributes from the SVG root and its descendants, external-resource attributes, unsafe URL schemes, and non-local diagram references; only local `#id` `href` references remain. PlantUML output remains parsed as strict SVG/XML.

Diagram previews provide copy and save actions. Copy generates a PNG and writes it to the system clipboard through a native desktop command. Save opens the system save dialog and writes the PNG to the location selected by the user. During Mermaid export, HTML labels are converted to pure SVG text so the macOS WebView does not mark a Canvas containing `foreignObject` as non-exportable.

PlantUML requests SVG from `https://www.plantuml.com/plantuml/svg` by default. Deployments can point to a self-hosted service through the `plantumlServerUrl` runtime setting or the `VITE_WEWORK_PLANTUML_SERVER_URL` build environment variable. The URL should include the PlantUML SVG path.

## Markdown Preview

`.md` and `.markdown` files open as rendered documents by default and provide a Source/Preview switch. Source mode continues to support line selection and local comments, but it must not render Pierre's file header. The file path appears only in the file-panel toolbar so scrolling cannot produce a duplicate sticky header or flicker.

Both the Markdown preview and source view must own a vertical scrolling region. The soft scrollbar uses a transparent track and a sufficiently contrasting gray thumb so the current scroll position remains visible.

When Markdown code blocks preserve unwrapped lines, they must show a horizontal scrollbar that does not depend on the operating system's overlay-scrollbar setting. The thumb width must represent the visible range and remain draggable to the end of a long code line. Keep the thumb hidden while output is streaming, then show it after completion.

## Data Transfer

For local workspaces, directory listing, text reads, and binary chunk reads access the disk directly in the Wework Electron main process instead of traversing executor IPC. Text reads are capped at 256 KiB, while `read_local_workspace_file_chunk` reads binary files in 1 MiB chunks. Unknown extensions inspect the first chunk; when the content is binary, that chunk must be reused during assembly instead of being read again. Project-space cloud files are already downloaded as a `Blob`, so unknown types inspect only the first 64 KiB. Every workspace request includes the workspace root and performs canonical-path validation in Rust, rejecting escapes through symlinks or relative paths. The frontend assembles binary chunks into a `File` for the viewer.

Workspaces opened through remote devices continue to use the device-side workspace API. The frontend still validates response paths, file names, and chunk offsets, and must not use the local native command as a fallback for a failed remote read.

The local native command `read_local_workspace_text_file` returns `editable` and `revision`; remote devices use the executor IPC command `workspace_read_text_file`. Only untruncated files that decode as UTF-8 can enter edit mode; binary files, text larger than 256 KiB, and decode failures remain preview-only.

Saving still uses the Rust executor's `workspace_write_text_file` capability because writes retain the task-workspace concurrency check and atomic replacement semantics. The IPC payload carries the file content, file name, and the `revision` returned by the read command. Before writing, the executor rereads the file on disk and compares the SHA-256 revision. If another process changed the file, saving fails and the frontend must block the overwrite and offer reload. Writes must stay inside the same workspace root and replace the target through a same-directory temporary file. Files opened through remote devices remain preview-only.

## Preview Latency Diagnostics

The desktop app associates one file-link click and its subsequent preview work with a shared `traceId`, then writes diagnostic events to `file-preview.log` under Electron's log directory. The log is limited to 2 MiB with two rotated files. It records only the file extension, path length, file size, chunk count, stage, and timing; it does not record complete paths, file contents, or credentials.

For a right panel that appears long after the link is selected, inspect these stages under the same `traceId`:

1. `message_link_click` to `filesystem_stat_end`: determine whether the target is a file or directory before opening the right panel.
2. `open_file_request_queued` to `open_file_request_effect`: move the request from workbench state into the file panel.
3. `parent_tree_start` to `parent_tree_end`: read the parent directory and resolve the target entry.
4. `file_chunk_start` to `file_chunk_end`: read one binary chunk.
5. `base64_decode_end` and `file_constructed`: decode chunks, copy bytes, and construct the browser `File` in the renderer.
6. `binary_preview_state_queued` to `binary_preview_committed`: let React receive and commit the binary preview state.
7. `file_viewer_react_commit`: record the Flyfish Viewer React commit duration and viewer type.

After each important stage, a zero-delay timer measures renderer event-queue latency in `renderer_queue_probe.lagMs`; delays of at least 50 ms include `blocked: true`. If the preceding stage has completed but this probe runs much later, synchronous JavaScript, layout, painting, or another renderer long task is blocking the queue. `preview_loading_clear_skipped` means that a later file request replaced the current request and should be investigated as a request race rather than an unfinished single read.

When a read traverses executor App IPC, `executor.log` records its `command_key`, handling duration, response size, and `queue_wait_ms`. A fast `app IPC request finished` followed by a large `app IPC response queued.queue_wait_ms` indicates backpressure in the response write queue. If the executor queues the response quickly but the frontend logs `file_chunk_end` much later, inspect IPC transport and renderer message consumption next.

## Preview State Lifecycle

The file panel determines workspace changes from the target's `deviceId`, `path`, `source`, `taskId`, and `workspaceSource`. Task streaming and background polling may create new target objects with the same fields; reference-only changes must not clear the directory tree, reread the file, or unmount the current preview. Reload data only when the target fields actually change, the user selects another file, or the user explicitly refreshes.

Pierre CodeView's `items`, `options`, `selectedLines`, and selection callback are also part of the preview lifecycle. These inputs must retain stable references when message streaming, state polling, or loading-state changes cause unrelated parent rerenders; do not create fresh objects or functions on every render and trigger a forced CodeView redraw. A forced redraw replaces Shadow DOM text nodes and clears the browser's native text selection, making newly selected code disappear after a few seconds. Update each input only when its file content, target lines, theme, or actual selection state changes.

## Build Assets

`@file-viewer/vite-plugin` copies selected renderer Workers, WASM, fonts, and other offline assets for development and production. Install `preset-office`, `preset-lite`, and `preset-engineering`, but do not use `preset-all` unless every heavy format is explicitly required. Vite must prebundle the Mermaid and PlantUML encoding dependencies so the drawing renderer's dynamic imports resolve consistently in the Chromium development environment.

## Validation

When changing the viewer, validate Markdown's default preview, source switching, long-document scrolling, long-code-line horizontal scrolling, and single-header behavior, plus Dart, UTF-8 source files with unknown extensions, binary files with unknown extensions, PDF, DOCX, XLSX, CSV, PPTX, PNG/JPEG/WebP, HTML, Mermaid, PlantUML, file switching, cancellation, directory expansion, symlinked workspaces, and workspace-boundary rejection. The Markdown long-code-line check must separately confirm that streaming hides the thumb and that, after completion, the thumb stays visible, its size matches the overflow ratio, and it can be dragged to the line end. Unknown binary coverage must also confirm that the probe chunk is not read twice. Image coverage must include light and dark themes and alpha transparency, confirming that neither the preview canvas nor transparent image regions retain the renderer's light background. Diagram coverage must include light and dark themes, Mermaid HTML line-break labels, dangerous-element and event-attribute sanitization, complete SVG fitting, PNG copy, and the system save dialog. Also observe an open text preview during task streaming and confirm that rerenders with an equivalent workspace target neither reread nor flicker the preview. The real desktop E2E must select text while background messages continue streaming, wait through multiple workbench refreshes, and assert that the browser's native selection remains present.

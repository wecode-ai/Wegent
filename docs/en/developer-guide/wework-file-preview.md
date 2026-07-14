---
sidebar_position: 34
---

# Workspace File Preview

The Wework file panel sends code and text files to Pierre CodeView and binary files to Flyfish Viewer browser-side renderers. Preview data is read only from authorized local workspaces and is never uploaded to third-party services.

## Supported Formats

The initial viewer enables the office and lite capabilities: PDF, Word, Excel, PowerPoint, images, HTML, Markdown, code, audio, and video. Unknown formats or rendering failures can be opened with the system default application in the macOS Tauri app.

HTML must remain sandboxed and must not allow preview content to access Wework's same-origin state.

## Data Transfer

Binary files are read through `workspace_read_file_chunk` in 1 MiB chunks. Every request keeps workspace-root validation and rejects symlink or path escapes. The frontend assembles chunks into a `File` for the viewer; code and text continue to use `workspace_read_text_file` to avoid unnecessary binary transfer.

## Preview State Lifecycle

The file panel determines workspace changes from the target's `deviceId`, `path`, `source`, `taskId`, and `workspaceSource`. Task streaming and background polling may create new target objects with the same fields; reference-only changes must not clear the directory tree, reread the file, or unmount the current preview. Reload data only when the target fields actually change, the user selects another file, or the user explicitly refreshes.

## Build Assets

`@file-viewer/vite-plugin` copies selected renderer Workers, WASM, fonts, and other offline assets for development and production. Install only `preset-office` and `preset-lite`; do not use `preset-all` unless CAD, 3D, archive, or other heavy formats are explicitly required.

## Validation

When changing the viewer, validate PDF, DOCX, XLSX, CSV, PPTX, PNG/JPEG/WebP, and HTML, along with file switching, cancellation, directory expansion, and workspace-boundary rejection. Also observe an open text preview during task streaming and confirm that rerenders with an equivalent workspace target neither reread nor flicker the preview.

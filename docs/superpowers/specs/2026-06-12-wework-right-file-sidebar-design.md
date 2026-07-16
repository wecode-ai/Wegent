---
sidebar_position: 1
---

# Wework Right File Sidebar

## Background

Wework desktop should support a Codex-like right file sidebar. The first version
focuses on read-only workspace browsing and code-comment context collection. It
does not introduce file editing.

## Goals

- Reuse the existing desktop right workspace panel entry point.
- Show a persistent right-side file tree and a central read-only file preview.
- Let users select a code range, write a local comment, and attach that comment
  to the left composer as contextual input.
- Send code comments with the next chat message so the agent receives file path,
  line range, selected code, and user comment.

## Non-Goals

- No file editing or save support.
- No backend `SubtaskContext` schema change in the first version.
- No automatic sending after a code comment is created.
- No mobile version in this iteration.

## UI Design

The desktop workbench keeps the left chat area. Opening the right workspace
panel changes the layout into:

- Left: existing chat stream and composer.
- Center: read-only file preview with path breadcrumbs and line numbers.
- Right: searchable workspace file tree.

The right file tree supports directory expansion, file selection, loading and
empty states, and error retry. The file preview supports UTF-8 text/code files
in the first version, reading with replacement characters if a file contains
invalid UTF-8 bytes.

When the user selects text in the preview, Wework shows a small comment action
near the selection. Submitting the comment creates a local code-comment context
and adds a chip above the left composer, matching the reference behavior such as
`1 个评论`. The chip can be removed before sending.

## Data Model

Wework adds a client-side code comment context model:

```ts
interface CodeCommentContext {
  id: string
  filePath: string
  fileName: string
  startLine: number
  endLine: number
  selectedText: string
  comment: string
  createdAt: string
}
```

This model is separate from uploaded file attachments. It is displayed in the
composer as a contextual attachment, but it is not uploaded as a file and does
not use `attachment_ids`.

## Send Flow

When the user sends a message, Wework formats pending code comments into a
JSON context payload appended to the outgoing message. The outgoing message
contains the original user text plus code-comment context with file path, line
range, selected code, and comment.

If the composer contains only code comments and no typed text, the visible
message uses a short default prompt such as `请参考代码评论`. After a successful
send, Wework clears the pending code-comment contexts.

## Workspace Source

The file sidebar resolves the active workspace from the current project/task
and active device. It should prefer the current task workspace when available,
then the current project workspace, and otherwise show a clear empty state.

The implementation should use existing Wework device/project APIs where possible.
If additional device commands are needed for listing files or reading file
contents, they should be added as narrow command keys rather than general shell
execution from the UI.

## Error Handling

- No active project or workspace: show a neutral empty state.
- Device offline or unsupported: disable loading and show the current device
  status.
- Directory load failure: show retry in the tree.
- File load failure: show retry in the preview pane.
- Very large text files: cap preview size and show truncation information.
- Files with invalid UTF-8 bytes: keep the preview readable with replacement
  characters.
- Selection without text: do not show the comment action.

## Testing

- Right file panel renders from the existing desktop workbench action and keeps
  the chat composer available.
- File tree loads entries and selecting a file renders a read-only preview with
  line numbers.
- Selecting a code range and submitting a comment creates one composer chip.
- Removing the chip removes the pending code-comment context.
- Sending with code comments formats the outgoing payload message with file path,
  line range, selected code, and comment.
- Sending succeeds clears pending code comments; failed sends keep them.

## First-Version Limits

- Text preview reads at most 256 KiB per file. If a file is larger, Wework shows
  the first 256 KiB with a truncation notice.
- History rendering can initially rely on the formatted outgoing message. A
  later version can add a backend `code_comment` context type if persistent
  structured history becomes necessary.

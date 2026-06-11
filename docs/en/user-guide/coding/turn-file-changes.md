---
sidebar_position: 5
---

# Review and Revert Turn File Changes

After a supported coding task completes, Wework displays a file changes card below the corresponding assistant message. The card covers only the changes produced during that user-and-assistant turn, not the accumulated changes for the conversation or workspace.

## Review the Summary

The card shows the number of changed files, added and deleted lines, and the file list. It displays the first three files by default and can expand to show the rest.

Binary files do not have reliable text line counts, so the card displays only the file name and binary status.

## Review the Full Diff

Selecting **Review** loads the compressed patch from the original execution device and displays the unified diff grouped by file.

Review is not available offline. The original device must be online and the device-side artifact must still exist. The summary remains visible while the device is offline, but Review and Revert are disabled.

## Revert One Turn

After selecting **Revert** and confirming, the device first checks whether the reverse patch can apply safely:

- When the check succeeds, only the changes from that turn are reverted.
- If later work changed the same content, the card reports a conflict and the workspace is not modified.
- Revert never force-overwrites later changes.
- A successful revert is idempotent, so repeated requests do not modify files again.

## Supported Workspaces

Turn file changes currently support Codex and Claude Code in Git project workspaces. Non-Git directories do not produce a file changes card.

The complete patch is stored as a compressed artifact in the task directory on the execution device. Backend stores only the file count, line statistics, file list, status, device, and artifact identifier in the assistant message's `Subtask.result`.

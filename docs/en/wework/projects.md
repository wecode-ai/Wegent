---
sidebar_position: 3
---

# Projects and workspaces

Projects group conversations that use the same codebase. A project can map to folders on one or more execution devices.

## Existing folders and Git projects

Choose **Use existing folder** for code already on the device. Adding the same folder again restores or reuses its project and conversations.

To create a Git project, select a device, repository, default branch, and destination. If repositories are unavailable, check the Git connection and token permissions in Settings.

## Regular workspaces and worktrees

- A regular workspace runs tasks directly in the project folder.
- A Git worktree gives each task an isolated branch and folder, which is useful for parallel changes.

For worktree tasks, the file tree, terminal, and development tools use the task's worktree. Commit or preserve changes before archiving the task.

## Multiple devices

A project can reference a different folder on each local, cloud, or remote device. Select the device that contains the code when starting a task. Copying a task to another device requires a project folder on that device.

On macOS, open a folder from a terminal with `wework .` or `wework /path/to/project`.

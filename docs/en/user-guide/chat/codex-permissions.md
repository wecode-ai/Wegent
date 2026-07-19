---
sidebar_position: 8
---

# Codex permission modes

Wework provides a Codex permission selector below the composer. New chats inherit the default from **Settings > General**, while existing chats keep their own selection.

## Permission modes

- **Full access**: Runs without sandboxing or approval prompts. Use only in trusted workspaces.
- **Ask for approval**: Codex works automatically inside the workspace and asks you before accessing files outside it, using blocked network access, or invoking side-effecting tools.
- **Approve for me**: Keeps the same sandbox as Ask for approval, but routes boundary-crossing requests to an independent AI reviewer. Reviewer failures and timeouts deny the action instead of widening access.

When you change the mode during execution, the current turn keeps its original mode and the new mode applies to the next turn.

## Approval scope

Approval cards show only decisions supported by the current Codex request, such as allow once, allow for the session, or decline. A persistent option appears only when Codex provides a command or network rule amendment; Wework does not broaden the proposed rule.

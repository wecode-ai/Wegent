---
sidebar_position: 1
---

# Bind Local Codex Sessions

Wework can bind an existing local Codex session as a Wework conversation. After binding, Wework stores the local Codex thread id, and follow-up messages sent from Wework continue that same local Codex thread.

## Requirements

- The local device must be online and accessible to the current Wework account.
- The local executor and your existing Codex App or Codex CLI must use the same `CODEX_HOME`. If `CODEX_HOME` differs, Wework may not see the local thread you want to bind.
- Wework reads thread summaries only, such as title, directory, and updated time. It does not import the full Codex history from before binding.

## Take Over On Desktop

1. In Wework desktop, open **Local Codex sessions** from the dedicated **Codex** area in the left sidebar.
2. Select an online local device.
3. Review local Codex sessions grouped by project. Wework first matches the session working directory to a project; when the session comes from a Codex worktree, it matches the worktree directory name back to the source project; unmatched sessions appear under **Unmatched project**.
4. Choose the Codex session to take over and click **Take over**. Wework creates or opens the matching Wework task.

Subagent sessions are hidden. Running local Codex sessions remain visible with a **Running** state, but cannot be taken over until they finish.

## Continue On Mobile

After binding, mobile does not need a separate import step. Open the bound Wework task and send follow-up messages.

Execution still runs on the bound local device. When continuing from mobile, the local device must remain online and able to access the same `CODEX_HOME` and working directory.

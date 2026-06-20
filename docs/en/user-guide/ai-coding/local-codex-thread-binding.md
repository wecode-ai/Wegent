---
sidebar_position: 1
---

# Bind Local Codex Tasks

Wework can bind an existing local Codex task as a Wework conversation. After binding, Wework stores the local Codex thread id, and follow-up messages sent from Wework continue that same local Codex thread.

## Requirements

- The local device must be online and accessible to the current Wework account.
- The local executor and your existing Codex App or Codex CLI must use the same `CODEX_HOME`. If `CODEX_HOME` differs, Wework may not see the local thread you want to bind.
- The first version reads thread summaries only, such as title, directory, and updated time. It does not import the full Codex history from before binding.

## Import On Desktop

1. In Wework desktop, open the local Codex import button near the recent conversation list.
2. Select an online local device.
3. Choose the Codex task to import.
4. Click **Import**. Wework creates or opens the matching Wework task.

Archived or currently running local Codex tasks cannot be imported yet. Restore the task locally or wait until it finishes, then try again.

## Continue On Mobile

After binding, mobile does not need a separate import step. Open the bound Wework task and send follow-up messages.

Execution still runs on the bound local device. When continuing from mobile, the local device must remain online and able to access the same `CODEX_HOME` and working directory.

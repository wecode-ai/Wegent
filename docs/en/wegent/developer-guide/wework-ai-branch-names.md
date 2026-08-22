---
sidebar_position: 18
---

# Wework AI Branch Name Generation

The Wework branch selector can generate a Git branch name from the current composer input or task title. It reuses the model configured for friendly task titles and falls back to the current task model when no title model is configured or the configured model is temporarily unavailable.

The request enters the Rust executor through the `runtime.text.generate` App IPC method and runs through Codex app-server with these constraints:

- The turn is always ephemeral and creates no Wework task or workspace association.
- Tools and deep thinking are disabled to avoid loading context unrelated to short text generation.
- The title model identity, options, authentication, model catalog, and routing are reused.
- Only completed turn text is returned; failed or incomplete turns produce an explicit IPC error.

While generation is running, the branch name input and create button remain disabled and a progress message is visible. The generated value only fills the input, so the user can review or edit it before explicitly creating the branch.

---
sidebar_position: 1
---

# Manually Sync Device Git Configuration

Cloud device creation no longer reads or injects Git tokens. In Wework, the user opens Git hosting settings, selects one online ClaudeCode cloud or remote device, and clicks **Sync Git configuration**.

The Backend selects the first configured account for each domain and resolves every token before synchronization. If any effective token is unavailable, the request fails before changing the device. Tokens are never returned to Wework or written to URLs, command arguments, Device CRDs, cloud-init, or logs.

The device stores Wegent-managed state under `~/.wecode/git-auth/`:

- Directories use `0700`; tokens and CLI configuration use `0600`.
- The Git credential helper returns credentials only for exact HTTPS domain matches.
- Common GitHub, GitLab, Gitee, and Gitea SSH URLs are rewritten to credential-free HTTPS. Gerrit SSH URLs remain unchanged.
- Commit identity uses conditional Git includes based on remote domains and does not override repository-local configuration.
- When `gh` or `glab` is installed, synchronization also configures a separate Wegent CLI directory. A missing CLI or failed CLI login produces a warning without disabling Git authentication.

Each synchronization atomically replaces the Wegent-managed desired state and removes stale domains. When the cloud account list is empty, Wework asks for confirmation and then removes only Wegent-managed Git and CLI configuration, preserving user-owned configuration.

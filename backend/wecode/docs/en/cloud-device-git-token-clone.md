---
sidebar_position: 1
---

# Cloud Device Git Configuration

## Automatic configuration during creation

When a cloud device is created, the Backend reads the current user's GitLab tokens from the internal secret service and injects supported domains into the Nevis VM environment and startup script:

| Variable                      | Git domain              | Purpose                                                            |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `GIT_INTRA_WEIBO_COM_TOKEN`   | `git.intra.weibo.com`   | Access the corresponding GitLab repositories from the cloud device |
| `GIT_STAFF_SINA_COM_CN_TOKEN` | `git.staff.sina.com.cn` | Access the corresponding GitLab repositories from the cloud device |
| `GITLAB_WEIBO_CN_TOKEN`       | `gitlab.weibo.cn`       | Access the corresponding GitLab repositories from the cloud device |

For the `ubuntu` user, the startup script rewrites supported `ssh://git@...` and `git@...:` repository addresses to HTTPS through `url.*.insteadOf`. `~/.wecode/git-askpass.sh` then authenticates with the current Wegent user name and token.

To support clones from later interactive shells, the startup script writes the Git user name and token variables to `~/.wecode/git-token-env` with `0600` permissions and loads it from `~/.bashrc`. Tokens are not written to Git remote URLs, Device CRDs, the database, or logs. A token lookup failure does not block cloud device creation.

## Manually sync a selected device

In Wework, the user can also open Git hosting settings, select one online ClaudeCode cloud or remote device, and click **Sync Git configuration**.

The Backend selects the first configured account for each domain and resolves every token before synchronization. If any effective token is unavailable, the request fails before changing the device. Tokens are never returned to Wework or written to URLs, command arguments, Device CRDs, cloud-init, or logs.

The device stores Wegent-managed state under `~/.wecode/git-auth/`:

- Directories use `0700`; tokens and CLI configuration use `0600`.
- The Git credential helper returns credentials only for exact HTTPS domain matches.
- Common GitHub, GitLab, Gitee, and Gitea SSH URLs are rewritten to credential-free HTTPS. Gerrit SSH URLs remain unchanged.
- Commit identity uses conditional Git includes based on remote domains and does not override repository-local configuration.
- When `gh` or `glab` is installed, synchronization also configures a separate Wegent CLI directory. A missing CLI or failed CLI login produces a warning without disabling Git authentication.

Each synchronization atomically replaces the Wegent-managed desired state and removes stale domains. When the cloud account list is empty, Wework asks for confirmation and then removes only Wegent-managed Git and CLI configuration, preserving user-owned configuration.

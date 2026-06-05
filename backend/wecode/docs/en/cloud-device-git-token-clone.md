---
sidebar_position: 1
---

# Cloud Device Git Token Clone

If the current user has GitLab tokens configured in the internal secret service, cloud device creation injects supported-domain tokens into the Nevis VM environment and the startup script environment:

| Variable | Git Domain | Purpose |
|----------|------------|---------|
| `GIT_INTRA_WEIBO_COM_TOKEN` | `git.intra.weibo.com` | Allows processes on the cloud device to access the matching GitLab repositories |
| `GIT_STAFF_SINA_COM_CN_TOKEN` | `git.staff.sina.com.cn` | Allows processes on the cloud device to access the matching GitLab repositories |
| `GITLAB_WEIBO_CN_TOKEN` | `gitlab.weibo.cn` | Allows processes on the cloud device to access the matching GitLab repositories |

These Git tokens are read from the external secret service only during cloud device creation and injected into the runtime environment. They are not written to the Device CRD, database, or logs. Failure to fetch the tokens does not block cloud device creation.

The startup script configures Git for the `ubuntu` user: supported-domain `ssh://git@...` and `git@...:` repository URLs are automatically rewritten to HTTPS through `url.*.insteadOf`, and `~/.wecode/git-askpass.sh` authenticates with the current Wegent username and the token from the environment variables above.

To ensure newly opened interactive shells can also clone repositories, the startup script writes the Git username and token environment variables to `~/.wecode/git-token-env` with `0600` permissions and loads it from `~/.bashrc`. Tokens are not written into Git remote URLs or `.gitconfig`.

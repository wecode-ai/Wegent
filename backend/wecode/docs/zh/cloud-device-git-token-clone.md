---
sidebar_position: 1
---

# 云设备 Git Token Clone

如果当前用户在内部 secret 服务中配置了 GitLab token，云设备创建流程会把支持域名的 token 注入到 Nevis VM 环境和启动脚本环境中：

| 变量 | Git 域名 | 用途 |
|------|----------|------|
| `GIT_INTRA_WEIBO_COM_TOKEN` | `git.intra.weibo.com` | 云设备内访问对应 GitLab 仓库 |
| `GIT_STAFF_SINA_COM_CN_TOKEN` | `git.staff.sina.com.cn` | 云设备内访问对应 GitLab 仓库 |
| `GITLAB_WEIBO_CN_TOKEN` | `gitlab.weibo.cn` | 云设备内访问对应 GitLab 仓库 |

这些 Git token 只在创建云设备时从外部 secret 服务读取并注入运行环境，不写入 Device CRD、数据库或日志。token 获取失败不会阻断云设备创建。

启动脚本会为 `ubuntu` 用户配置 Git：支持域名的 `ssh://git@...` 和 `git@...:` 仓库地址会通过 `url.*.insteadOf` 自动改写为 HTTPS，并通过 `~/.wecode/git-askpass.sh` 使用当前 Wegent 用户名和上述 token 认证。

为保证后续新开的交互式 shell 也可执行 clone，启动脚本会把 Git 用户名和 token 环境变量写入 `~/.wecode/git-token-env` 并设置 `0600` 权限，再通过 `~/.bashrc` 自动加载。token 不会写入 Git remote URL 或 `.gitconfig`。

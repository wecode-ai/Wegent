---
sidebar_position: 1
---

# 云设备 Git 配置

## 创建时自动配置

创建云设备时，后端会从内部 secret 服务读取当前用户的 GitLab Token，并把支持域名的 Token 注入 Nevis VM 环境和启动脚本：

| 变量                          | Git 域名                | 用途                         |
| ----------------------------- | ----------------------- | ---------------------------- |
| `GIT_INTRA_WEIBO_COM_TOKEN`   | `git.intra.weibo.com`   | 云设备内访问对应 GitLab 仓库 |
| `GIT_STAFF_SINA_COM_CN_TOKEN` | `git.staff.sina.com.cn` | 云设备内访问对应 GitLab 仓库 |
| `GITLAB_WEIBO_CN_TOKEN`       | `gitlab.weibo.cn`       | 云设备内访问对应 GitLab 仓库 |

启动脚本会为 `ubuntu` 用户配置 Git：支持域名的 `ssh://git@...` 和 `git@...:` 仓库地址会通过 `url.*.insteadOf` 自动改写为 HTTPS，并通过 `~/.wecode/git-askpass.sh` 使用当前 Wegent 用户名和 Token 认证。

为保证后续新开的交互式 Shell 也可执行 clone，启动脚本会把 Git 用户名和 Token 环境变量写入 `~/.wecode/git-token-env` 并设置 `0600` 权限，再通过 `~/.bashrc` 自动加载。Token 不会写入 Git remote URL、Device CRD、数据库或日志。Token 获取失败不会阻断云设备创建。

## 手动同步指定设备

用户也可以在 Wework 的“代码托管”设置中选择一台在线的 ClaudeCode 云端或远程设备，然后点击“同步 Git 配置”。

后端从当前用户的 Git 账户中按配置顺序选择每个域的第一个账户，并在同步前解析全部 Token。任意有效 Token 无法解析时，同步会在修改设备前失败。Token 不会返回 Wework，也不会写入 URL、命令参数、Device CRD、cloud-init 或日志。

设备把 Wegent 托管配置保存在 `~/.wecode/git-auth/`：

- 目录权限为 `0700`，Token 与 CLI 配置权限为 `0600`。
- Git credential helper 仅为精确匹配的 HTTPS 域提供凭据。
- GitHub、GitLab、Gitee 和 Gitea 的常见 SSH 地址会改写为无凭据的 HTTPS；Gerrit SSH 地址保持不变。
- 提交身份通过 Git 条件 include 按远程域生效，不覆盖仓库本地配置。
- 如果设备安装了 `gh` 或 `glab`，同步会同时配置独立的 Wegent CLI 目录；CLI 缺失或登录失败只产生警告。

每次同步都会原子替换 Wegent 管理的目标状态并删除失效域。没有云端 Git 账户时，Wework 会要求确认，然后只清理 Wegent 管理的 Git/CLI 配置，不修改用户自己的配置。

---
sidebar_position: 1
---

# 手动同步设备 Git 配置

云设备创建过程不读取或注入 Git Token。用户需要在 Wework 的“代码托管”设置中选择一台在线的 ClaudeCode 云端或远程设备，然后点击“同步 Git 配置”。

后端从当前用户的 Git 账户中按配置顺序选择每个域的第一个账户，并在同步前解析全部 Token。任意有效 Token 无法解析时，同步会在修改设备前失败。Token 不会返回 Wework，也不会写入 URL、命令参数、Device CRD、cloud-init 或日志。

设备把 Wegent 托管配置保存在 `~/.wecode/git-auth/`：

- 目录权限为 `0700`，Token 与 CLI 配置权限为 `0600`。
- Git credential helper 仅为精确匹配的 HTTPS 域提供凭据。
- GitHub、GitLab、Gitee 和 Gitea 的常见 SSH 地址会改写为无凭据的 HTTPS；Gerrit SSH 地址保持不变。
- 提交身份通过 Git 条件 include 按远程域生效，不覆盖仓库本地配置。
- 如果设备安装了 `gh` 或 `glab`，同步会同时配置独立的 Wegent CLI 目录；CLI 缺失或登录失败只产生警告。

每次同步都会原子替换 Wegent 管理的目标状态并删除失效域。没有云端 Git 账户时，Wework 会要求确认，然后只清理 Wegent 管理的 Git/CLI 配置，不修改用户自己的配置。

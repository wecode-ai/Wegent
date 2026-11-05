---
sidebar_position: 1
---

# Git 仓库连接 / Git repository connections

仓库连接的 `repository-baseline.js` 仅适配现有原生账号读取和持久 checkpoint。它分页发现已有的 open PR/MR，不依靠用户手动读取来登记监控，也不写账号或另建任务调度器。初扫旧检查只建立比较基线；可信更新时间证明连接启用后的真实变化仍会接收。相同 head 的后续检查版本与已有业务事件一样进入统一 intake。

最多登记 100 个打开的变更。未接纳的发现页不前进，已登记对象继续比较。覆盖不足及恢复分别产生稳定版本的 `git.monitoring_coverage` 诊断事件；它描述连接监控状态，不是 PR 更新、构建失败或业务完成。首次基线没有可信时间的数据不能宣称为新变化。调度、账号、来源授权、限流和 checkpoint 提交均沿用现有边界。

`repository-baseline.test.mjs` uses protocol doubles to verify both providers, old-checkpoint discovery, trustworthy changes during baseline, later changes on the same head, serialized page recovery, coverage limits and recovery. It does not claim real GitLab compatibility. Discovery lists open changes once and retains progress, rather than scanning repository history every cycle. `read_source` remains read-only and never registers a watch.

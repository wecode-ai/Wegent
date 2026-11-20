---
sidebar_position: 16
---

# 设备连接运行时的发布与升级

远程 Docker 镜像从同一提交构建 Executor 和 Node/DSH connection runtime。连接服务和运行时权限校验共用身份查询：设备凭据（`wg-`）访问 `/devices/runtime-owner`，桌面会话访问 `/users/me`。发布前确认测试 Backend 支持设备身份查询和连接事件，并检查实际 Rust 路由表包含四条 `runtime-observations` 路由。

GitHub 的 `Wegent Release` 流程构建 amd64 和 arm64 设备镜像，核对版本、源码提交和架构，并检查 connection runtime 清单及其 Node 可执行文件。记录候选镜像 digest，将测试环境的 `REMOTE_DEVICE_DOCKER_IMAGE` 指向该 digest。

## 远程 Docker

新设备使用页面生成的命令。升级存量设备时记录旧镜像 digest、原启动参数和两个卷的挂载。等待任务结束后停掉旧容器，使用原设备 ID、凭据、网络和挂载，以候选镜像重建。回滚时用旧 digest 重建。同一数据卷只能有一个写入进程。

旧单卷布局保留挂到 `/home/wegent/.wecode/wegent-executor` 的卷，并给 `/home/wegent/.wegent` 增加持久卷。旧容器在该目录有数据时，停机后复制到新卷，保留相对路径和属主。单独挂载的工作区和 Codex Home 继续用原挂载。启动入口保留原 Codex Home 配置，只刷新 Executor 二进制和 connection runtime 链接。

旧、新 Executor Home 都有数据时，先根据旧进程的启动参数、环境和路径解析结果核实活动 Home，停机后分别备份，再选择对应配置重建：

- 活动 Home 是旧路径时，显式设置 `WEGENT_EXECUTOR_HOME=/home/wegent/.wecode/wegent-executor`，保留该路径的原卷挂载及 `/home/wegent/.wegent` 数据卷。
- 活动 Home 是统一路径时，设置 `WEGENT_EXECUTOR_HOME=/home/wegent/.wegent/workbench/executor`，保留其所在的 `/home/wegent/.wegent` 数据卷及原有嵌套挂载；从新容器的启动参数中移除非活动旧卷在 `/home/wegent/.wecode/wegent-executor` 的挂载，保留旧卷本身及原启动参数供回滚。统一路径若解析到旧 Home，则仍按旧路径分支处理。

两种配置都必须保留已核实的设备身份、独立工作区和 Codex Home 配置及挂载。不要合并两套 Home 或删除非活动卷；无法确认活动 Home 时先完成核实再重建。同时保留旧卷挂载并选择已有统一 Home 会触发 `Both legacy and unified Executor Homes exist`，启动入口会拒绝启动。

在隔离 Docker 环境执行持久化验收，分别指定旧镜像、候选镜像和回滚镜像。`WEGENT_REMOTE_DEVICE_ACCEPTANCE_PLATFORM` 可选；需要明确架构时设置为 `linux/amd64` 或 `linux/arm64`。

```bash
WEGENT_REMOTE_DEVICE_ACCEPTANCE_PLATFORM=linux/amd64 \
WEGENT_REMOTE_DEVICE_ACCEPTANCE_IMAGE='<previous-image-digest>' \
WEGENT_REMOTE_DEVICE_REBUILD_IMAGE='<candidate-image-digest>' \
WEGENT_REMOTE_DEVICE_ROLLBACK_IMAGE='<previous-image-digest>' \
bash scripts/acceptance/remote-device-worktree-persistence.sh
```

验收复用原设备身份和两个卷，依次检查初始启动、候选镜像重建和回滚镜像重建。每次重建后核对挂载、当前镜像二进制、旧会话和工作区，并拒绝跨设备复用及并发写入。省略镜像覆盖参数时，脚本使用初始镜像进行重建和回滚，仅证明同镜像重建，不证明跨版本升级。

## 放量

分别确认新装、旧版直升和回滚。检查旧会话可继续，并通过实际连接事件验收唤醒、重连、去重和取消。现有桌面 CI 的 `conversation-event-remote-docker` 场景使用真实 Backend、DSH 和 Docker 设备验证事件恢复；模型服务使用测试替身。持久化验收与事件验收均通过后再切换默认镜像。

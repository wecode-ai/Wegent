---
sidebar_position: 1
---

# 内部镜像构建

`wecode/docker` 下的镜像使用独立构建上下文。运行各目录中的
`prepare_build.sh` 后，再从该目录执行 `docker build`。

当 `frontend/package.json` 或 `wework/package.json` 新增 `workspace:*`
依赖时，对应镜像必须同步：

1. 在安装依赖前复制 workspace 包的 `package.json`。
2. 在应用构建前复制 workspace 包源码。
3. 在 `prepare_build.sh` 中复制该包，并清理复制内容中的
   `node_modules`。

例如，frontend 和 wework 依赖 `@wegent/collaboration`，因此所有相关内部
Dockerfile 与准备脚本都必须包含 `packages/collaboration`。

## Internal image builds

Images under `wecode/docker` use isolated build contexts. Run the directory's
`prepare_build.sh` before invoking `docker build` from that directory.

When `frontend/package.json` or `wework/package.json` adds a `workspace:*`
dependency, the matching image must copy the workspace package manifest before
dependency installation, copy its source before the application build, and
remove copied `node_modules` in `prepare_build.sh`.

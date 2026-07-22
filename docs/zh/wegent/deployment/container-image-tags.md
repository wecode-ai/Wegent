---
sidebar_position: 4
---

# 容器镜像标签

Wegent 将稳定发布镜像和 main 分支快照镜像分开。普通用户和生产环境应使用稳定标签；维护者、贡献者和测试环境可以使用 main 分支快照标签验证最新合并结果。

## 标签语义

| 标签 | 类型 | 更新来源 | 推荐用途 |
|------|------|----------|----------|
| `latest` | 可移动稳定标签 | 正式发布流程 | 普通用户快速部署、非严格生产环境 |
| `1.2.3` | 版本标签 | 正式发布流程 | 生产环境、可复现部署、回滚 |
| `main` | 可移动快照标签 | main 分支合并后的快照流程 | 内部测试、贡献者验证 |
| `edge` | 可移动快照标签 | main 分支合并后的快照流程 | 与 `main` 等价，面向习惯使用 edge 通道的用户 |
| `main-<short-sha>` | 提交快照标签 | main 分支合并后的快照流程 | 精确复现某次 main 构建、排障和回滚 |
| `main-<short-sha>-amd64` / `main-<short-sha>-arm64` | 架构标签 | 快照流程内部使用 | 组成多架构 manifest，不建议直接部署 |

`latest` 只表示最新稳定发布版，不代表 main 分支的最新提交。`main` 和 `edge` 可能包含尚未正式发布的功能，部署前应确认测试环境可以接受不稳定变更。

## 快照镜像

每次代码合并到 `main` 后，`Snapshot Image` workflow 会构建以下镜像：

```text
ghcr.io/wecode-ai/wegent-backend
ghcr.io/wecode-ai/wegent-web
ghcr.io/wecode-ai/wegent-executor
ghcr.io/wecode-ai/wegent-executor-manager
ghcr.io/wecode-ai/wegent-chat-shell
ghcr.io/wecode-ai/wegent-knowledge-runtime
ghcr.io/wecode-ai/wegent-knowledge-doc-converter
ghcr.io/wecode-ai/wegent-standalone
```

流程会先推送按提交命名的 `main-<short-sha>` 多架构标签，并验证 standalone 镜像可以启动。验证通过后，才会将同一批镜像提升到可移动的 `main` 和 `edge` 标签。

## 使用示例

使用最新稳定版：

```bash
docker pull ghcr.io/wecode-ai/wegent-standalone:latest
```

使用 main 分支最新快照：

```bash
docker pull ghcr.io/wecode-ai/wegent-standalone:edge
```

复现某次 main 构建：

```bash
docker pull ghcr.io/wecode-ai/wegent-standalone:main-631609e5a123
```

标准多容器部署测试 main 快照时，应让所有 Wegent 服务使用同一个快照标签，避免不同服务之间版本不一致。

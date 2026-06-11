---
sidebar_position: 19
---

# 沙箱工作区归档

沙箱工作区归档用于在 Sandbox runtime 被 24 小时空闲清理删除前保存文件状态，并在同一 Task 后续重新对话时恢复到新建的 Sandbox runtime。该机制复用现有 executor Pod 工作区归档链路，但通过 `runtime_type` 区分不同运行时的目录策略。

## 适用场景

该能力只处理 Sandbox runtime 的生命周期恢复：

- Sandbox 空闲超过清理阈值后，Executor Manager 在删除前请求 Backend 归档。
- 用户后续继续同一个 Task 的沙箱对话时，Executor Manager 新建 Sandbox，并请求 Backend 恢复归档。
- 如果归档或恢复失败，Sandbox 删除和创建不会被阻断；失败只记录日志。

普通 executor Pod 仍使用原有 code task 恢复链路。旧调用不传 `runtime_type` 时默认按 executor 行为处理。

## 架构

归档路径：

1. `SandboxManager.cleanup_stale_sandboxes()` 找到过期 Sandbox。
2. Executor Manager 调用 Backend 内部接口 `POST /api/internal/workspace-archives/{task_id}/archive-sandbox`。
3. Backend `ArchiveService` 生成对象存储预签名上传 URL，并调用 Executor Manager `/executor/archive`。
4. Executor Manager 将 `runtime_type=sandbox` 转发到对应 executor envd `/api/archive`。
5. envd 打包 Sandbox 文件并上传到对象存储。
6. Backend 将归档元数据写入 `Task.status.archive`。
7. Executor Manager 删除 Sandbox。

恢复路径：

1. 后续对话需要 Sandbox 时，Executor Manager 新建 Sandbox。
2. 新 Sandbox 启动成功后，Executor Manager 调用 Backend 内部接口 `POST /api/internal/workspace-archives/{task_id}/restore-sandbox`。
3. Backend 检查 `Task.status.archive` 是否存在、未过期且对象仍存在。
4. Backend 生成预签名下载 URL，并调用 Executor Manager `/executor/restore`。
5. Executor Manager 将 `runtime_type=sandbox` 转发到新 Sandbox envd `/api/restore`。
6. envd 下载归档并恢复到 Sandbox 文件系统。

## 目录策略

executor Pod 和 Sandbox runtime 使用同一份 executor/envd 代码，但目录布局不同。因此 envd 通过 `runtime_type` 选择目录策略：

| runtime_type | 归档目录 | tar 内部根目录 | 说明 |
| --- | --- | --- | --- |
| `executor` | `/workspace/{task_id}`、Claude home 配置 | 原有格式、`__home__/` | 默认值，保持旧行为 |
| `sandbox` | `/home/user`、`/workspace/{task_id}` | `home/`、`workspace/` | 覆盖 Sandbox 当前工作目录和兼容工作区路径 |

Sandbox 归档排除常见大目录和缓存，例如：

- `node_modules`
- `.venv`、`venv`
- `__pycache__`
- `.cache`
- `.npm`
- `.pnpm-store`
- `.yarn`
- `build`、`dist`、`target`
- `*.log`

恢复时，`home/*` 写回 `/home/user`，`workspace/*` 写回 `/workspace/{task_id}`。

## 失败处理

Sandbox 清理和恢复采用 best-effort 策略：

- 删除前归档失败：记录 warning，继续删除 Sandbox，避免空闲资源堆积。
- 新建后恢复失败：记录 warning，新 Sandbox 仍可用于后续对话。
- 没有 `task_id` 的 Sandbox：跳过归档和恢复。
- 归档过期或对象不存在：Backend 返回恢复失败，Executor Manager 不阻断 Sandbox 创建。

## 管理清理接口

除全量 stale cleanup 外，管理员可以按 Task 精确清理一个 Sandbox runtime，避免遍历全部 Sandbox：

```bash
curl -X POST http://localhost:8000/api/admin/runtime-cleanup/sandbox \
  -H 'Content-Type: application/json' \
  -d '{"task_id": 1973, "dry_run": false, "archive_before_delete": true}'
```

Backend 会转发到 Executor Manager：

```bash
curl -X POST http://localhost:8001/executor-manager/sandboxes/cleanup-by-task \
  -H 'Content-Type: application/json' \
  -d '{"task_id": 1973, "dry_run": false, "archive_before_delete": true}'
```

该接口会优先使用 Redis 中记录的容器名删除；如果 Redis 容器名已过期或不匹配，会回退到 `task_id` 标签删除对应 Sandbox 容器，并清理 Redis 中的 Sandbox 元数据。

## Stale Cache 处理

Chat Shell 的 Sandbox client 在复用本地缓存的 `sandbox_id` 前会重新查询 Executor Manager。若缓存的 Sandbox 已被删除、返回 404 或状态不是 `running`，client 会清空缓存并重新创建。

如果执行请求发出时 Sandbox 刚好被删除，`execute` 遇到 404 或 not found 后会清空缓存、重新创建 Sandbox，并重试一次。只重试一次是为了避免基础设施故障时进入循环。

## 并发重建处理

同一个 Task 的 Sandbox 重建在 Executor Manager 内按 `task_id` 串行化。第一个请求会完成容器启动和归档恢复后再释放锁；并发进入的后续请求会在锁内重新检查并复用已经 `running` 的 Sandbox。这样可以避免同一 Task 同时创建两个容器，或执行请求落到尚未恢复完成的失败实例。

## 本地验证

单元测试：

```bash
cd executor
uv run pytest tests/test_envd_workspace_archive.py

cd ../executor_manager
uv run pytest tests/services/test_sandbox_manager.py tests/routers/test_sandbox_cleanup_routes.py tests/routers/test_workspace_archive_routes.py -q

cd ../backend
uv run pytest tests/api/endpoints/internal/test_workspace_archives_api.py tests/api/endpoints/test_admin_runtime_cleanup_api.py -q

cd ../chat_shell
uv run pytest tests/test_sandbox_client.py
```

手工验证时，在 Sandbox 中分别写入 `/home/user` 和 `/workspace/{task_id}` 文件，触发 stale cleanup 后继续同一 Task 对话，确认新 Sandbox 中两个路径的文件都已恢复。

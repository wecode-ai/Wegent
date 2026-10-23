---
sidebar_position: 39
---

# 设备产物规则：撤回自动迁移与保留版本链

公共 `Ghost/default/wegent-wework` 的提示词自动更新已经撤回。本功能不要求改写生产数据库的 Ghost，也不通过迁移回滚管理员配置。

## 保留的交付规则

- 默认 YAML 保留新版产物声明规则，只用于创建尚不存在的资源。
- Claude Code（启用工具时）及 Codex 在每轮执行时注入声明规则；已有 Ghost 可以保留旧提示词。
- 文件仍保存在执行设备。声明只保存元数据，成功完成后对话显示产物卡片，点击时读取原来源。
- 不运行旧的提示词预检或配置替换脚本；旧预检脚本已删除。

## 为什么保留空操作 revision

早期 PR 版本已发布 `a9c4e7b2d610`，部分本地或测试数据库可能已执行它，或在首次建库时被标记到这个版本。直接删除 revision 会使这些环境报 `Can't locate revision identified by 'a9c4e7b2d610'`。

因此保留同一个 revision ID 和前置 `f3a7c9e1b2d4`，但 `upgrade()`、`downgrade()` 均为空操作，不获取连接、不查询或写入业务表，也不执行 DDL。Alembic 正常跨越该节点时仅维护自己的版本记录。这不是保留原来的自动数据迁移。

| 已有状态 | 更新代码后的行为 |
| --- | --- |
| 仍在前置 revision | 跨越空节点时只推进 Alembic 版本，不修改旧 Ghost。 |
| 已记录 `a9c4e7b2d610` | 版本仍可识别，不需要 `stamp`、重置或删除版本记录。 |
| 旧迁移曾改写提示词 | 当前值保持不变，不自动反向替换或恢复备份。 |
| Ghost 已被管理员定制 | 配置保持不变。 |

## 检查与回滚边界

版本检查应由环境负责人使用该环境已批准的连接完成，连接口令不得写入命令或日志：

```bash
cd backend
uv run alembic current
uv run alembic heads
uv run alembic history -r f3a7c9e1b2d4:a9c4e7b2d610
```

这些命令用于查看版本，不替换提示词。本次代码修复不连接或修改生产数据库，也不要求对生产执行升级、降级或 `stamp`。

若需要回退到移除该 revision 定义的旧代码，应先单独规划版本兼容性，不能直接删除 `alembic_version` 或盲目 `stamp head`。当前空节点的 downgrade 只改变版本记录，**不会撤销早期版本已经修改过的提示词**；恢复业务配置必须另获批准，并使用受控备份逐项核对。

回归测试使用隔离数据库覆盖前置与已执行 revision 的升级/降级、旧/已迁移/定制/新配置原样保留；Web E2E 使用旧 Ghost 提示词验证 Claude Code 和 Codex 的运行时注入、真实声明、即时卡片及下载，不改写公共内置资源。

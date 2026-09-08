---
sidebar_position: 1
title: Smart App telemetry taxonomy
---

# 智能工作台统计事件命名与属性契约

## 目标

为智能工作台首版漏斗提供一个可稳定查询、可跨页面聚合且不包含敏感标识的数据契约。首版覆盖“浏览 → 安装或更新 → 打开”，包括市场安装、ZIP 导入、市场更新，以及相应失败路径。

## 已确认决策

- 所有智能工作台遥测事件均带 `domain: 'smart_app'`。
- 继续复用平台通用事件；不为同一业务动作同时发送通用事件和专属事件。
- 专属事件使用 `smart_app_` 前缀；操作失败的 `operation` 枚举也使用该前缀。
- 不使用 `*_smart_app` 后缀，避免和既有 `smart_app_*` 规则混用。
- 不上报工作台 ID、名称、市场 ID、ZIP 文件名、文件路径、错误正文或其他可识别内容。

## 事件契约

| 业务事实 | 事件名 | 属性 |
| --- | --- | --- |
| 打开市场 | `feature_opened` | `domain: 'smart_app'`, `feature: 'smart_apps_marketplace'` |
| 打开我的工作台 | `feature_opened` | `domain: 'smart_app'`, `feature: 'smart_apps_owned'` |
| 打开已安装的具体工作台 | `feature_opened` | `domain: 'smart_app'`, `feature: 'smart_app'` |
| 市场首次安装完成 | `smart_app_installed` | `domain: 'smart_app'`, `install_source: 'marketplace'` |
| ZIP 导入完成 | `smart_app_installed` | `domain: 'smart_app'`, `install_source: 'zip_import'` |
| 市场更新完成 | `feature_action_completed` | `domain: 'smart_app'`, `action: 'update'` |
| 市场包下载失败 | `operation_failed` | `domain: 'smart_app'`, `operation: 'smart_app_marketplace_download'` |
| 市场安装失败 | `operation_failed` | `domain: 'smart_app'`, `operation: 'smart_app_marketplace_install'` |
| 市场更新失败 | `operation_failed` | `domain: 'smart_app'`, `operation: 'smart_app_marketplace_update'` |
| ZIP 导入失败 | `operation_failed` | `domain: 'smart_app'`, `operation: 'smart_app_zip_import'` |

事件只在业务事实实际成立之后发送：安装或导入在安装 API 成功并得到安装状态后发送；失败只在对应的异常或失败分支发送。页面打开仍使用路由层的统一上报，不在页面组件中重复上报。

## 命名与查询规则

`domain = 'smart_app'` 是所有智能工作台数据的主筛选条件。它覆盖通用事件、专属事件和失败事件，因此可以构建完整的首版漏斗。

`smart_app_` 是专属事件名和失败操作枚举的辅助前缀：例如 `smart_app_installed` 与 `smart_app_marketplace_install`。它用于快速识别智能工作台专属事件，但不作为完整漏斗的唯一筛选条件，因为 `feature_opened` 和 `feature_action_completed` 是共享平台事件。

## 契约实现边界

在 `wework/src/telemetry/events.ts` 中，每次新增或扩展属性时，同步更新以下三处：

1. `AnalyticsEventMap` 的 TypeScript 事件属性类型；
2. `ANALYTICS_EVENT_PROPERTY_KEYS` 的属性白名单；
3. `ANALYTICS_EVENT_VALUE_CONSTRAINTS` 的枚举约束。

对于 `feature_opened` 与 `operation_failed`，`domain` 必须能表达智能工作台所属域，同时不能要求不相关的既有调用方提供该属性。实现应使用能够保留既有调用契约的类型设计，并确保智能工作台调用点始终显式传递 `domain: 'smart_app'`。

## 验证

- 事件契约测试覆盖属性类型、白名单和值约束三处同步更新。
- 路由测试覆盖市场、我的工作台和具体工作台的 `feature_opened` 属性。
- 业务测试覆盖市场安装、市场更新和 ZIP 导入只在实际成功后上报；失败只发送相应的 `operation_failed`。
- 每个智能工作台调用断言均含 `domain: 'smart_app'`。
- 隐私测试或断言确保 ID、名称、文件路径和错误正文未进入 telemetry。

## 非目标

首版不统计搜索、筛选、详情浏览、创建或复制工作台、关联目录、导出、删除、开发助手或添加插件。遥测上报不可用时必须吞掉自身失败，不影响安装、导入、更新或打开工作台的主流程。

# Smart App telemetry taxonomy

## Summary

Every Smart App telemetry payload uses `domain: 'smart_app'` as its primary query key. Shared platform events remain shared, while dedicated event names and Smart App failure-operation values use the `smart_app_` prefix. No duplicate event is emitted for a single business fact.

The event table above defines the first-release funnel: browse, install or update, and open. It deliberately excludes identifiers, names, files, paths, and error bodies. Contract changes must update the type map, property allowlist, and value constraints together, with tests for successful, failed, route, and privacy paths.

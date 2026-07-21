---
sidebar_position: 12
---

# 外部知识源

[English](../../en/developer-guide/external-knowledge-sources.md) | 简体中文

外部知识源让 Wegent 在一次任务运行中同时检索内置知识库和受信任的外部内容系统。它面向运行时检索，不负责实现某个具体 provider，也不把 provider 专属界面、文案或路由放进 core。

这个能力和外部知识库 MCP 的方向不同：外部知识库 MCP 是让外部系统访问 Wegent 的知识库；外部知识源是让 Wegent 在任务执行时读取外部系统中用户选择的知识记录。

## 设计目标

- 让 Backend 和 Chat Shell 可以通过统一协议检索外部知识。
- 让前端可以选择外部知识源、展示来源引用，并按 provider 打开来源。
- 保持 core provider-neutral，下游系统自行注册 provider 实现、opener 和来源视图。
- 外部 provider 失败时按来源降级，不影响内置知识库检索。

## Provider 协议和注册表

`RetrievalSourceProvider` 是 Backend 的外部检索源协议。一个 provider 负责：

- 声明自己的 provider id 和能力。
- 校验并解析任务中的外部知识引用。
- 为 `internal_retrieve` 返回可合并的外部记录。
- 可选地提供文档列表能力，供前端或 agent 浏览可选内容。

registry 是 core 和 provider 之间的边界。Core 只依赖 registry 查找 provider，不 import 下游实现。下游部署在启动时注册 provider；如果某个 provider 不存在或不可用，core 应把该来源标记为失败或忽略，而不是让整个检索请求失败。

## Task 级运行时绑定

`externalKnowledgeRefs` 是 Task 级 runtime binding。它描述当前任务运行时选择了哪些外部知识源，和 Ghost、Bot 或 Team 的默认配置不同。

关键约束：

- 不把外部知识源作为 Ghost 默认知识配置写入。
- 不把 provider 私有鉴权材料写入 Task spec。
- 不把外部原始 URL 持久化到 source payload；如需定位来源，使用稳定、可校验、可由 provider 解释的 `source_uri`。
- Task detail、WebSocket payload 和 Chat Shell metadata 只透传 provider-neutral 字段。

### 引用字段

`externalKnowledgeRefs[]` 使用 provider-neutral 字段，不保存 provider 私有对象：

| 字段                                    | 说明                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                              | provider id。                                                                                                                                     |
| `mode`                                  | 绑定模式，通常为 `explicit`；`all_accessible` 表示 provider 可解释的全部可访问范围。                                                              |
| `id`                                    | provider 内稳定的知识源 ID。`mode=explicit` 时必填。                                                                                              |
| `name`                                  | 用户可读的知识源名称，例如知识库名。                                                                                                              |
| `scope`                                 | provider 可解释的范围，例如 `personal`、`group` 或 `organization`。                                                                               |
| `target_type`                           | 可选目标类型：`knowledge_base`、`folder` 或 `document`。缺省按整库处理。                                                                          |
| `node_id` / `document_id` / `parent_id` | provider-neutral 的目录或文档定位字段。                                                                                                           |
| `target_name`                           | 当选择的是文件夹或文档时的目标展示名。文档级引用应保留 `name` 为知识源名，并用 `target_name` 保存文档名，避免后续来源列表把文档名误当成知识源名。 |

### 管理入口和 API

外部知识源会像内置知识库一样形成 Task 级绑定，影响后续消息。用户取消输入框中的本轮选择不会解除 Task 级绑定；移除绑定只影响后续执行请求，不会修改历史消息上的 context 展示。

前端应复用原任务/群聊管理入口中的“知识库”页签，把内置知识库和外部知识源放在同一个列表中展示，而不是在输入框上下文选择器中单独维护一套“已绑定外部知识”管理入口。外部条目使用短 provider badge 区分，例如 `AP`。

Backend 提供以下 Task 级外部绑定管理接口：

| 方法   | 路径                                                  | 说明                                       |
| ------ | ----------------------------------------------------- | ------------------------------------------ |
| `GET`  | `/api/tasks/{task_id}/external-knowledge-refs`        | 返回当前 Task 已绑定的外部知识引用。       |
| `POST` | `/api/tasks/{task_id}/external-knowledge-refs/remove` | 按规范化 target key 移除一个外部知识引用。 |

移除接口请求体为：

```json
{
  "ref": {
    "provider": "ap",
    "mode": "explicit",
    "id": "kb-1",
    "target_type": "document",
    "node_id": "document:node-1",
    "document_id": "node-1"
  }
}
```

管理 UI 必须把外部绑定加载失败视为非阻断错误：内置知识库列表和解绑能力仍应可用，外部失败只显示局部提示。

## 检索合并流程

`internal_retrieve` 负责把内置知识库记录和外部 provider 返回的记录合并给 Chat Shell。推荐流程：

1. 读取 Task spec 中的 `externalKnowledgeRefs`。
2. 先执行内置知识库检索，保留原有权限和索引行为。
3. 按 provider 分组调用 registry 中的 `RetrievalSourceProvider`。
4. 将外部记录转换成统一的上下文片段和引用字段。
5. 合并结果并返回检索摘要。

外部 provider 的错误必须按来源隔离。某个来源超时、鉴权失败或返回空结果时，只应影响该来源的 status；内置知识库命中和其他 provider 结果仍应返回。

## 来源溯源字段

外部记录进入消息、工具事件或引用列表时，应使用 provider-neutral provenance 字段：

| 字段          | 说明                                                    |
| ------------- | ------------------------------------------------------- |
| `source_type` | 来源类型或 provider namespace，用于区分内置和外部来源。 |
| `source_id`   | provider 内部稳定 ID。                                  |
| `source_uri`  | provider 可解释的稳定 URI，不应是外部原始下载 URL。     |
| `source_name` | 用户可读的来源名称。                                    |

引用渲染应能在缺少 opener 或 provider 不可用时降级为纯文本来源，不应丢失消息主体。

## Opener 和来源视图接缝

前端 core 只提供两个 registry：

- external source opener registry：把引用交给 provider opener 打开。
- knowledge source view registry：在统一知识入口中挂载 provider-neutral 的来源视图。

Core 不包含下游 provider 的 opener 代码、路由、图标文案或业务 API。下游前端包可以在自己的初始化代码中注册 opener 和来源视图；没有注册时，core 使用 fallback 展示来源名称和基本 metadata。

## 可选文档列表能力

`knowledge_list_documents` 是可选 provider capability，用于列出某个外部来源下可选择的文档或记录。它不是某个 provider 的专属工具。

实现要求：

- provider 自行负责权限过滤和分页。
- core 只消费 provider-neutral 的列表结果。
- Backend external listing endpoint 的分页语义是 `pagination_scope: "per_provider"`；Chat Shell 聚合内置知识库和外部来源后返回 `pagination_scope: "per_source"`。调用方不应把这些字段解释成全局合并后的分页窗口。
- capability 不存在时，前端应隐藏或禁用对应的浏览入口，而不是让任务执行失败。

## 安全和纯净度规则

- Core 必须保持 provider-neutral。
- Core 不应出现 provider-specific copy、route、import 或注册代码。
- 外部原始 URL 不应持久化到 source payload。
- Provider failure 必须按来源降级，不能破坏内置知识库检索。
- 传给模型的内容应是经过权限校验和格式化后的片段，而不是 provider 原始响应。
- 日志和检索摘要可以记录 provider id、source id、状态和计数，但不能记录敏感鉴权数据。

## 测试建议

- 使用 fake provider 覆盖 registry、成功检索、空结果和失败降级。
- Core tests 不使用 provider-specific fixtures。
- 覆盖内置知识库和外部来源同时命中的合并顺序。
- 覆盖 `source_type`、`source_id`、`source_uri`、`source_name` 的透传和消息展示。
- 覆盖 opener 未注册时的 fallback。
- 覆盖 `knowledge_list_documents` capability 不存在时的 UI 和工具降级行为。

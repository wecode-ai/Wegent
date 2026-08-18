---
sidebar_position: 5
---

# 共享能力引用解析

## 范围

约束 Model、Retriever、Shell 等能力从个人或团队可见引用解析到源 Kind 的过程。

## 连线图

```mermaid
flowchart LR
    C["调用方"] --> R["共享引用解析器"]
    R --> K["kinds：配置事实源"]
    R --> N["namespace：目标范围"]
    R --> M["resource_members：共享授权事实源"]
    R --> S["源 Kind"]
```

## 时序图

```mermaid
sequenceDiagram
    participant C as 调用方
    participant R as 共享引用解析器
    participant DB as 数据库
    C->>R: kind、name、可见 namespace、user_id
    R->>DB: 查可见 namespace 下的直接 Kind
    alt 直接 Kind 存在
        DB-->>R: 源 Kind
    else 直接 Kind 不存在
        R->>DB: 查有效 namespace 与 approved 引用
        DB-->>R: 引用指向的有效源 Kind
    end
    R-->>C: 源 Kind 或不可用
```

## 代码归属

| 职责 | 归属 |
| --- | --- |
| 单个能力的直接与引用解析 | `shared/db/capability_reference.py` |
| 共享关系创建、解绑和列表 | `backend/app/services/capability_reference_service.py` |
| Backend RAG 配置构建 | `backend/app/services/rag/runtime_resolver.py` |
| Knowledge Runtime 配置构建 | `knowledge_runtime/knowledge_runtime/services/config_resolver.py` |

## 必要不变量

- `Kind` 是能力配置的唯一事实源；共享不得复制配置或密钥。
- `ResourceMember` 是共享授权事实源；共享引用仅在目标 namespace 有效且为 approved 时可解析。
- 引用中的 namespace 表示调用方可见范围，不要求等于源 Kind 的 namespace。
- 同名直接 Kind 优先于共享引用。
- Backend 与所有 Runtime 必须复用同一个解析器；解绑或停用后必须立即不可用。

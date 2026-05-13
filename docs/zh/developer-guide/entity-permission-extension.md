---
sidebar_position: 13
---

# 实体权限扩展

本文档介绍 Wegent 的统一资源分享权限架构，涵盖当前授权机制、权限处理逻辑、扩展架构设计，以及如何通过 `IExternalEntityResolver` 接入内部定制化授权系统。

## 概述

Wegent 的权限系统基于 `ResourceMember` 模型实现，支持两种成员绑定方式：

- **直接用户绑定** (`entity_type="user"`)：将具体用户添加为资源成员
- **实体绑定** (`entity_type="namespace"` 或自定义类型)：将外部实体（如群组、部门）绑定到资源，实体内的成员自动继承访问权限

实体绑定的核心扩展点是 `IExternalEntityResolver` 接口。开源版本内置了 `namespace` 类型的解析器，内部部署可通过注册自定义解析器接入企业组织架构（如部门、项目团队）。

## 当前授权机制

### 统一角色体系

系统使用 `BaseRole` 作为唯一的角色定义源：

| 角色 | 权限级别 | 说明 |
|------|---------|------|
| **Owner** | 最高 | 完全控制，可删除资源、转移所有权 |
| **Maintainer** | 高 | 管理成员和设置 |
| **Developer** | 中 | 修改内容 |
| **Reporter** | 低 | 只读访问 |
| **RestrictedAnalyst** | 最低 | 受限的只读访问 |

角色冲突时，系统自动选择**最高权限**的角色。该逻辑由 `has_permission()` 和 `get_highest_role()` 实现。

### 成员状态

`ResourceMember.status` 有三种状态：

- `pending`：待审批
- `approved`：已批准（只有 approved 的成员才参与权限计算）
- `rejected`：已拒绝

### 资源成员模型

```
ResourceMember
├── resource_type: str      # 资源类型，如 "KnowledgeBase"
├── resource_id: int        # 资源 ID
├── entity_type: str        # "user" | "namespace" | 自定义类型
├── entity_id: str          # 实体标识符
├── role: str               # 角色值
├── status: str             # pending | approved | rejected
└── user_id: int | None     # 兼容字段，user 类型时自动同步
```

唯一约束：`(resource_type, resource_id, entity_type, entity_id)`

### 归属与授权的分离

权限系统中存在两个容易混淆的核心概念，必须明确区分：

| 维度 | 归属（Ownership） | 授权（Authorization） |
|------|-----------------|---------------------|
| **判定依据** | 资源的 `user_id` 字段（如 `Kind.user_id`） | `ResourceMember` 记录中的 `role` 字段 |
| **典型示例** | 知识库的创建者 | 被添加为成员并分配了 Owner 角色的用户 |
| **数据库体现** | 资源表的一行字段 | `resource_members` 表的一条记录 |
| **权限来源** | 天然拥有完全访问权限，无需 `ResourceMember` 记录 | 必须通过成员绑定获得 |

**关键区别：**

1. **创建者（Creator）不等于 ResourceMember 中的 Owner**
   - 创建者由 `kb.user_id == user_id` 判定
   - `ResourceMember(role="Owner")` 是被授权的成员，不一定是创建者
   - 创建者可以没有任何 `ResourceMember` 记录仍然拥有完全权限

2. **权限计算时两者是独立来源**
   - `_compute_kb_access_core()` 中，`is_creator` 和 `roles`（来自 ResourceMember）是**分别计算**的两条线
   - 最终 `has_access = len(roles) > 0 or is_creator`
   - 即使没有任何授权记录，创建者始终有访问权限

3. **所有权转移只改变归属，不改变授权记录**
   - 转移后，新归属者的 `user_id` 被写入资源表
   - 旧的 `ResourceMember` 记录不会被自动删除
   - 如果旧创建者同时有 `ResourceMember(role="Owner")` 记录，转移后该记录仍然有效

4. **前端展示中的区分**
   - `PermissionSourceInfo.source_type="creator"` 表示归属来源
   - `PermissionSourceInfo.source_type="direct"` 表示直接授权来源
   - 创建者也会作为权限来源之一出现在 `get_my_permission_sources()` 的返回中

## 权限处理逻辑

### 直接权限检查流程

`UnifiedShareService.check_permission()` 的调用链路：

```
check_permission(resource_id, user_id, required_role)
├── 1. 查询 ResourceMember
│      resource_type = {resource_type}
│      entity_type = "user"
│      entity_id = str(user_id)
│      status = "approved"
│      → 找到直接绑定
│      → 用 has_permission(effective_role, required_role) 判断
│      → 满足则返回 True
│
└── 2. 未找到直接绑定 → 回退到 check_entity_permission()
```

### 实体权限回退流程

`check_entity_permission()` 的调用链路：

```
check_entity_permission(resource_id, user_id, required_role)
├── 1. 查询该资源的所有 entity_type != "user" 的 approved 绑定
│      按 entity_type 分组为 {entity_type: [(entity_id, role), ...]}
│
├── 2. 遍历每个 entity_type
│      resolver = get_entity_resolver(entity_type)
│      matched = resolver.match_entity_bindings(db, user_id, entity_type, entity_ids)
│      → 如果 matched 非空
│      → 检查 matched 中每个 entity_id 对应的 role 是否满足 required_role
│      → 满足则返回 True
│
└── 3. 无匹配 → 返回 False
```

### 角色冲突解决

当用户同时具有直接绑定和实体绑定时，`get_user_role()` 的处理逻辑：

```
get_user_role(resource_id, user_id)
├── direct_role = 直接用户绑定的角色
│   如果 direct_role == "Owner" → 直接返回 Owner
│
├── entity_role = _get_highest_entity_role()
│   遍历所有实体绑定
│   对每个 entity_type 调用 match_entity_bindings()
│   取匹配实体中的最高角色
│
└── 如果同时存在 direct_role 和 entity_role
    → 返回两者中的更高权限
```

### 列表查询中的实体权限

`KnowledgeService.get_all_knowledge_bases_grouped()` 在获取知识库列表时，需要一并获取通过实体绑定可访问的知识库。该逻辑由 `_collect_entity_authorized_kbs()` 实现：

```
_collect_entity_authorized_kbs(user_id, accessible_groups)
├── Step 1: 处理 namespace 类型（硬编码优化路径）
│   将 accessible_groups 转换为 namespace IDs
│   查询 ResourceMember (entity_type="namespace", entity_id in namespace_ids)
│   收集这些资源及其分组、角色信息
│
└── Step 2: 处理外部实体类型（通过解析器）
    遍历所有已注册的 entity_type（除 "namespace"、"user" 外）
    resolver = get_entity_resolver(entity_type)
    resolved_kb_ids = resolver.get_resource_ids_by_entity(db, user_id, entity_type)
    → 查询这些 KB 对应的 ResourceMember 行
    → 用 match_entity_bindings() 过滤出用户实际匹配的 entity_id
    → 收集角色和分组信息
```

## 扩展架构设计

### Share Service 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  API Layer                                                  │
│  - /api/v1/share/members (add/remove/get members)           │
│  - /api/v1/knowledge (list with permissions)                │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  Service Layer                                              │
│  UnifiedShareService (base_service.py)                      │
│  ├── check_permission() / check_entity_permission()         │
│  ├── get_user_role() / _get_highest_entity_role()           │
│  ├── add_member() / remove_member() / get_members()         │
│  └── get_my_permission_sources()                            │
│                                                             │
│  KnowledgeShareService (knowledge_share_service.py)         │
│  └── 知识库特定的权限逻辑                                    │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  Resolver Layer                                             │
│  IExternalEntityResolver (external_entity_resolver.py)      │
│  ├── NamespaceEntityResolver (namespace_entity_resolver.py) │
│  └── [Custom Resolvers] 通过 register_entity_resolver() 注册 │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  Model Layer                                                │
│  ResourceMember (resource_member.py)                        │
│  └── Polymorphic: (entity_type, entity_id)                  │
└─────────────────────────────────────────────────────────────┘
```

### IExternalEntityResolver 接口

```python
class IExternalEntityResolver(ABC):
    @abstractmethod
    def match_entity_bindings(
        self, db, user_id, entity_type, entity_ids, user_context=None
    ) -> list[str]:
        """返回 entity_ids 中该用户实际匹配的 ID 列表"""

    @abstractmethod
    def get_resource_ids_by_entity(
        self, db, user_id, entity_type, user_context=None
    ) -> list[int]:
        """返回该用户通过此实体类型可访问的所有资源 ID"""

    @property
    def requires_display_name_snapshot(self) -> bool:
        """是否需要持久化显示名称快照（默认 True）"""
        return True

    def get_display_name(self, db, entity_id) -> Optional[str]:
        """解析单个实体的显示名称"""
        return None

    def batch_get_display_names(self, db, entity_ids) -> dict[str, str]:
        """批量解析显示名称（默认逐个调用 get_display_name）"""
```

### 解析器注册机制

解析器通过模块级注册表管理，在应用启动时注册：

```python
# app/services/share/__init__.py
register_entity_resolver("namespace", NamespaceEntityResolver)
# register_entity_resolver("department", DepartmentResolver)  # 自定义
```

注册后：
- `get_entity_resolver("namespace")` 返回单例实例
- `get_all_entity_types()` 返回所有已注册的类型列表
- 实例被缓存，重复获取返回同一对象

## 拓展机制

### 内置解析器：NamespaceEntityResolver

`NamespaceEntityResolver` 处理 `entity_type="namespace"` 的绑定。核心逻辑：

**match_entity_bindings()**：
- 输入：`entity_ids` = 绑定的 namespace ID 列表（字符串）
- 查询 `ResourceMember` (resource_type="Namespace", entity_type="user", entity_id=str(user_id), status="approved")
- 返回用户实际属于的 namespace ID 子集

**get_resource_ids_by_entity()**：
- 先查用户属于哪些 namespace
- 再查这些 namespace 绑定了哪些 KnowledgeBase
- 返回去重后的 KB ID 列表

**requires_display_name_snapshot**：`False`
- namespace 名称可以从本地 `Namespace` 表实时查询，无需持久化快照

### 自定义解析器实现步骤

实现自定义解析器需要以下步骤：

**Step 1：创建解析器类**

```python
# app/services/share/department_resolver.py
from typing import Optional
from sqlalchemy.orm import Session
from app.services.share.external_entity_resolver import IExternalEntityResolver

class DepartmentResolver(IExternalEntityResolver):
    """企业部门权限解析器示例"""

    @property
    def requires_display_name_snapshot(self) -> bool:
        # 部门名称可从企业 API 实时查询，不持久化快照
        return False

    def match_entity_bindings(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        entity_ids: list[str],
        user_context: Optional[dict] = None,
    ) -> list[str]:
        if entity_type != "department":
            return []

        # 查询用户所属部门（示例：从企业系统或本地缓存表）
        user_dept_ids = self._get_user_department_ids(user_id)

        # 返回交集
        return list(set(entity_ids) & set(user_dept_ids))

    def get_resource_ids_by_entity(
        self,
        db: Session,
        user_id: int,
        entity_type: str,
        user_context: Optional[dict] = None,
    ) -> list[int]:
        if entity_type != "department":
            return []

        # 获取用户所属的所有部门
        user_dept_ids = self._get_user_department_ids(user_id)
        if not user_dept_ids:
            return []

        # 查询这些部门绑定的知识库
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        results = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.entity_type == "department",
                ResourceMember.entity_id.in_(user_dept_ids),
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        return list(set(r.resource_id for r in results))

    def get_display_name(self, db: Session, entity_id: str) -> Optional[str]:
        # 从企业系统或缓存表查询部门名称
        return self._query_department_name(entity_id)

    def _get_user_department_ids(self, user_id: int) -> list[str]:
        # 内部实现：调用企业组织架构 API 或查询本地缓存
        pass

    def _query_department_name(self, entity_id: str) -> Optional[str]:
        pass
```

**Step 2：注册解析器**

```python
# app/services/share/__init__.py
from app.services.share.department_resolver import DepartmentResolver

register_entity_resolver("department", DepartmentResolver)
```

**Step 3：添加资源成员**

通过 API 或 Service 层将部门绑定到知识库：

```python
knowledge_share_service.add_member(
    db,
    resource_id=kb_id,
    current_user_id=owner_id,
    target_user_id=0,  # entity 类型时 target_user_id 为 0
    role=MemberRole.Reporter,
    entity_type="department",
    entity_id="dept_123",
    entity_display_name="技术部",  # 可选，若 requires_display_name_snapshot=True 则持久化
)
```

## 使用示例

### 完整场景：按部门共享知识库

**场景**：公司希望将 "产品规范" 知识库共享给 "产品部" 的所有成员。

**实现**：

1. 实现 `DepartmentResolver`（如上代码）
2. 在知识库权限管理中，Owner 添加部门成员：
   - entity_type = "department"
   - entity_id = "dept_product"
   - role = "Developer"
3. 产品部成员登录后：
   - `get_all_knowledge_bases_grouped()` 调用 `DepartmentResolver.get_resource_ids_by_entity()`
   - 发现该成员属于 "dept_product"，返回 KB ID
   - 知识库出现在成员的 "与我共享" 列表中
4. 成员访问知识库时：
   - `check_permission()` 未找到直接绑定
   - 回退到 `check_entity_permission()`
   - `DepartmentResolver.match_entity_bindings()` 确认成员属于 "dept_product"
   - 权限检查通过

### 前端权限来源展示

前端通过 `PermissionSourceInfo` 展示用户如何获得权限：

- `direct`：直接添加为成员
- `entity`：通过实体（部门、群组）获得
- `link`：通过分享链接获得

当来源为 `entity` 时，前端调用 `get_display_name()` 或显示 `entity_display_name` 快照来展示实体名称。

## 最佳实践

1. **解析器应尽量轻量化**：`match_entity_bindings()` 在每次权限检查时都可能被调用，避免重量级查询。必要时引入本地缓存表或 Redis 缓存

2. **批量查询优于逐条查询**：如果底层系统支持批量 API，应重写 `batch_get_display_names()` 以避免 N+1 问题

3. **display_name 快照策略**：
   - 如果实体名称来自**可靠本地数据源**（如 Namespace 表），设置 `requires_display_name_snapshot = False`
   - 如果实体名称来自**外部系统**（如企业 API），设置 `requires_display_name_snapshot = True`，让系统在添加成员时持久化快照

4. **避免循环依赖**：解析器实现中不要导入 `KnowledgeShareService` 等上层 Service，保持 Resolver Layer 的独立性

5. **user_context 复用**：在列表查询等批量场景中，上层 Service 可将用户资料数据传入 `user_context`，避免解析器内部重复查询用户信息

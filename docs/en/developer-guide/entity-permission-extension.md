---
sidebar_position: 13
---

# Entity Permission Extension

This document describes Wegent's unified resource sharing permission architecture, covering the current authorization mechanism, permission processing logic, extension architecture design, and how to integrate internal customized authorization systems via `IExternalEntityResolver`.

## Overview

Wegent's permission system is implemented based on the `ResourceMember` model and supports two member binding modes:

- **Direct User Binding** (`entity_type="user"`): Add a specific user as a resource member
- **Entity Binding** (`entity_type="namespace"` or custom types): Bind an external entity (e.g., group, department) to a resource, and members within the entity automatically inherit access permissions

The core extension point for entity binding is the `IExternalEntityResolver` interface. The open-source version includes a built-in `namespace` type resolver, while internal deployments can register custom resolvers to integrate with enterprise organizational structures (e.g., departments, project teams).

## Current Authorization Mechanism

### Unified Role System

The system uses `BaseRole` as the single source of truth for role definitions:

| Role | Permission Level | Description |
|------|-----------------|-------------|
| **Owner** | Highest | Full control, can delete resources and transfer ownership |
| **Maintainer** | High | Manage members and settings |
| **Developer** | Medium | Modify content |
| **Reporter** | Low | Read-only access |
| **RestrictedAnalyst** | Lowest | Restricted read-only access |

When role conflicts occur, the system automatically selects the **highest permission** role. This logic is implemented by `has_permission()` and `get_highest_role()`.

### Member Status

`ResourceMember.status` has three states:

- `pending`: Awaiting approval
- `approved`: Approved (only approved members participate in permission calculations)
- `rejected`: Rejected

### Resource Member Model

```
ResourceMember
├── resource_type: str      # Resource type, e.g., "KnowledgeBase"
├── resource_id: int        # Resource ID
├── entity_type: str        # "user" | "namespace" | custom type
├── entity_id: str          # Entity identifier
├── role: str               # Role value
├── status: str             # pending | approved | rejected
└── user_id: int | None     # Compatibility field, auto-synced for user type
```

Unique constraint: `(resource_type, resource_id, entity_type, entity_id)`

### Ownership vs Authorization

The permission system has two core concepts that are easily confused and must be clearly distinguished:

| Dimension | Ownership | Authorization |
|-----------|-----------|---------------|
| **Determination basis** | Resource's `user_id` field (e.g., `Kind.user_id`) | `role` field in `ResourceMember` records |
| **Typical example** | Creator of the knowledge base | A user added as a member and assigned the Owner role |
| **Database representation** | A field in the resource table row | A record in the `resource_members` table |
| **Permission source** | Naturally has full access without `ResourceMember` records | Must be obtained through member binding |

**Key distinctions:**

1. **Creator is not equal to Owner in ResourceMember**
   - Creator is determined by `kb.user_id == user_id`
   - `ResourceMember(role="Owner")` is an authorized member, not necessarily the creator
   - The creator always has full permissions even without any `ResourceMember` records

2. **Both are independent sources during permission computation**
   - In `_compute_kb_access_core()`, `is_creator` and `roles` (from ResourceMember) are **computed separately**
   - Final result: `has_access = len(roles) > 0 or is_creator`
   - Even without any authorization records, the creator always has access

3. **Ownership transfer only changes ownership, not authorization records**
   - After transfer, the new owner's `user_id` is written to the resource table
   - Old `ResourceMember` records are not automatically deleted
   - If the old creator also has a `ResourceMember(role="Owner")` record, it remains valid after transfer

4. **Distinction in frontend display**
   - `PermissionSourceInfo.source_type="creator"` indicates ownership source
   - `PermissionSourceInfo.source_type="direct"` indicates direct authorization source
   - The creator also appears as one of the permission sources in the return value of `get_my_permission_sources()`

## Permission Processing Logic

### Direct Permission Check Flow

The call chain of `UnifiedShareService.check_permission()`:

```
check_permission(resource_id, user_id, required_role)
├── 1. Query ResourceMember
│      resource_type = {resource_type}
│      entity_type = "user"
│      entity_id = str(user_id)
│      status = "approved"
│      → Found direct binding
│      → Check with has_permission(effective_role, required_role)
│      → If satisfied, return True
│
└── 2. No direct binding found → Fallback to check_entity_permission()
```

### Entity Permission Fallback Flow

The call chain of `check_entity_permission()`:

```
check_entity_permission(resource_id, user_id, required_role)
├── 1. Query all approved bindings with entity_type != "user" for this resource
│      Group by entity_type: {entity_type: [(entity_id, role), ...]}
│
├── 2. Iterate each entity_type
│      resolver = get_entity_resolver(entity_type)
│      matched = resolver.match_entity_bindings(db, user_id, entity_type, entity_ids)
│      → If matched is not empty
│      → Check if the role corresponding to each matched entity_id satisfies required_role
│      → If satisfied, return True
│
└── 3. No match → Return False
```

### Role Conflict Resolution

When a user has both direct binding and entity binding, `get_user_role()` handles it as follows:

```
get_user_role(resource_id, user_id)
├── direct_role = Role from direct user binding
│   If direct_role == "Owner" → Return Owner directly
│
├── entity_role = _get_highest_entity_role()
│   Iterate all entity bindings
│   Call match_entity_bindings() for each entity_type
│   Take the highest role among matched entities
│
└── If both direct_role and entity_role exist
    → Return the higher permission of the two
```

### Entity Permissions in List Queries

When `KnowledgeService.get_all_knowledge_bases_grouped()` retrieves the knowledge base list, it also needs to get knowledge bases accessible via entity binding. This logic is implemented by `_collect_entity_authorized_kbs()`:

```
_collect_entity_authorized_kbs(user_id, accessible_groups)
├── Step 1: Handle namespace type (hardcoded optimization path)
│   Convert accessible_groups to namespace IDs
│   Query ResourceMember (entity_type="namespace", entity_id in namespace_ids)
│   Collect these resources and their group, role information
│
└── Step 2: Handle external entity types (via resolvers)
    Iterate all registered entity_types (excluding "namespace", "user")
    resolver = get_entity_resolver(entity_type)
    resolved_kb_ids = resolver.get_resource_ids_by_entity(db, user_id, entity_type)
    → Query ResourceMember rows corresponding to these KBs
    → Filter out entity_ids that the user actually matches using match_entity_bindings()
    → Collect role and group information
```

## Extension Architecture Design

### Share Service Layered Architecture

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
│  └── Knowledge base specific permission logic               │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  Resolver Layer                                             │
│  IExternalEntityResolver (external_entity_resolver.py)      │
│  ├── NamespaceEntityResolver (namespace_entity_resolver.py) │
│  └── [Custom Resolvers] Registered via register_entity_resolver() │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│  Model Layer                                                │
│  ResourceMember (resource_member.py)                        │
│  └── Polymorphic: (entity_type, entity_id)                  │
└─────────────────────────────────────────────────────────────┘
```

### IExternalEntityResolver Interface

```python
class IExternalEntityResolver(ABC):
    @abstractmethod
    def match_entity_bindings(
        self, db, user_id, entity_type, entity_ids, user_context=None
    ) -> list[str]:
        """Return the list of entity IDs from entity_ids that the user actually matches"""

    @abstractmethod
    def get_resource_ids_by_entity(
        self, db, user_id, entity_type, user_context=None
    ) -> list[int]:
        """Return all resource IDs accessible by the user via this entity type"""

    @property
    def requires_display_name_snapshot(self) -> bool:
        """Whether to persist display name snapshots (default True)"""
        return True

    def get_display_name(self, db, entity_id) -> Optional[str]:
        """Resolve display name for a single entity"""
        return None

    def batch_get_display_names(self, db, entity_ids) -> dict[str, str]:
        """Batch resolve display names (defaults to individual get_display_name calls)"""
```

### Resolver Registration Mechanism

Resolvers are managed through a module-level registry and registered at application startup:

```python
# app/services/share/__init__.py
register_entity_resolver("namespace", NamespaceEntityResolver)
# register_entity_resolver("department", DepartmentResolver)  # Custom
```

After registration:
- `get_entity_resolver("namespace")` returns a singleton instance
- `get_all_entity_types()` returns the list of all registered types
- Instances are cached; repeated calls return the same object

## Extension Mechanism

### Built-in Resolver: NamespaceEntityResolver

`NamespaceEntityResolver` handles bindings with `entity_type="namespace"`. Core logic:

**match_entity_bindings()**:
- Input: `entity_ids` = List of bound namespace IDs (strings)
- Query `ResourceMember` (resource_type="Namespace", entity_type="user", entity_id=str(user_id), status="approved")
- Return the subset of namespace IDs that the user actually belongs to

**get_resource_ids_by_entity()**:
- First query which namespaces the user belongs to
- Then query which KnowledgeBases are bound to those namespaces
- Return deduplicated KB ID list

**requires_display_name_snapshot**: `False`
- Namespace names can be queried in real-time from the local `Namespace` table, no need to persist snapshots

### Custom Resolver Implementation Steps

Implementing a custom resolver requires the following steps:

**Step 1: Create the resolver class**

```python
# app/services/share/department_resolver.py
from typing import Optional
from sqlalchemy.orm import Session
from app.services.share.external_entity_resolver import IExternalEntityResolver

class DepartmentResolver(IExternalEntityResolver):
    """Enterprise department permission resolver example"""

    @property
    def requires_display_name_snapshot(self) -> bool:
        # Department names can be queried from enterprise API in real-time
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

        # Query user's departments (example: from enterprise system or local cache table)
        user_dept_ids = self._get_user_department_ids(user_id)

        # Return intersection
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

        # Get all departments the user belongs to
        user_dept_ids = self._get_user_department_ids(user_id)
        if not user_dept_ids:
            return []

        # Query knowledge bases bound to these departments
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
        # Query department name from enterprise system or cache table
        return self._query_department_name(entity_id)

    def _get_user_department_ids(self, user_id: int) -> list[str]:
        # Internal implementation: call enterprise org API or query local cache
        pass

    def _query_department_name(self, entity_id: str) -> Optional[str]:
        pass
```

**Step 2: Register the resolver**

```python
# app/services/share/__init__.py
from app.services.share.department_resolver import DepartmentResolver

register_entity_resolver("department", DepartmentResolver)
```

**Step 3: Add resource members**

Bind the department to a knowledge base via API or Service layer:

```python
knowledge_share_service.add_member(
    db,
    resource_id=kb_id,
    current_user_id=owner_id,
    target_user_id=0,  # target_user_id is 0 for entity types
    role=MemberRole.Reporter,
    entity_type="department",
    entity_id="dept_123",
    entity_display_name="Technology Department",  # Optional, persisted if requires_display_name_snapshot=True
)
```

## Usage Examples

### Complete Scenario: Sharing Knowledge Base by Department

**Scenario**: The company wants to share the "Product Specifications" knowledge base with all members of the "Product Department".

**Implementation**:

1. Implement `DepartmentResolver` (as shown in the code above)
2. In the knowledge base permission management, the Owner adds a department member:
   - entity_type = "department"
   - entity_id = "dept_product"
   - role = "Developer"
3. When a product department member logs in:
   - `get_all_knowledge_bases_grouped()` calls `DepartmentResolver.get_resource_ids_by_entity()`
   - Discovers that the member belongs to "dept_product", returns KB ID
   - The knowledge base appears in the member's "Shared with Me" list
4. When the member accesses the knowledge base:
   - `check_permission()` finds no direct binding
   - Falls back to `check_entity_permission()`
   - `DepartmentResolver.match_entity_bindings()` confirms the member belongs to "dept_product"
   - Permission check passes

### Frontend Permission Source Display

The frontend displays how users obtained their permissions via `PermissionSourceInfo`:

- `direct`: Added directly as a member
- `entity`: Obtained through an entity (department, group)
- `link`: Obtained through a share link

When the source is `entity`, the frontend calls `get_display_name()` or displays the `entity_display_name` snapshot to show the entity name.

## Best Practices

1. **Keep resolvers lightweight**: `match_entity_bindings()` may be called on every permission check. Avoid heavyweight queries. Introduce local cache tables or Redis caching when necessary.

2. **Batch queries over individual queries**: If the underlying system supports batch APIs, override `batch_get_display_names()` to avoid N+1 problems.

3. **Display name snapshot strategy**:
   - If entity names come from **reliable local data sources** (e.g., Namespace table), set `requires_display_name_snapshot = False`
   - If entity names come from **external systems** (e.g., enterprise APIs), set `requires_display_name_snapshot = True`, letting the system persist snapshots when adding members

4. **Avoid circular dependencies**: Resolver implementations should not import upper-layer Services like `KnowledgeShareService`. Keep the Resolver Layer independent.

5. **Reuse user_context**: In batch scenarios like list queries, the upper-layer Service can pass user profile data into `user_context`, preventing the resolver from redundantly querying user information internally.

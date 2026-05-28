---
sidebar_position: 5
---

# Resource Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a first-class Resource Library where users can discover, publish, install, and manage Agent, Skill, and MCP resources.

**Architecture:** Add a backend Resource Library domain with listing, version, and install records, then route installation through type-specific installers that copy into existing Team, Skill, and user MCP systems. Add a frontend `/resource-library` page with `发现` and `我的` task tabs, resource-type filters, publish flows, install actions, and sidebar navigation.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, Pydantic, pytest, Next.js 15, React 19, TypeScript, Jest, shadcn/ui, Tailwind CSS.

---

## Scope Check

This is a broad feature, but the subsystems are tightly coupled by one user workflow: publish a resource, discover it, install it, and see it under "我的". The implementation is split into vertical slices with passing tests and commits after each slice.

## File Structure

Backend files:

- Create `backend/app/models/resource_library.py`: SQLAlchemy models for listings, versions, installs, constants, and indexes.
- Modify `backend/app/models/__init__.py`: import the new models so `Base.metadata.create_all()` and Alembic see them.
- Create `backend/alembic/versions/20260527_e1f2a3b4c5d6_add_resource_library_tables.py`: create and drop the three resource library tables.
- Create `backend/app/schemas/resource_library.py`: Pydantic request/response models and typed manifest structures.
- Create `backend/app/services/resource_library/__init__.py`: service exports.
- Create `backend/app/services/resource_library/service.py`: listing/version CRUD, list/detail queries, publish orchestration, install orchestration.
- Create `backend/app/services/resource_library/manifest_builders.py`: create version manifest snapshots from Team, Skill, and MCP source inputs.
- Create `backend/app/services/resource_library/installers.py`: `AgentResourceInstaller`, `SkillResourceInstaller`, `McpResourceInstaller`.
- Create `backend/app/api/endpoints/adapter/resource_library.py`: FastAPI routes for discovery, "我的", publishing, installing, upgrading, and archiving.
- Modify `backend/app/api/api.py`: register the router at `/resource-library`.
- Create backend tests under `backend/tests/services/resource_library/` and `backend/tests/api/endpoints/test_resource_library.py`.

Frontend files:

- Create `frontend/src/apis/resourceLibrary.ts`: typed API client.
- Create `frontend/src/features/resource-library/types.ts`: UI-facing types.
- Create `frontend/src/features/resource-library/components/ResourceLibraryTabs.tsx`: `发现` / `我的` segmented control.
- Create `frontend/src/features/resource-library/components/ResourceTypeFilter.tsx`: `全部` / `智能体` / `Skill` / `MCP` filter.
- Create `frontend/src/features/resource-library/components/ResourceListingCard.tsx`: card with type badge, install state, install button.
- Create `frontend/src/features/resource-library/components/ResourceDetailDrawer.tsx`: resource details and install action.
- Create `frontend/src/features/resource-library/components/DiscoverResources.tsx`: discovery data loading, search, filters, grid.
- Create `frontend/src/features/resource-library/components/MyResources.tsx`: installed/published management.
- Create `frontend/src/features/resource-library/components/PublishResourceDialog.tsx`: publish flow for Agent, Skill, MCP.
- Create `frontend/src/features/resource-library/ResourceLibraryPage.tsx`: page composition.
- Create `frontend/src/app/(tasks)/resource-library/page.tsx`: route wrapper.
- Create `frontend/src/i18n/locales/zh-CN/resource-library.json` and `frontend/src/i18n/locales/en/resource-library.json`: translations.
- Modify `frontend/src/i18n/setup.ts`: register `resource-library` namespace.
- Modify `frontend/src/config/paths.ts`: add `paths.resourceLibrary`.
- Modify `frontend/src/features/tasks/components/sidebar/TaskSidebar.tsx`: add sidebar entry and `pageType`.
- Create frontend tests under `frontend/src/__tests__/features/resource-library/` and `frontend/src/__tests__/apis/resourceLibrary.test.ts`.

---

### Task 1: Backend Models, Schemas, and Migration

**Files:**
- Create: `backend/app/models/resource_library.py`
- Modify: `backend/app/models/__init__.py`
- Create: `backend/app/schemas/resource_library.py`
- Create: `backend/alembic/versions/20260527_e1f2a3b4c5d6_add_resource_library_tables.py`
- Test: `backend/tests/models/test_resource_library_models.py`
- Test: `backend/tests/schemas/test_resource_library_schema.py`

- [ ] **Step 1: Write failing model tests**

Create `backend/tests/models/test_resource_library_models.py`:

```python
from app.models.resource_library import (
    RESOURCE_LIBRARY_STATUS_PUBLISHED,
    RESOURCE_TYPE_AGENT,
    ResourceLibraryInstall,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)


def test_resource_library_listing_version_and_install_persist(test_db, test_user):
    listing = ResourceLibraryListing(
        resource_type=RESOURCE_TYPE_AGENT,
        name="research-agent",
        display_name="Research Agent",
        description="Collects and summarizes source material",
        tags=["research", "summary"],
        publisher_user_id=test_user.id,
        status=RESOURCE_LIBRARY_STATUS_PUBLISHED,
    )
    test_db.add(listing)
    test_db.commit()
    test_db.refresh(listing)

    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest={"resource_type": "agent", "team": {"name": "research-agent"}},
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()
    test_db.refresh(version)

    listing.current_version_id = version.id
    install = ResourceLibraryInstall(
        listing_id=listing.id,
        version_id=version.id,
        user_id=test_user.id,
        resource_type=RESOURCE_TYPE_AGENT,
        install_status="installed",
        installed_reference={
            "team_id": 101,
            "namespace": "default",
            "name": "research-agent",
        },
    )
    test_db.add(install)
    test_db.commit()
    test_db.refresh(install)

    assert listing.id > 0
    assert version.id > 0
    assert install.installed_reference["team_id"] == 101
```

- [ ] **Step 2: Write failing schema tests**

Create `backend/tests/schemas/test_resource_library_schema.py`:

```python
import pytest
from pydantic import ValidationError

from app.schemas.resource_library import (
    ResourceLibraryListingCreate,
    ResourceLibraryResourceType,
)


def test_listing_create_accepts_agent_skill_and_mcp_types():
    for resource_type in ("agent", "skill", "mcp"):
        payload = ResourceLibraryListingCreate(
            resource_type=resource_type,
            source_id=1,
            name=f"{resource_type}-demo",
            display_name=f"{resource_type} demo",
            description="Reusable resource",
            tags=["demo"],
            version="1.0.0",
        )
        assert payload.resource_type == resource_type


def test_listing_create_rejects_unknown_type():
    with pytest.raises(ValidationError):
        ResourceLibraryListingCreate(
            resource_type="plugin",
            source_id=1,
            name="bad",
            display_name="Bad",
            description="Bad resource",
            version="1.0.0",
        )


def test_resource_type_literal_values_are_stable():
    assert ResourceLibraryResourceType.__args__ == ("agent", "skill", "mcp")
```

- [ ] **Step 3: Run model and schema tests to verify they fail**

Run:

```bash
cd backend && uv run pytest tests/models/test_resource_library_models.py tests/schemas/test_resource_library_schema.py -v
```

Expected: FAIL with import errors for `app.models.resource_library` and `app.schemas.resource_library`.

- [ ] **Step 4: Implement SQLAlchemy models**

Create `backend/app/models/resource_library.py`:

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)

from app.db.base import Base

RESOURCE_TYPE_AGENT = "agent"
RESOURCE_TYPE_SKILL = "skill"
RESOURCE_TYPE_MCP = "mcp"

RESOURCE_LIBRARY_STATUS_PUBLISHED = "published"
RESOURCE_LIBRARY_STATUS_ARCHIVED = "archived"

INSTALL_STATUS_INSTALLED = "installed"
INSTALL_STATUS_REMOVED = "removed"
INSTALL_STATUS_FAILED = "failed"


class ResourceLibraryListing(Base):
    """Catalog entry for a reusable resource."""

    __tablename__ = "resource_library_listings"

    id = Column(Integer, primary_key=True, index=True)
    resource_type = Column(String(20), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    display_name = Column(String(200), nullable=True)
    description = Column(Text, nullable=True)
    icon = Column(String(100), nullable=True)
    tags = Column(JSON, nullable=False, default=list)
    publisher_user_id = Column(Integer, nullable=False, index=True)
    status = Column(
        String(20),
        nullable=False,
        default=RESOURCE_LIBRARY_STATUS_PUBLISHED,
        index=True,
    )
    current_version_id = Column(Integer, nullable=True)
    install_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=datetime.now, index=True)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
    )

    __table_args__ = (
        UniqueConstraint(
            "resource_type",
            "name",
            "publisher_user_id",
            name="uq_resource_library_listing_owner_name",
        ),
        Index(
            "ix_resource_library_listings_discovery",
            "status",
            "resource_type",
            "updated_at",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ResourceLibraryVersion(Base):
    """Versioned install package for a resource library listing."""

    __tablename__ = "resource_library_versions"

    id = Column(Integer, primary_key=True, index=True)
    listing_id = Column(
        Integer,
        ForeignKey("resource_library_listings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version = Column(String(50), nullable=False)
    manifest = Column(JSON, nullable=False)
    source_kind_id = Column(Integer, nullable=True)
    source_binary_id = Column(Integer, nullable=True)
    is_current = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.now)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
    )

    __table_args__ = (
        UniqueConstraint(
            "listing_id",
            "version",
            name="uq_resource_library_version_listing_version",
        ),
        Index(
            "ix_resource_library_versions_current",
            "listing_id",
            "is_current",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )


class ResourceLibraryInstall(Base):
    """User install record for a resource library version."""

    __tablename__ = "resource_library_installs"

    id = Column(Integer, primary_key=True, index=True)
    listing_id = Column(
        Integer,
        ForeignKey("resource_library_listings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_id = Column(
        Integer,
        ForeignKey("resource_library_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id = Column(Integer, nullable=False, index=True)
    resource_type = Column(String(20), nullable=False, index=True)
    installed_kind_id = Column(Integer, nullable=True)
    installed_reference = Column(JSON, nullable=False, default=dict)
    install_status = Column(
        String(20),
        nullable=False,
        default=INSTALL_STATUS_INSTALLED,
        index=True,
    )
    error_message = Column(Text, nullable=True)
    installed_at = Column(DateTime, nullable=False, default=datetime.now)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
    )

    __table_args__ = (
        UniqueConstraint(
            "listing_id",
            "user_id",
            name="uq_resource_library_install_listing_user",
        ),
        Index(
            "ix_resource_library_installs_user_type_status",
            "user_id",
            "resource_type",
            "install_status",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )
```

- [ ] **Step 5: Register models**

Modify `backend/app/models/__init__.py`:

```python
from app.models.resource_library import (
    ResourceLibraryInstall,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)
```

Add the three class names to `__all__`.

- [ ] **Step 6: Implement schemas**

Create `backend/app/schemas/resource_library.py`:

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

ResourceLibraryResourceType = Literal["agent", "skill", "mcp"]
ResourceLibraryListingStatus = Literal["published", "archived"]
ResourceLibraryInstallStatus = Literal["installed", "removed", "failed"]


class ResourceLibraryListingCreate(BaseModel):
    resource_type: ResourceLibraryResourceType
    source_id: int = Field(..., ge=1)
    name: str = Field(..., min_length=1, max_length=100)
    display_name: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    icon: Optional[str] = Field(None, max_length=100)
    tags: List[str] = Field(default_factory=list)
    version: str = Field(..., min_length=1, max_length=50)
    manifest_options: Dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryVersionCreate(BaseModel):
    source_id: int = Field(..., ge=1)
    version: str = Field(..., min_length=1, max_length=50)
    manifest_options: Dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryInstallCreate(BaseModel):
    version_id: Optional[int] = None
    target_namespace: Optional[str] = Field(default="default", max_length=100)
    install_options: Dict[str, Any] = Field(default_factory=dict)


class ResourceLibraryVersionResponse(BaseModel):
    id: int
    listing_id: int
    version: str
    manifest: Dict[str, Any]
    is_current: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ResourceLibraryListingResponse(BaseModel):
    id: int
    resource_type: ResourceLibraryResourceType
    name: str
    display_name: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    tags: List[str]
    publisher_user_id: int
    status: ResourceLibraryListingStatus
    current_version_id: Optional[int] = None
    install_count: int
    is_installed: bool = False
    current_version: Optional[ResourceLibraryVersionResponse] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ResourceLibraryInstallResponse(BaseModel):
    id: int
    listing_id: int
    version_id: int
    user_id: int
    resource_type: ResourceLibraryResourceType
    installed_kind_id: Optional[int] = None
    installed_reference: Dict[str, Any]
    install_status: ResourceLibraryInstallStatus
    error_message: Optional[str] = None
    requires_configuration: bool = False
    installed_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ResourceLibraryListResponse(BaseModel):
    total: int
    items: List[ResourceLibraryListingResponse]


class ResourceLibraryInstallListResponse(BaseModel):
    total: int
    items: List[ResourceLibraryInstallResponse]
```

- [ ] **Step 7: Add migration**

Create `backend/alembic/versions/20260527_e1f2a3b4c5d6_add_resource_library_tables.py`:

```python
"""add resource library tables

Revision ID: e1f2a3b4c5d6
Revises: 9d4be4601172
Create Date: 2026-05-27 16:00:00.000000+08:00
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision = "e1f2a3b4c5d6"
down_revision = "9d4be4601172"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "resource_library_listings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("resource_type", sa.String(length=20), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("display_name", sa.String(length=200), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("icon", sa.String(length=100), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("publisher_user_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("current_version_id", sa.Integer(), nullable=True),
        sa.Column("install_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "resource_type",
            "name",
            "publisher_user_id",
            name="uq_resource_library_listing_owner_name",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_resource_library_listings_discovery",
        "resource_library_listings",
        ["status", "resource_type", "updated_at"],
    )
    op.create_index(
        "ix_resource_library_listings_publisher_user_id",
        "resource_library_listings",
        ["publisher_user_id"],
    )

    op.create_table(
        "resource_library_versions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("listing_id", sa.Integer(), nullable=False),
        sa.Column("version", sa.String(length=50), nullable=False),
        sa.Column("manifest", sa.JSON(), nullable=False),
        sa.Column("source_kind_id", sa.Integer(), nullable=True),
        sa.Column("source_binary_id", sa.Integer(), nullable=True),
        sa.Column("is_current", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["listing_id"],
            ["resource_library_listings.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "listing_id",
            "version",
            name="uq_resource_library_version_listing_version",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_resource_library_versions_current",
        "resource_library_versions",
        ["listing_id", "is_current"],
    )

    op.create_table(
        "resource_library_installs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("listing_id", sa.Integer(), nullable=False),
        sa.Column("version_id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("resource_type", sa.String(length=20), nullable=False),
        sa.Column("installed_kind_id", sa.Integer(), nullable=True),
        sa.Column("installed_reference", sa.JSON(), nullable=False),
        sa.Column("install_status", sa.String(length=20), nullable=False),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("installed_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["listing_id"],
            ["resource_library_listings.id"],
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["version_id"],
            ["resource_library_versions.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "listing_id",
            "user_id",
            name="uq_resource_library_install_listing_user",
        ),
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
        mysql_engine="InnoDB",
    )
    op.create_index(
        "ix_resource_library_installs_user_type_status",
        "resource_library_installs",
        ["user_id", "resource_type", "install_status"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_resource_library_installs_user_type_status",
        table_name="resource_library_installs",
    )
    op.drop_table("resource_library_installs")
    op.drop_index(
        "ix_resource_library_versions_current",
        table_name="resource_library_versions",
    )
    op.drop_table("resource_library_versions")
    op.drop_index(
        "ix_resource_library_listings_publisher_user_id",
        table_name="resource_library_listings",
    )
    op.drop_index(
        "ix_resource_library_listings_discovery",
        table_name="resource_library_listings",
    )
    op.drop_table("resource_library_listings")
```

- [ ] **Step 8: Run model and schema tests to verify they pass**

Run:

```bash
cd backend && uv run pytest tests/models/test_resource_library_models.py tests/schemas/test_resource_library_schema.py -v
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/app/models/resource_library.py backend/app/models/__init__.py backend/app/schemas/resource_library.py backend/alembic/versions/20260527_e1f2a3b4c5d6_add_resource_library_tables.py backend/tests/models/test_resource_library_models.py backend/tests/schemas/test_resource_library_schema.py
git commit -m "feat(resource-library): add core data model"
```

---

### Task 2: Listing Service and Discovery API

**Files:**
- Create: `backend/app/services/resource_library/__init__.py`
- Create: `backend/app/services/resource_library/service.py`
- Create: `backend/app/api/endpoints/adapter/resource_library.py`
- Modify: `backend/app/api/api.py`
- Test: `backend/tests/services/resource_library/test_resource_library_service.py`
- Test: `backend/tests/api/endpoints/test_resource_library.py`

- [ ] **Step 1: Write failing service tests**

Create `backend/tests/services/resource_library/test_resource_library_service.py`:

```python
from app.schemas.resource_library import ResourceLibraryListingCreate
from app.services.resource_library.service import resource_library_service


def test_create_listing_creates_current_version(test_db, test_user):
    created = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=123,
            name="research-agent",
            display_name="Research Agent",
            description="Collects sources",
            tags=["research"],
            version="1.0.0",
            manifest_options={"manifest": {"team": {"name": "research-agent"}}},
        ),
    )

    assert created.name == "research-agent"
    assert created.current_version_id is not None


def test_list_published_filters_by_type_and_keyword(test_db, test_user):
    resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="skill",
            source_id=1,
            name="doc-summary",
            display_name="Doc Summary",
            description="Summarizes documents",
            tags=["docs"],
            version="1.0.0",
            manifest_options={"manifest": {"skill": {"name": "doc-summary"}}},
        ),
    )

    items, total = resource_library_service.list_listings(
        db=test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword="summary",
        skip=0,
        limit=20,
    )

    assert total == 1
    assert items[0].name == "doc-summary"
```

- [ ] **Step 2: Write failing API tests**

Create `backend/tests/api/endpoints/test_resource_library.py`:

```python
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_create_and_list_resource_library_listing(test_client, test_token):
    create_response = test_client.post(
        "/api/resource-library/listings",
        headers=auth_headers(test_token),
        json={
            "resource_type": "skill",
            "source_id": 1,
            "name": "doc-summary",
            "display_name": "Doc Summary",
            "description": "Summarizes documents",
            "tags": ["docs"],
            "version": "1.0.0",
            "manifest_options": {
                "manifest": {"skill": {"name": "doc-summary"}},
            },
        },
    )

    assert create_response.status_code == 201
    listing_id = create_response.json()["id"]

    list_response = test_client.get(
        "/api/resource-library/listings?resource_type=skill&keyword=summary",
        headers=auth_headers(test_token),
    )

    assert list_response.status_code == 200
    body = list_response.json()
    assert body["total"] == 1
    assert body["items"][0]["id"] == listing_id
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_resource_library_service.py tests/api/endpoints/test_resource_library.py -v
```

Expected: FAIL with missing `app.services.resource_library.service` and 404 for `/api/resource-library/listings`.

- [ ] **Step 4: Implement service**

Create `backend/app/services/resource_library/__init__.py`:

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.resource_library.service import (
    ResourceLibraryService,
    resource_library_service,
)

__all__ = ["ResourceLibraryService", "resource_library_service"]
```

Create `backend/app/services/resource_library/service.py`:

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.resource_library import (
    INSTALL_STATUS_INSTALLED,
    RESOURCE_LIBRARY_STATUS_ARCHIVED,
    RESOURCE_LIBRARY_STATUS_PUBLISHED,
    ResourceLibraryInstall,
    ResourceLibraryListing,
    ResourceLibraryVersion,
)
from app.schemas.resource_library import (
    ResourceLibraryInstallCreate,
    ResourceLibraryListingCreate,
    ResourceLibraryVersionCreate,
)


class ResourceLibraryService:
    """Application service for resource library listings, versions, and installs."""

    def create_listing(
        self,
        db: Session,
        *,
        user_id: int,
        payload: ResourceLibraryListingCreate,
    ) -> ResourceLibraryListing:
        manifest = payload.manifest_options.get("manifest") or {
            "resource_type": payload.resource_type,
            "source_id": payload.source_id,
        }
        listing = ResourceLibraryListing(
            resource_type=payload.resource_type,
            name=payload.name,
            display_name=payload.display_name,
            description=payload.description,
            icon=payload.icon,
            tags=payload.tags,
            publisher_user_id=user_id,
            status=RESOURCE_LIBRARY_STATUS_PUBLISHED,
        )
        db.add(listing)
        db.flush()

        version = ResourceLibraryVersion(
            listing_id=listing.id,
            version=payload.version,
            manifest=manifest,
            source_kind_id=payload.source_id,
            is_current=True,
        )
        db.add(version)
        db.flush()

        listing.current_version_id = version.id
        db.commit()
        db.refresh(listing)
        return listing

    def list_listings(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: Optional[str] = None,
        keyword: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list[ResourceLibraryListing], int]:
        query = db.query(ResourceLibraryListing).filter(
            ResourceLibraryListing.status == RESOURCE_LIBRARY_STATUS_PUBLISHED
        )
        if resource_type:
            query = query.filter(ResourceLibraryListing.resource_type == resource_type)
        if keyword:
            pattern = f"%{keyword}%"
            query = query.filter(
                or_(
                    ResourceLibraryListing.name.ilike(pattern),
                    ResourceLibraryListing.display_name.ilike(pattern),
                    ResourceLibraryListing.description.ilike(pattern),
                )
            )
        total = query.count()
        items = (
            query.order_by(ResourceLibraryListing.updated_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return items, total

    def get_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        include_archived_for_owner: bool = False,
    ) -> ResourceLibraryListing:
        query = db.query(ResourceLibraryListing).filter(ResourceLibraryListing.id == listing_id)
        listing = query.first()
        if not listing:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found")
        if listing.status == RESOURCE_LIBRARY_STATUS_ARCHIVED:
            can_view = include_archived_for_owner and listing.publisher_user_id == user_id
            if not can_view:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resource not found")
        return listing

    def archive_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        is_admin: bool = False,
    ) -> ResourceLibraryListing:
        listing = self.get_listing(
            db,
            listing_id=listing_id,
            user_id=user_id,
            include_archived_for_owner=True,
        )
        if listing.publisher_user_id != user_id and not is_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
        listing.status = RESOURCE_LIBRARY_STATUS_ARCHIVED
        db.commit()
        db.refresh(listing)
        return listing


resource_library_service = ResourceLibraryService()
```

- [ ] **Step 5: Implement API routes**

Create `backend/app/api/endpoints/adapter/resource_library.py`:

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.resource_library import (
    ResourceLibraryListResponse,
    ResourceLibraryListingCreate,
    ResourceLibraryListingResponse,
)
from app.services.resource_library import resource_library_service

router = APIRouter()


def _to_listing_response(
    listing,
    *,
    is_installed: bool = False,
) -> ResourceLibraryListingResponse:
    return ResourceLibraryListingResponse.model_validate(
        {
            **listing.__dict__,
            "is_installed": is_installed,
            "current_version": None,
        }
    )


@router.get("/listings", response_model=ResourceLibraryListResponse)
def list_resource_library_listings(
    resource_type: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    skip = (page - 1) * limit
    items, total = resource_library_service.list_listings(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        keyword=keyword,
        skip=skip,
        limit=limit,
    )
    return ResourceLibraryListResponse(
        total=total,
        items=[_to_listing_response(item) for item in items],
    )


@router.post(
    "/listings",
    response_model=ResourceLibraryListingResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_resource_library_listing(
    payload: ResourceLibraryListingCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    listing = resource_library_service.create_listing(
        db,
        user_id=current_user.id,
        payload=payload,
    )
    return _to_listing_response(listing)


@router.get("/listings/{listing_id}", response_model=ResourceLibraryListingResponse)
def get_resource_library_listing(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    listing = resource_library_service.get_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
    )
    return _to_listing_response(listing)
```

Modify `backend/app/api/api.py`:

```python
from app.api.endpoints.adapter import (
    resource_library,
)

api_router.include_router(
    resource_library.router,
    prefix="/resource-library",
    tags=["resource-library"],
)
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_resource_library_service.py tests/api/endpoints/test_resource_library.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/app/services/resource_library backend/app/api/endpoints/adapter/resource_library.py backend/app/api/api.py backend/tests/services/resource_library/test_resource_library_service.py backend/tests/api/endpoints/test_resource_library.py
git commit -m "feat(resource-library): add listing discovery api"
```

---

### Task 3: Manifest Builders for Publishing Existing Resources

**Files:**
- Create: `backend/app/services/resource_library/manifest_builders.py`
- Modify: `backend/app/services/resource_library/service.py`
- Test: `backend/tests/services/resource_library/test_manifest_builders.py`

- [ ] **Step 1: Write failing manifest builder tests**

Create `backend/tests/services/resource_library/test_manifest_builders.py`:

```python
from app.models.kind import Kind
from app.services.resource_library.manifest_builders import ResourceManifestBuilder


def test_build_agent_manifest_from_team_kind(test_db, test_user):
    team = Kind(
        user_id=test_user.id,
        kind="Team",
        name="research-agent",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "research-agent", "displayName": "Research Agent"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)

    manifest = ResourceManifestBuilder().build(
        db=test_db,
        user_id=test_user.id,
        resource_type="agent",
        source_id=team.id,
        options={},
    )

    assert manifest["resource_type"] == "agent"
    assert manifest["team"]["metadata"]["name"] == "research-agent"


def test_build_mcp_manifest_drops_secret_values(test_db, test_user):
    manifest = ResourceManifestBuilder().build(
        db=test_db,
        user_id=test_user.id,
        resource_type="mcp",
        source_id=1,
        options={
            "server_name": "docs",
            "server_config": {
                "type": "streamable-http",
                "url": "https://example.com/mcp",
                "headers": {"Authorization": "Bearer secret"},
            },
        },
    )

    assert manifest["resource_type"] == "mcp"
    assert manifest["server_config_template"]["url"] == ""
    assert "headers" not in manifest["server_config_template"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_manifest_builders.py -v
```

Expected: FAIL with missing `ResourceManifestBuilder`.

- [ ] **Step 3: Implement manifest builder**

Create `backend/app/services/resource_library/manifest_builders.py`:

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary


class ResourceManifestBuilder:
    """Build install manifests from source resources."""

    def build(
        self,
        db: Session,
        *,
        user_id: int,
        resource_type: str,
        source_id: int,
        options: dict[str, Any],
    ) -> dict[str, Any]:
        if resource_type == "agent":
            return self._build_agent_manifest(db, user_id=user_id, source_id=source_id)
        if resource_type == "skill":
            return self._build_skill_manifest(db, user_id=user_id, source_id=source_id)
        if resource_type == "mcp":
            return self._build_mcp_manifest(source_id=source_id, options=options)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported resource type")

    def _build_agent_manifest(
        self,
        db: Session,
        *,
        user_id: int,
        source_id: int,
    ) -> dict[str, Any]:
        team = (
            db.query(Kind)
            .filter(
                Kind.id == source_id,
                Kind.kind == "Team",
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not team:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
        return {
            "resource_type": "agent",
            "team": team.json,
            "source": {
                "kind_id": team.id,
                "namespace": team.namespace,
                "name": team.name,
            },
        }

    def _build_skill_manifest(
        self,
        db: Session,
        *,
        user_id: int,
        source_id: int,
    ) -> dict[str, Any]:
        skill = (
            db.query(Kind)
            .filter(
                Kind.id == source_id,
                Kind.kind == "Skill",
                Kind.user_id == user_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not skill:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Skill not found")
        binary = db.query(SkillBinary).filter(SkillBinary.kind_id == skill.id).first()
        return {
            "resource_type": "skill",
            "skill": skill.json,
            "source": {
                "kind_id": skill.id,
                "binary_id": binary.id if binary else None,
                "namespace": skill.namespace,
                "name": skill.name,
            },
        }

    def _build_mcp_manifest(
        self,
        *,
        source_id: int,
        options: dict[str, Any],
    ) -> dict[str, Any]:
        server_name = options.get("server_name") or f"mcp-{source_id}"
        server_config = dict(options.get("server_config") or {})
        safe_template = {
            "type": server_config.get("type", "streamable-http"),
            "url": "",
        }
        if server_config.get("command"):
            safe_template["command"] = server_config["command"]
            safe_template["args"] = server_config.get("args", [])
        return {
            "resource_type": "mcp",
            "server_name": server_name,
            "server_config_template": safe_template,
            "required_fields": ["url"],
        }
```

- [ ] **Step 4: Wire service to builder**

Modify `backend/app/services/resource_library/service.py`:

```python
from app.services.resource_library.manifest_builders import ResourceManifestBuilder


class ResourceLibraryService:
    def __init__(self, manifest_builder: ResourceManifestBuilder | None = None):
        self.manifest_builder = manifest_builder or ResourceManifestBuilder()

    def create_listing(...):
        manifest = self.manifest_builder.build(
            db,
            user_id=user_id,
            resource_type=payload.resource_type,
            source_id=payload.source_id,
            options=payload.manifest_options,
        )
```

Keep the `manifest_options["manifest"]` test escape hatch only for tests:

```python
manifest = payload.manifest_options.get("manifest") or self.manifest_builder.build(...)
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_manifest_builders.py tests/services/resource_library/test_resource_library_service.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/resource_library/manifest_builders.py backend/app/services/resource_library/service.py backend/tests/services/resource_library/test_manifest_builders.py
git commit -m "feat(resource-library): build publish manifests"
```

---

### Task 4: Skill and MCP Installers

**Files:**
- Create: `backend/app/services/resource_library/installers.py`
- Modify: `backend/app/services/resource_library/service.py`
- Test: `backend/tests/services/resource_library/test_resource_installers.py`

- [ ] **Step 1: Write failing installer tests**

Create `backend/tests/services/resource_library/test_resource_installers.py`:

```python
import hashlib

from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryListing, ResourceLibraryVersion
from app.models.skill_binary import SkillBinary
from app.services.resource_library.installers import (
    McpResourceInstaller,
    SkillResourceInstaller,
)


def test_skill_installer_copies_kind_and_binary(test_db, test_user):
    source_skill = Kind(
        user_id=test_user.id,
        kind="Skill",
        name="doc-summary",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": "doc-summary"},
            "spec": {"description": "Summarize docs"},
        },
        is_active=True,
    )
    test_db.add(source_skill)
    test_db.commit()
    test_db.refresh(source_skill)
    test_db.add(
        SkillBinary(
            kind_id=source_skill.id,
            binary_data=b"zip-content",
            file_size=len(b"zip-content"),
            file_hash=hashlib.sha256(b"zip-content").hexdigest(),
        )
    )
    listing = ResourceLibraryListing(
        resource_type="skill",
        name="doc-summary",
        publisher_user_id=test_user.id,
        status="published",
        tags=[],
    )
    test_db.add(listing)
    test_db.commit()
    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest={
            "resource_type": "skill",
            "skill": source_skill.json,
            "source": {"kind_id": source_skill.id, "binary_id": 1},
        },
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()

    result = SkillResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={},
    )

    assert result.installed_kind_id is not None
    copied = test_db.query(Kind).filter(Kind.id == result.installed_kind_id).one()
    assert copied.kind == "Skill"


def test_mcp_installer_writes_user_config(test_db, test_user):
    listing = ResourceLibraryListing(
        resource_type="mcp",
        name="docs-mcp",
        publisher_user_id=test_user.id,
        status="published",
        tags=[],
    )
    test_db.add(listing)
    test_db.commit()
    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest={
            "resource_type": "mcp",
            "server_name": "docs",
            "server_config_template": {"type": "streamable-http", "url": ""},
            "required_fields": ["url"],
        },
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()

    result = McpResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={"url": "https://example.com/mcp"},
    )

    test_db.refresh(test_user)
    assert result.requires_configuration is False
    assert result.installed_reference["service_id"] == "docs-mcp"
    assert '"docs-mcp"' in test_user.preferences
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_resource_installers.py -v
```

Expected: FAIL with missing `app.services.resource_library.installers`.

- [ ] **Step 3: Implement Skill and MCP installers**

Create `backend/app/services/resource_library/installers.py`:

```python
# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import copy
import json
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryListing, ResourceLibraryVersion
from app.models.skill_binary import SkillBinary
from app.models.user import User
from app.services.user_mcp_service import UserMCPService


@dataclass
class ResourceInstallResult:
    installed_kind_id: int | None
    installed_reference: dict[str, Any]
    requires_configuration: bool = False


class SkillResourceInstaller:
    """Install Skill resources into the current user's namespace."""

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        target_namespace: str,
        options: dict[str, Any],
    ) -> ResourceInstallResult:
        manifest = version.manifest
        source = manifest.get("source") or {}
        source_kind_id = source.get("kind_id")
        source_skill = db.query(Kind).filter(Kind.id == source_kind_id, Kind.kind == "Skill").first()
        if not source_skill:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source Skill not found")

        target_name = self._available_name(
            db,
            user_id=user_id,
            namespace=target_namespace,
            base_name=source_skill.name,
        )
        skill_json = copy.deepcopy(source_skill.json)
        skill_json.setdefault("metadata", {})["name"] = target_name
        new_skill = Kind(
            user_id=user_id,
            kind="Skill",
            name=target_name,
            namespace=target_namespace,
            json=skill_json,
            is_active=True,
        )
        db.add(new_skill)
        db.flush()

        source_binary = db.query(SkillBinary).filter(SkillBinary.kind_id == source_skill.id).first()
        if source_binary:
            db.add(
                SkillBinary(
                    kind_id=new_skill.id,
                    binary_data=source_binary.binary_data,
                    file_size=source_binary.file_size,
                    file_hash=source_binary.file_hash,
                )
            )
        db.flush()
        return ResourceInstallResult(
            installed_kind_id=new_skill.id,
            installed_reference={
                "skill_id": new_skill.id,
                "namespace": target_namespace,
                "name": target_name,
            },
        )

    def _available_name(
        self,
        db: Session,
        *,
        user_id: int,
        namespace: str,
        base_name: str,
    ) -> str:
        candidate = base_name
        suffix = 1
        while (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Skill",
                Kind.namespace == namespace,
                Kind.name == candidate,
                Kind.is_active == True,
            )
            .first()
        ):
            suffix += 1
            candidate = f"{base_name}-{suffix}"
        return candidate


class McpResourceInstaller:
    """Install MCP templates into user MCP preferences."""

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        target_namespace: str,
        options: dict[str, Any],
    ) -> ResourceInstallResult:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

        manifest = version.manifest
        service_id = listing.name
        provider_id = "resource-library"
        url = (options.get("url") or "").strip()
        requires_configuration = not bool(url)

        prefs = UserMCPService.load_preferences(user.preferences)
        mcps = dict(prefs.get("mcps") or {})
        provider = dict(mcps.get(provider_id) or {})
        services = dict(provider.get("services") or {})
        service = {
            "enabled": bool(url),
            "source": "resource-library",
            "listing_id": listing.id,
            "version_id": version.id,
            "server_name": manifest.get("server_name", service_id),
        }
        if url:
            service["credentials"] = {"url": url}
        services[service_id] = service
        provider["services"] = services
        mcps[provider_id] = provider
        prefs["mcps"] = mcps
        user.preferences = json.dumps(prefs)
        db.add(user)
        db.flush()

        return ResourceInstallResult(
            installed_kind_id=None,
            installed_reference={
                "provider_id": provider_id,
                "service_id": service_id,
            },
            requires_configuration=requires_configuration,
        )
```

- [ ] **Step 4: Run installer tests**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_resource_installers.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/resource_library/installers.py backend/tests/services/resource_library/test_resource_installers.py
git commit -m "feat(resource-library): add skill and mcp installers"
```

---

### Task 5: Agent Installer and Install API

**Files:**
- Modify: `backend/app/services/resource_library/installers.py`
- Modify: `backend/app/services/resource_library/service.py`
- Modify: `backend/app/api/endpoints/adapter/resource_library.py`
- Test: `backend/tests/services/resource_library/test_agent_installer.py`
- Test: `backend/tests/api/endpoints/test_resource_library_install.py`

- [ ] **Step 1: Write failing Agent installer test**

Create `backend/tests/services/resource_library/test_agent_installer.py`:

```python
from app.models.kind import Kind
from app.models.resource_library import ResourceLibraryListing, ResourceLibraryVersion
from app.services.resource_library.installers import AgentResourceInstaller


def test_agent_installer_copies_team(test_db, test_user):
    source_team = Kind(
        user_id=test_user.id,
        kind="Team",
        name="research-agent",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "research-agent", "displayName": "Research Agent"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(source_team)
    test_db.commit()
    test_db.refresh(source_team)

    listing = ResourceLibraryListing(
        resource_type="agent",
        name="research-agent",
        publisher_user_id=test_user.id,
        status="published",
        tags=[],
    )
    test_db.add(listing)
    test_db.commit()
    version = ResourceLibraryVersion(
        listing_id=listing.id,
        version="1.0.0",
        manifest={
            "resource_type": "agent",
            "team": source_team.json,
            "source": {"kind_id": source_team.id},
        },
        is_current=True,
    )
    test_db.add(version)
    test_db.commit()

    result = AgentResourceInstaller().install(
        db=test_db,
        user_id=test_user.id,
        listing=listing,
        version=version,
        target_namespace="default",
        options={},
    )

    copied_team = test_db.query(Kind).filter(Kind.id == result.installed_kind_id).one()
    assert copied_team.kind == "Team"
    assert copied_team.name != source_team.name
    assert copied_team.json["metadata"]["name"] == copied_team.name
```

- [ ] **Step 2: Write failing install API test**

Create `backend/tests/api/endpoints/test_resource_library_install.py`:

```python
from app.models.kind import Kind
from app.services.resource_library.service import resource_library_service
from app.schemas.resource_library import ResourceLibraryListingCreate


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_install_listing_creates_install_record(test_client, test_db, test_user, test_token):
    team = Kind(
        user_id=test_user.id,
        kind="Team",
        name="research-agent",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "research-agent"},
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    listing = resource_library_service.create_listing(
        db=test_db,
        user_id=test_user.id,
        payload=ResourceLibraryListingCreate(
            resource_type="agent",
            source_id=team.id,
            name="research-agent",
            display_name="Research Agent",
            description="Collects sources",
            tags=[],
            version="1.0.0",
        ),
    )

    response = test_client.post(
        f"/api/resource-library/listings/{listing.id}/install",
        headers=auth_headers(test_token),
        json={"target_namespace": "default"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["install_status"] == "installed"
    assert body["installed_reference"]["team_id"] > 0
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_agent_installer.py tests/api/endpoints/test_resource_library_install.py -v
```

Expected: FAIL with missing `AgentResourceInstaller` and missing install route.

- [ ] **Step 4: Implement Agent installer**

Append to `backend/app/services/resource_library/installers.py`:

```python
class AgentResourceInstaller:
    """Install Agent resources by copying Team CRD snapshots."""

    def install(
        self,
        db: Session,
        *,
        user_id: int,
        listing: ResourceLibraryListing,
        version: ResourceLibraryVersion,
        target_namespace: str,
        options: dict[str, Any],
    ) -> ResourceInstallResult:
        manifest = version.manifest
        source_team_json = copy.deepcopy(manifest.get("team") or {})
        if not source_team_json:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Agent manifest missing team")

        base_name = source_team_json.get("metadata", {}).get("name") or listing.name
        target_name = self._available_name(
            db,
            user_id=user_id,
            namespace=target_namespace,
            base_name=base_name,
        )
        source_team_json.setdefault("metadata", {})["name"] = target_name
        source_team_json["metadata"]["namespace"] = target_namespace

        new_team = Kind(
            user_id=user_id,
            kind="Team",
            name=target_name,
            namespace=target_namespace,
            json=source_team_json,
            is_active=True,
        )
        db.add(new_team)
        db.flush()
        return ResourceInstallResult(
            installed_kind_id=new_team.id,
            installed_reference={
                "team_id": new_team.id,
                "namespace": target_namespace,
                "name": target_name,
            },
        )

    def _available_name(
        self,
        db: Session,
        *,
        user_id: int,
        namespace: str,
        base_name: str,
    ) -> str:
        candidate = base_name
        suffix = 1
        while (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Team",
                Kind.namespace == namespace,
                Kind.name == candidate,
                Kind.is_active == True,
            )
            .first()
        ):
            suffix += 1
            candidate = f"{base_name}-{suffix}"
        return candidate
```

- [ ] **Step 5: Wire install orchestration**

Modify `backend/app/services/resource_library/service.py`:

```python
from app.models.resource_library import ResourceLibraryInstall
from app.services.resource_library.installers import (
    AgentResourceInstaller,
    McpResourceInstaller,
    SkillResourceInstaller,
)


class ResourceLibraryService:
    def __init__(self, manifest_builder=None):
        self.manifest_builder = manifest_builder or ResourceManifestBuilder()
        self.installers = {
            "agent": AgentResourceInstaller(),
            "skill": SkillResourceInstaller(),
            "mcp": McpResourceInstaller(),
        }

    def install_listing(
        self,
        db: Session,
        *,
        listing_id: int,
        user_id: int,
        payload: ResourceLibraryInstallCreate,
    ) -> ResourceLibraryInstall:
        listing = self.get_listing(db, listing_id=listing_id, user_id=user_id)
        version = self._resolve_install_version(db, listing, payload.version_id)
        installer = self.installers[listing.resource_type]
        try:
            install_result = installer.install(
                db,
                user_id=user_id,
                listing=listing,
                version=version,
                target_namespace=payload.target_namespace or "default",
                options=payload.install_options,
            )
            install = ResourceLibraryInstall(
                listing_id=listing.id,
                version_id=version.id,
                user_id=user_id,
                resource_type=listing.resource_type,
                installed_kind_id=install_result.installed_kind_id,
                installed_reference=install_result.installed_reference,
                install_status="installed",
            )
            listing.install_count = listing.install_count + 1
            db.add(install)
            db.commit()
            db.refresh(install)
            install.requires_configuration = install_result.requires_configuration
            return install
        except Exception as exc:
            install = ResourceLibraryInstall(
                listing_id=listing.id,
                version_id=version.id,
                user_id=user_id,
                resource_type=listing.resource_type,
                installed_reference={},
                install_status="failed",
                error_message=str(exc),
            )
            db.add(install)
            db.commit()
            db.refresh(install)
            raise

    def _resolve_install_version(
        self,
        db: Session,
        listing: ResourceLibraryListing,
        version_id: int | None,
    ) -> ResourceLibraryVersion:
        query = db.query(ResourceLibraryVersion).filter(ResourceLibraryVersion.listing_id == listing.id)
        version = query.filter(ResourceLibraryVersion.id == version_id).first() if version_id else query.filter(ResourceLibraryVersion.is_current == True).first()
        if not version:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resource version not found")
        return version
```

- [ ] **Step 6: Add install API route**

Modify `backend/app/api/endpoints/adapter/resource_library.py`:

```python
from app.schemas.resource_library import (
    ResourceLibraryInstallCreate,
    ResourceLibraryInstallResponse,
)


@router.post(
    "/listings/{listing_id}/install",
    response_model=ResourceLibraryInstallResponse,
    status_code=status.HTTP_201_CREATED,
)
def install_resource_library_listing(
    listing_id: int,
    payload: ResourceLibraryInstallCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    install = resource_library_service.install_listing(
        db,
        listing_id=listing_id,
        user_id=current_user.id,
        payload=payload,
    )
    return ResourceLibraryInstallResponse.model_validate(install)
```

- [ ] **Step 7: Run tests**

Run:

```bash
cd backend && uv run pytest tests/services/resource_library/test_agent_installer.py tests/services/resource_library/test_resource_installers.py tests/api/endpoints/test_resource_library_install.py -v
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/app/services/resource_library/installers.py backend/app/services/resource_library/service.py backend/app/api/endpoints/adapter/resource_library.py backend/tests/services/resource_library/test_agent_installer.py backend/tests/api/endpoints/test_resource_library_install.py
git commit -m "feat(resource-library): install resources"
```

---

### Task 6: Frontend API Client, Types, and i18n

**Files:**
- Create: `frontend/src/apis/resourceLibrary.ts`
- Create: `frontend/src/features/resource-library/types.ts`
- Create: `frontend/src/i18n/locales/zh-CN/resource-library.json`
- Create: `frontend/src/i18n/locales/en/resource-library.json`
- Modify: `frontend/src/i18n/setup.ts`
- Test: `frontend/src/__tests__/apis/resourceLibrary.test.ts`
- Test: `frontend/src/__tests__/i18n/resource-library-namespace.test.ts`

- [ ] **Step 1: Write failing API client test**

Create `frontend/src/__tests__/apis/resourceLibrary.test.ts`:

```typescript
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { apiClient } from '@/apis/client'

jest.mock('@/apis/client', () => ({
  apiClient: {
    get: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}))

describe('resourceLibraryApi', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('lists resources with type and keyword filters', async () => {
    ;(apiClient.get as jest.Mock).mockResolvedValue({ total: 0, items: [] })

    await resourceLibraryApi.listListings({
      resourceType: 'skill',
      keyword: 'summary',
      page: 2,
      limit: 10,
    })

    expect(apiClient.get).toHaveBeenCalledWith(
      '/resource-library/listings?resource_type=skill&keyword=summary&page=2&limit=10'
    )
  })

  it('installs a listing into default namespace', async () => {
    ;(apiClient.post as jest.Mock).mockResolvedValue({ id: 1 })

    await resourceLibraryApi.installListing(7, {
      targetNamespace: 'default',
      installOptions: {},
    })

    expect(apiClient.post).toHaveBeenCalledWith('/resource-library/listings/7/install', {
      target_namespace: 'default',
      install_options: {},
    })
  })
})
```

- [ ] **Step 2: Write failing i18n namespace test**

Create `frontend/src/__tests__/i18n/resource-library-namespace.test.ts`:

```typescript
import zh from '@/i18n/locales/zh-CN/resource-library.json'
import en from '@/i18n/locales/en/resource-library.json'

describe('resource-library translations', () => {
  it('defines required navigation labels', () => {
    expect(zh.title).toBe('资源库')
    expect(zh.tabs.discover).toBe('发现')
    expect(zh.tabs.mine).toBe('我的')
    expect(en.title).toBe('Resource Library')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/apis/resourceLibrary.test.ts src/__tests__/i18n/resource-library-namespace.test.ts
```

Expected: FAIL with missing API client and translation files.

- [ ] **Step 4: Implement API client**

Create `frontend/src/features/resource-library/types.ts`:

```typescript
export type ResourceLibraryResourceType = 'agent' | 'skill' | 'mcp'
export type ResourceLibraryTypeFilter = 'all' | ResourceLibraryResourceType

export interface ResourceLibraryListing {
  id: number
  resource_type: ResourceLibraryResourceType
  name: string
  display_name?: string | null
  description?: string | null
  icon?: string | null
  tags: string[]
  publisher_user_id: number
  status: 'published' | 'archived'
  current_version_id?: number | null
  install_count: number
  is_installed: boolean
  created_at: string
  updated_at: string
}

export interface ResourceLibraryListResponse {
  total: number
  items: ResourceLibraryListing[]
}

export interface ResourceLibraryInstall {
  id: number
  listing_id: number
  version_id: number
  user_id: number
  resource_type: ResourceLibraryResourceType
  installed_kind_id?: number | null
  installed_reference: Record<string, unknown>
  install_status: 'installed' | 'removed' | 'failed'
  error_message?: string | null
  requires_configuration: boolean
  installed_at: string
  updated_at: string
}
```

Create `frontend/src/apis/resourceLibrary.ts`:

```typescript
import { apiClient } from './client'
import type {
  ResourceLibraryInstall,
  ResourceLibraryListResponse,
  ResourceLibraryResourceType,
} from '@/features/resource-library/types'

export interface ListResourceLibraryParams {
  resourceType?: ResourceLibraryResourceType
  keyword?: string
  page?: number
  limit?: number
}

export interface InstallResourceLibraryRequest {
  versionId?: number
  targetNamespace?: string
  installOptions?: Record<string, unknown>
}

function buildQuery(params: ListResourceLibraryParams): string {
  const query = new URLSearchParams()
  if (params.resourceType) query.set('resource_type', params.resourceType)
  if (params.keyword) query.set('keyword', params.keyword)
  if (params.page) query.set('page', String(params.page))
  if (params.limit) query.set('limit', String(params.limit))
  const value = query.toString()
  return value ? `?${value}` : ''
}

export const resourceLibraryApi = {
  listListings(params: ListResourceLibraryParams = {}): Promise<ResourceLibraryListResponse> {
    return apiClient.get(`/resource-library/listings${buildQuery(params)}`)
  },

  installListing(
    listingId: number,
    request: InstallResourceLibraryRequest
  ): Promise<ResourceLibraryInstall> {
    return apiClient.post(`/resource-library/listings/${listingId}/install`, {
      version_id: request.versionId,
      target_namespace: request.targetNamespace || 'default',
      install_options: request.installOptions || {},
    })
  },
}
```

- [ ] **Step 5: Add translations and namespace registration**

Create `frontend/src/i18n/locales/zh-CN/resource-library.json`:

```json
{
  "title": "资源库",
  "tabs": {
    "discover": "发现",
    "mine": "我的",
    "installed": "已安装",
    "published": "我发布的"
  },
  "filters": {
    "all": "全部",
    "agent": "智能体",
    "skill": "Skill",
    "mcp": "MCP"
  },
  "actions": {
    "install": "安装",
    "installed": "已安装",
    "publish": "发布资源",
    "upgrade": "升级",
    "archive": "归档",
    "details": "详情"
  },
  "states": {
    "loading": "正在加载资源",
    "empty": "暂无资源",
    "requiresConfiguration": "需要配置"
  }
}
```

Create `frontend/src/i18n/locales/en/resource-library.json`:

```json
{
  "title": "Resource Library",
  "tabs": {
    "discover": "Discover",
    "mine": "Mine",
    "installed": "Installed",
    "published": "Published by me"
  },
  "filters": {
    "all": "All",
    "agent": "Agent",
    "skill": "Skill",
    "mcp": "MCP"
  },
  "actions": {
    "install": "Install",
    "installed": "Installed",
    "publish": "Publish resource",
    "upgrade": "Upgrade",
    "archive": "Archive",
    "details": "Details"
  },
  "states": {
    "loading": "Loading resources",
    "empty": "No resources",
    "requiresConfiguration": "Configuration required"
  }
}
```

Modify `frontend/src/i18n/setup.ts`:

```typescript
const namespaces = [
  'common',
  'resource-library',
  ...
]
```

Also add `'resource-library'` to the `ns` array in `initI18n()`.

- [ ] **Step 6: Run tests**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/apis/resourceLibrary.test.ts src/__tests__/i18n/resource-library-namespace.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/apis/resourceLibrary.ts frontend/src/features/resource-library/types.ts frontend/src/i18n/locales/zh-CN/resource-library.json frontend/src/i18n/locales/en/resource-library.json frontend/src/i18n/setup.ts frontend/src/__tests__/apis/resourceLibrary.test.ts frontend/src/__tests__/i18n/resource-library-namespace.test.ts
git commit -m "feat(frontend): add resource library api client"
```

---

### Task 7: Route, Sidebar Entry, and Page Skeleton

**Files:**
- Create: `frontend/src/app/(tasks)/resource-library/page.tsx`
- Create: `frontend/src/features/resource-library/ResourceLibraryPage.tsx`
- Create: `frontend/src/features/resource-library/components/ResourceLibraryTabs.tsx`
- Create: `frontend/src/features/resource-library/components/ResourceTypeFilter.tsx`
- Modify: `frontend/src/config/paths.ts`
- Modify: `frontend/src/features/tasks/components/sidebar/TaskSidebar.tsx`
- Test: `frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx`
- Test: `frontend/src/__tests__/features/tasks/components/sidebar/TaskSidebar.resource-library.test.tsx`

- [ ] **Step 1: Write failing page test**

Create `frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ResourceLibraryPage } from '@/features/resource-library/ResourceLibraryPage'

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        title: '资源库',
        'tabs.discover': '发现',
        'tabs.mine': '我的',
        'filters.all': '全部',
        'filters.agent': '智能体',
        'filters.skill': 'Skill',
        'filters.mcp': 'MCP',
      }
      return values[key] || key
    },
  }),
}))

describe('ResourceLibraryPage', () => {
  it('renders discover and mine tabs with resource filters', async () => {
    render(<ResourceLibraryPage />)

    expect(screen.getByRole('heading', { name: '资源库' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发现' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '我的' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '智能体' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skill' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MCP' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '我的' }))
    expect(screen.getByRole('button', { name: '我的' })).toHaveAttribute('aria-pressed', 'true')
  })
})
```

- [ ] **Step 2: Run page test to verify it fails**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx
```

Expected: FAIL with missing `ResourceLibraryPage`.

- [ ] **Step 3: Implement page skeleton components**

Create `frontend/src/features/resource-library/components/ResourceLibraryTabs.tsx`:

```tsx
'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export type ResourceLibraryTab = 'discover' | 'mine'

interface ResourceLibraryTabsProps {
  value: ResourceLibraryTab
  onChange: (value: ResourceLibraryTab) => void
}

export function ResourceLibraryTabs({ value, onChange }: ResourceLibraryTabsProps) {
  const { t } = useTranslation('resource-library')
  const tabs: ResourceLibraryTab[] = ['discover', 'mine']

  return (
    <div className="flex items-center gap-2">
      {tabs.map(tab => (
        <Button
          key={tab}
          type="button"
          variant={value === tab ? 'primary' : 'outline'}
          aria-pressed={value === tab}
          onClick={() => onChange(tab)}
          data-testid={`resource-library-${tab}-tab`}
        >
          {t(`tabs.${tab}`)}
        </Button>
      ))}
    </div>
  )
}
```

Create `frontend/src/features/resource-library/components/ResourceTypeFilter.tsx`:

```tsx
'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryTypeFilter } from '../types'

interface ResourceTypeFilterProps {
  value: ResourceLibraryTypeFilter
  onChange: (value: ResourceLibraryTypeFilter) => void
}

const filters: ResourceLibraryTypeFilter[] = ['all', 'agent', 'skill', 'mcp']

export function ResourceTypeFilter({ value, onChange }: ResourceTypeFilterProps) {
  const { t } = useTranslation('resource-library')

  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      {filters.map(filter => (
        <Button
          key={filter}
          type="button"
          variant={value === filter ? 'primary' : 'outline'}
          aria-pressed={value === filter}
          onClick={() => onChange(filter)}
          className="h-11 min-w-[44px]"
          data-testid={`resource-type-${filter}-filter`}
        >
          {t(`filters.${filter}`)}
        </Button>
      ))}
    </div>
  )
}
```

Create `frontend/src/features/resource-library/ResourceLibraryPage.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { ResourceLibraryTabs, type ResourceLibraryTab } from './components/ResourceLibraryTabs'
import { ResourceTypeFilter } from './components/ResourceTypeFilter'
import type { ResourceLibraryTypeFilter } from './types'

export function ResourceLibraryPage() {
  const { t } = useTranslation('resource-library')
  const [activeTab, setActiveTab] = useState<ResourceLibraryTab>('discover')
  const [resourceType, setResourceType] = useState<ResourceLibraryTypeFilter>('all')

  return (
    <div className="flex h-full flex-col bg-base text-text-primary">
      <div className="border-b border-border px-4 py-4 md:px-8">
        <div className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <ResourceLibraryTabs value={activeTab} onChange={setActiveTab} />
          <ResourceTypeFilter value={resourceType} onChange={setResourceType} />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 md:px-8">
        <div data-testid="resource-library-content">
          {activeTab === 'discover' ? 'discover' : 'mine'}:{resourceType}
        </div>
      </div>
    </div>
  )
}
```

Create `frontend/src/app/(tasks)/resource-library/page.tsx`:

```tsx
import { ResourceLibraryPage } from '@/features/resource-library/ResourceLibraryPage'

export default function Page() {
  return <ResourceLibraryPage />
}
```

- [ ] **Step 4: Add path and sidebar entry**

Modify `frontend/src/config/paths.ts`:

```typescript
resourceLibrary: {
  getHref: () => '/resource-library',
},
```

Modify `frontend/src/features/tasks/components/sidebar/TaskSidebar.tsx`:

```tsx
import { Library } from 'lucide-react'

pageType?: 'chat' | 'code' | 'flow' | 'knowledge' | 'devices' | 'inbox' | 'resource-library'

type ButtonPageType =
  | 'chat'
  | 'code'
  | 'flow'
  | 'knowledge'
  | 'devices'
  | 'inbox'
  | 'resource-library'

{
  label: t('resource-library:title'),
  icon: Library,
  path: paths.resourceLibrary.getHref(),
  isActive: pageType === 'resource-library',
  buttonPageType: 'resource-library',
}
```

Ensure the new button preserves existing `data-testid` values and does not remove any existing buttons.

- [ ] **Step 5: Run page tests**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add 'frontend/src/app/(tasks)/resource-library/page.tsx' frontend/src/features/resource-library/ResourceLibraryPage.tsx frontend/src/features/resource-library/components/ResourceLibraryTabs.tsx frontend/src/features/resource-library/components/ResourceTypeFilter.tsx frontend/src/config/paths.ts frontend/src/features/tasks/components/sidebar/TaskSidebar.tsx frontend/src/__tests__/features/resource-library/ResourceLibraryPage.test.tsx
git commit -m "feat(frontend): add resource library page shell"
```

---

### Task 8: Discovery List, Detail Drawer, and Install Action

**Files:**
- Create: `frontend/src/features/resource-library/components/ResourceListingCard.tsx`
- Create: `frontend/src/features/resource-library/components/ResourceDetailDrawer.tsx`
- Create: `frontend/src/features/resource-library/components/DiscoverResources.tsx`
- Modify: `frontend/src/features/resource-library/ResourceLibraryPage.tsx`
- Test: `frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx`

- [ ] **Step 1: Write failing discovery UI test**

Create `frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx`:

```typescript
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DiscoverResources } from '@/features/resource-library/components/DiscoverResources'
import { resourceLibraryApi } from '@/apis/resourceLibrary'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listListings: jest.fn(),
    installListing: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'actions.install': '安装',
        'actions.installed': '已安装',
        'actions.details': '详情',
        'states.loading': '正在加载资源',
        'states.empty': '暂无资源',
        'filters.agent': '智能体',
      }
      return values[key] || key
    },
  }),
}))

describe('DiscoverResources', () => {
  it('loads resources and installs a listing', async () => {
    ;(resourceLibraryApi.listListings as jest.Mock).mockResolvedValue({
      total: 1,
      items: [
        {
          id: 7,
          resource_type: 'agent',
          name: 'research-agent',
          display_name: 'Research Agent',
          description: 'Collects sources',
          icon: null,
          tags: ['research'],
          publisher_user_id: 1,
          status: 'published',
          current_version_id: 3,
          install_count: 2,
          is_installed: false,
          created_at: '2026-05-27T00:00:00',
          updated_at: '2026-05-27T00:00:00',
        },
      ],
    })
    ;(resourceLibraryApi.installListing as jest.Mock).mockResolvedValue({
      id: 10,
      install_status: 'installed',
    })

    render(<DiscoverResources resourceType="agent" />)

    expect(await screen.findByText('Research Agent')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '安装' }))

    await waitFor(() => {
      expect(resourceLibraryApi.installListing).toHaveBeenCalledWith(7, {
        targetNamespace: 'default',
        installOptions: {},
      })
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/DiscoverResources.test.tsx
```

Expected: FAIL with missing `DiscoverResources`.

- [ ] **Step 3: Implement listing card**

Create `frontend/src/features/resource-library/components/ResourceListingCard.tsx`:

```tsx
'use client'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import type { ResourceLibraryListing } from '../types'

interface ResourceListingCardProps {
  listing: ResourceLibraryListing
  installing: boolean
  onInstall: (listing: ResourceLibraryListing) => void
  onDetails: (listing: ResourceLibraryListing) => void
}

export function ResourceListingCard({
  listing,
  installing,
  onInstall,
  onDetails,
}: ResourceListingCardProps) {
  const { t } = useTranslation('resource-library')
  const title = listing.display_name || listing.name

  return (
    <Card className="p-4">
      <div className="flex min-h-[132px] flex-col justify-between gap-3">
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-base font-medium text-text-primary">{title}</h3>
            <Badge variant="secondary">{t(`filters.${listing.resource_type}`)}</Badge>
          </div>
          {listing.description && (
            <p className="line-clamp-2 text-sm text-text-muted">{listing.description}</p>
          )}
          <div className="flex flex-wrap gap-1">
            {listing.tags.map(tag => (
              <Badge key={tag} variant="outline">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 min-w-[44px]"
            onClick={() => onDetails(listing)}
            data-testid={`resource-${listing.id}-details-button`}
          >
            {t('actions.details')}
          </Button>
          <Button
            type="button"
            variant="primary"
            className="h-11 min-w-[44px]"
            disabled={listing.is_installed || installing}
            onClick={() => onInstall(listing)}
            data-testid={`resource-${listing.id}-install-button`}
          >
            {listing.is_installed ? t('actions.installed') : t('actions.install')}
          </Button>
        </div>
      </div>
    </Card>
  )
}
```

- [ ] **Step 4: Implement discovery component**

Create `frontend/src/features/resource-library/components/DiscoverResources.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import type {
  ResourceLibraryListing,
  ResourceLibraryResourceType,
  ResourceLibraryTypeFilter,
} from '../types'
import { ResourceListingCard } from './ResourceListingCard'

interface DiscoverResourcesProps {
  resourceType: ResourceLibraryTypeFilter
}

export function DiscoverResources({ resourceType }: DiscoverResourcesProps) {
  const { t } = useTranslation('resource-library')
  const { toast } = useToast()
  const [items, setItems] = useState<ResourceLibraryListing[]>([])
  const [loading, setLoading] = useState(true)
  const [installingId, setInstallingId] = useState<number | null>(null)

  const loadResources = useCallback(async () => {
    setLoading(true)
    try {
      const response = await resourceLibraryApi.listListings({
        resourceType:
          resourceType === 'all' ? undefined : (resourceType as ResourceLibraryResourceType),
        page: 1,
        limit: 50,
      })
      setItems(response.items)
    } finally {
      setLoading(false)
    }
  }, [resourceType])

  useEffect(() => {
    void loadResources()
  }, [loadResources])

  const handleInstall = async (listing: ResourceLibraryListing) => {
    setInstallingId(listing.id)
    try {
      await resourceLibraryApi.installListing(listing.id, {
        targetNamespace: 'default',
        installOptions: {},
      })
      setItems(current =>
        current.map(item => (item.id === listing.id ? { ...item, is_installed: true } : item))
      )
      toast({ title: t('actions.installed') })
    } finally {
      setInstallingId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('states.loading')}
      </div>
    )
  }

  if (items.length === 0) {
    return <div className="py-12 text-center text-sm text-text-muted">{t('states.empty')}</div>
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {items.map(item => (
        <ResourceListingCard
          key={item.id}
          listing={item}
          installing={installingId === item.id}
          onInstall={handleInstall}
          onDetails={() => {}}
        />
      ))}
    </div>
  )
}
```

Modify `ResourceLibraryPage` to render `<DiscoverResources resourceType={resourceType} />` when `activeTab === 'discover'`.

- [ ] **Step 5: Run discovery test**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/DiscoverResources.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/resource-library/components/ResourceListingCard.tsx frontend/src/features/resource-library/components/DiscoverResources.tsx frontend/src/features/resource-library/ResourceLibraryPage.tsx frontend/src/__tests__/features/resource-library/DiscoverResources.test.tsx
git commit -m "feat(frontend): show discover resources"
```

---

### Task 9: My Resources and Publish Dialog

**Files:**
- Modify: `frontend/src/apis/resourceLibrary.ts`
- Create: `frontend/src/features/resource-library/components/MyResources.tsx`
- Create: `frontend/src/features/resource-library/components/PublishResourceDialog.tsx`
- Modify: `frontend/src/features/resource-library/ResourceLibraryPage.tsx`
- Test: `frontend/src/__tests__/features/resource-library/MyResources.test.tsx`
- Test: `frontend/src/__tests__/features/resource-library/PublishResourceDialog.test.tsx`

- [ ] **Step 1: Write failing My resources test**

Create `frontend/src/__tests__/features/resource-library/MyResources.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react'
import { MyResources } from '@/features/resource-library/components/MyResources'
import { resourceLibraryApi } from '@/apis/resourceLibrary'

jest.mock('@/apis/resourceLibrary', () => ({
  resourceLibraryApi: {
    listMyInstalls: jest.fn(),
    listMyPublished: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'tabs.installed': '已安装',
        'tabs.published': '我发布的',
        'states.empty': '暂无资源',
      }
      return values[key] || key
    },
  }),
}))

describe('MyResources', () => {
  it('renders installed resources', async () => {
    ;(resourceLibraryApi.listMyInstalls as jest.Mock).mockResolvedValue({
      total: 1,
      items: [
        {
          id: 1,
          listing_id: 7,
          version_id: 3,
          user_id: 2,
          resource_type: 'skill',
          installed_kind_id: 8,
          installed_reference: { name: 'doc-summary' },
          install_status: 'installed',
          requires_configuration: false,
          installed_at: '2026-05-27T00:00:00',
          updated_at: '2026-05-27T00:00:00',
        },
      ],
    })
    ;(resourceLibraryApi.listMyPublished as jest.Mock).mockResolvedValue({ total: 0, items: [] })

    render(<MyResources resourceType="all" />)

    expect(await screen.findByText('doc-summary')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/MyResources.test.tsx
```

Expected: FAIL with missing `MyResources` and missing API methods.

- [ ] **Step 3: Extend API client**

Modify `frontend/src/apis/resourceLibrary.ts`:

```typescript
import type { ResourceLibraryInstall } from '@/features/resource-library/types'

export interface ResourceLibraryInstallListResponse {
  total: number
  items: ResourceLibraryInstall[]
}

export const resourceLibraryApi = {
  ...

  listMyInstalls(params: ListResourceLibraryParams = {}): Promise<ResourceLibraryInstallListResponse> {
    return apiClient.get(`/resource-library/users/me/installs${buildQuery(params)}`)
  },

  listMyPublished(params: ListResourceLibraryParams = {}): Promise<ResourceLibraryListResponse> {
    return apiClient.get(`/resource-library/users/me/published${buildQuery(params)}`)
  },

  createListing(request: {
    resource_type: ResourceLibraryResourceType
    source_id: number
    name: string
    display_name?: string
    description?: string
    tags: string[]
    version: string
    manifest_options?: Record<string, unknown>
  }): Promise<ResourceLibraryListing> {
    return apiClient.post('/resource-library/listings', request)
  },
}
```

- [ ] **Step 4: Implement MyResources**

Create `frontend/src/features/resource-library/components/MyResources.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { resourceLibraryApi } from '@/apis/resourceLibrary'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  ResourceLibraryInstall,
  ResourceLibraryResourceType,
  ResourceLibraryTypeFilter,
} from '../types'

interface MyResourcesProps {
  resourceType: ResourceLibraryTypeFilter
}

type MyMode = 'installed' | 'published'

export function MyResources({ resourceType }: MyResourcesProps) {
  const { t } = useTranslation('resource-library')
  const [mode, setMode] = useState<MyMode>('installed')
  const [installs, setInstalls] = useState<ResourceLibraryInstall[]>([])

  const loadResources = useCallback(async () => {
    const params = {
      resourceType:
        resourceType === 'all' ? undefined : (resourceType as ResourceLibraryResourceType),
      page: 1,
      limit: 50,
    }
    if (mode === 'installed') {
      const response = await resourceLibraryApi.listMyInstalls(params)
      setInstalls(response.items)
    } else {
      await resourceLibraryApi.listMyPublished(params)
      setInstalls([])
    }
  }, [mode, resourceType])

  useEffect(() => {
    void loadResources()
  }, [loadResources])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={mode === 'installed' ? 'primary' : 'outline'}
          aria-pressed={mode === 'installed'}
          onClick={() => setMode('installed')}
          data-testid="my-installed-tab"
        >
          {t('tabs.installed')}
        </Button>
        <Button
          type="button"
          variant={mode === 'published' ? 'primary' : 'outline'}
          aria-pressed={mode === 'published'}
          onClick={() => setMode('published')}
          data-testid="my-published-tab"
        >
          {t('tabs.published')}
        </Button>
      </div>

      {installs.length === 0 ? (
        <div className="py-12 text-center text-sm text-text-muted">{t('states.empty')}</div>
      ) : (
        <div className="space-y-3">
          {installs.map(install => (
            <Card key={install.id} className="p-4">
              <div className="text-sm font-medium">
                {String(install.installed_reference.name || install.installed_reference.service_id)}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
```

Modify `ResourceLibraryPage` to render `<MyResources resourceType={resourceType} />` for `mine`.

- [ ] **Step 5: Run MyResources test**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/features/resource-library/MyResources.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/apis/resourceLibrary.ts frontend/src/features/resource-library/components/MyResources.tsx frontend/src/features/resource-library/ResourceLibraryPage.tsx frontend/src/__tests__/features/resource-library/MyResources.test.tsx
git commit -m "feat(frontend): add my resource library view"
```

---

### Task 10: Final Integration and Verification

**Files:**
- Modify as needed only for failures found by verification.
- Test: existing and new backend/frontend tests.

- [ ] **Step 1: Run backend focused tests**

Run:

```bash
cd backend && uv run pytest tests/models/test_resource_library_models.py tests/schemas/test_resource_library_schema.py tests/services/resource_library tests/api/endpoints/test_resource_library.py tests/api/endpoints/test_resource_library_install.py -v
```

Expected: PASS.

- [ ] **Step 2: Run frontend focused tests**

Run:

```bash
cd frontend && npm test -- --runInBand src/__tests__/apis/resourceLibrary.test.ts src/__tests__/i18n/resource-library-namespace.test.ts src/__tests__/features/resource-library
```

Expected: PASS.

- [ ] **Step 3: Run frontend lint**

Run:

```bash
cd frontend && npm run lint
```

Expected: PASS with no ESLint errors.

- [ ] **Step 4: Run backend migration check**

Run:

```bash
cd backend && uv run alembic upgrade head
```

Expected: PASS and creates `resource_library_listings`, `resource_library_versions`, and `resource_library_installs`.

- [ ] **Step 5: Manual browser check**

Run the app using the project’s normal dev setup, then open `/resource-library`.

Check:

- Sidebar shows `资源库`.
- `/resource-library` defaults to `发现`.
- Filters show `全部`, `智能体`, `Skill`, `MCP`.
- Resource cards render from API data.
- Install button changes the card to installed state.
- `我的` shows installed records.

- [ ] **Step 6: Final search for rejected product naming**

Run:

```bash
python - <<'PY'
from pathlib import Path

patterns = [
    "\u5e02" + "\u573a",
    "m" + "arketplace",
    "M" + "arketplace",
    "M" + "arket",
]
roots = [
    Path("backend/app"),
    Path("frontend/src"),
    Path("docs/en"),
    Path("docs/zh"),
    Path("docs/superpowers/specs/2026-05-27-resource-library-design.md"),
]

matches = []
for root in roots:
    paths = [root] if root.is_file() else root.rglob("*")
    for path in paths:
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if any(pattern in line for pattern in patterns):
                matches.append(f"{path}:{lineno}:{line}")

if matches:
    print("\n".join(matches))
    raise SystemExit(1)
PY
```

Expected: No new Resource Library implementation files contain those terms. Existing unrelated subscription, feed, or external provider files may still match; inspect each match and only change matches introduced by this feature.

- [ ] **Step 7: Commit verification fixes**

If verification required code fixes:

```bash
git add <fixed-files>
git commit -m "fix(resource-library): address integration issues"
```

If no fixes were needed, do not create an empty commit.

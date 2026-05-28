# System Skills Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend system skills catalog list/search APIs with multi-provider support and current-user `InstalledSkill` state merging.

**Architecture:** Add a `system_skill_providers` subsystem parallel to MCP providers: schemas define the normalized contract, provider registry discovers/fetches catalog items, service merges provider results with `Kind(kind="InstalledSkill")`, and endpoint exposes `/api/system-skills/providers` plus `/api/system-skills`. `Skill` remains the package/definition entity; `InstalledSkill` is stored in the existing `kinds` table and represents user install/enable state.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy, existing `Kind` model, pytest with `uv run pytest`.

---

## File Structure

- Create `backend/app/schemas/system_skills.py`: normalized provider info, catalog item, provider error, list response, and installed-skill CRD schemas.
- Create `backend/app/services/system_skill_providers/providers/base.py`: abstract provider interface and provider metadata dataclasses.
- Create `backend/app/services/system_skill_providers/providers/builtin.py`: deterministic built-in system skills provider for the first frontend integration.
- Create `backend/app/services/system_skill_providers/providers/__init__.py`: provider discovery exports.
- Create `backend/app/services/system_skill_providers/core/registry.py`: provider registry with registration, sorting, provider lookup, and default initialization.
- Create `backend/app/services/system_skill_providers/service.py`: provider listing, catalog search aggregation, error handling, and `InstalledSkill` merge logic.
- Create `backend/app/services/system_skill_providers/__init__.py`: public exports.
- Create `backend/app/api/endpoints/system_skills.py`: FastAPI endpoints.
- Modify `backend/app/api/api.py`: include the new router at `/system-skills`.
- Test `backend/tests/services/test_system_skill_providers_service.py`: service behavior and state merge.
- Test `backend/tests/api/endpoints/test_system_skills_api.py`: API contract.

## Task 1: Schemas

**Files:**
- Create: `backend/app/schemas/system_skills.py`
- Test: `backend/tests/services/test_system_skill_providers_service.py`

- [ ] **Step 1: Write the failing schema serialization test**

Create `backend/tests/services/test_system_skill_providers_service.py` with:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.system_skills import (
    InstalledSkillSpec,
    InstalledSkillSource,
    SystemSkillCatalogItem,
    SystemSkillListResponse,
    SystemSkillProviderError,
)


def test_system_skill_catalog_response_serializes_install_state():
    item = SystemSkillCatalogItem(
        id="@builtin/image-gen",
        providerKey="builtin",
        providerName="Built-in",
        name="image-gen",
        displayName="Image Gen",
        description="Generate or edit images",
        tags=["image"],
        version="1.0.0",
        author="Wegent",
        category="system",
        capabilities=["generate_image"],
        installState="installed",
        enabled=False,
    )
    response = SystemSkillListResponse(
        total=1,
        page=1,
        pageSize=20,
        items=[item],
        providerErrors=[
            SystemSkillProviderError(
                providerKey="remote",
                code="timeout",
                message="Provider request timed out",
            )
        ],
    )

    payload = response.model_dump()

    assert payload["items"][0]["id"] == "@builtin/image-gen"
    assert payload["items"][0]["installState"] == "installed"
    assert payload["items"][0]["enabled"] is False
    assert payload["providerErrors"][0]["code"] == "timeout"


def test_installed_skill_spec_keeps_install_and_enabled_as_separate_dimensions():
    spec = InstalledSkillSpec(
        source=InstalledSkillSource(
            type="system",
            providerKey="builtin",
            skillKey="image-gen",
            catalogItemId="@builtin/image-gen",
        ),
        displayName="Image Gen",
        description="Generate or edit images",
        version="1.0.0",
        installState="installed",
        enabled=False,
    )

    assert spec.installState == "installed"
    assert spec.enabled is False
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run:

```bash
cd backend
uv run pytest tests/services/test_system_skill_providers_service.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.schemas.system_skills'`.

- [ ] **Step 3: Implement schema models**

Create `backend/app/schemas/system_skills.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


InstallState = Literal[
    "not_installed",
    "installed",
    "update_available",
    "unavailable",
    "failed",
]

ProviderErrorCode = Literal[
    "token_required",
    "unauthorized",
    "timeout",
    "connect_error",
    "provider_error",
    "mapping_error",
]


class SystemSkillProviderInfo(BaseModel):
    key: str
    name: str
    description: str
    requiresToken: bool = False
    hasToken: bool = False
    priority: int = 100


class SystemSkillProviderListResponse(BaseModel):
    providers: List[SystemSkillProviderInfo]


class SystemSkillCatalogItem(BaseModel):
    id: str
    providerKey: str
    providerName: str
    name: str
    displayName: str
    description: str
    iconUrl: Optional[str] = None
    tags: List[str] = Field(default_factory=list)
    version: Optional[str] = None
    author: Optional[str] = None
    category: str = "system"
    capabilities: List[str] = Field(default_factory=list)
    detailUrl: Optional[str] = None
    installState: InstallState = "not_installed"
    enabled: bool = False
    requiresPermission: bool = False
    permissionUrl: Optional[str] = None
    updatedAt: Optional[datetime] = None

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Optional[str]:
        if value is None:
            return None
        return str(value)


class SystemSkillProviderError(BaseModel):
    providerKey: str
    code: ProviderErrorCode
    message: str


class SystemSkillListResponse(BaseModel):
    total: int
    page: int
    pageSize: int
    items: List[SystemSkillCatalogItem]
    providerErrors: List[SystemSkillProviderError] = Field(default_factory=list)


class InstalledSkillSource(BaseModel):
    type: Literal["system", "personal", "git", "market"] = "system"
    providerKey: Optional[str] = None
    skillKey: str
    catalogItemId: Optional[str] = None


class InstalledSkillRef(BaseModel):
    kind: str = "Skill"
    name: str
    namespace: str = "default"
    user_id: Optional[int] = None


class InstalledSkillSpec(BaseModel):
    source: InstalledSkillSource
    skillRef: Optional[InstalledSkillRef] = None
    displayName: str
    description: str
    version: Optional[str] = None
    installState: InstallState = "installed"
    enabled: bool = True
    sourcePayload: Optional[Dict[str, Any]] = None

    @field_validator("version", mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Optional[str]:
        if value is None:
            return None
        return str(value)


class InstalledSkillStatus(BaseModel):
    state: str = "Available"


class InstalledSkill(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    apiVersion: str = "agent.wecode.io/v1"
    kind: Literal["InstalledSkill"] = "InstalledSkill"
    metadata: Dict[str, Any]
    spec: InstalledSkillSpec
    status: InstalledSkillStatus = Field(default_factory=InstalledSkillStatus)
```

- [ ] **Step 4: Run the schema test and verify it passes**

Run:

```bash
cd backend
uv run pytest tests/services/test_system_skill_providers_service.py -q
```

Expected: PASS for the two schema tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/app/schemas/system_skills.py backend/tests/services/test_system_skill_providers_service.py
git commit -m "feat(backend): add system skill schemas"
```

## Task 2: Provider Registry and Built-In Provider

**Files:**
- Create: `backend/app/services/system_skill_providers/providers/base.py`
- Create: `backend/app/services/system_skill_providers/providers/builtin.py`
- Create: `backend/app/services/system_skill_providers/providers/__init__.py`
- Create: `backend/app/services/system_skill_providers/core/registry.py`
- Create: `backend/app/services/system_skill_providers/core/__init__.py`
- Create: `backend/app/services/system_skill_providers/__init__.py`
- Modify: `backend/tests/services/test_system_skill_providers_service.py`

- [ ] **Step 1: Add failing registry and provider tests**

Append to `backend/tests/services/test_system_skill_providers_service.py`:

```python
import pytest

from app.services.system_skill_providers.core.registry import SystemSkillProviderRegistry
from app.services.system_skill_providers.providers.builtin import BuiltinSystemSkillProvider


def test_registry_lists_registered_providers_by_priority():
    registry = SystemSkillProviderRegistry()
    provider = BuiltinSystemSkillProvider()

    registry.register(provider)

    providers = registry.list_all()
    assert [item.key for item in providers] == ["builtin"]
    assert providers[0].name == "Built-in"


@pytest.mark.anyio
async def test_builtin_provider_searches_catalog_by_keyword():
    provider = BuiltinSystemSkillProvider()

    result = await provider.fetch_skills(keyword="image", tags=None, page=1, page_size=20)

    assert result.total == 1
    assert result.items[0].id == "@builtin/image-gen"
    assert result.items[0].displayName == "Image Gen"
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
cd backend
uv run pytest tests/services/test_system_skill_providers_service.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.system_skill_providers'`.

- [ ] **Step 3: Implement provider base**

Create `backend/app/services/system_skill_providers/providers/base.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional

from app.schemas.system_skills import SystemSkillCatalogItem


@dataclass(frozen=True)
class SystemSkillProviderConfig:
    key: str
    name: str
    description: str
    requires_token: bool = False
    priority: int = 100


@dataclass
class SystemSkillProviderResult:
    total: int
    page: int
    page_size: int
    items: List[SystemSkillCatalogItem] = field(default_factory=list)


class SystemSkillProvider(ABC):
    @abstractmethod
    def get_config(self) -> SystemSkillProviderConfig:
        """Return provider metadata."""

    @abstractmethod
    async def fetch_skills(
        self,
        *,
        keyword: Optional[str],
        tags: Optional[List[str]],
        page: int,
        page_size: int,
        token: Optional[str] = None,
        user_name: Optional[str] = None,
    ) -> SystemSkillProviderResult:
        """Fetch normalized system skills from this provider."""
```

- [ ] **Step 4: Implement built-in provider**

Create `backend/app/services/system_skill_providers/providers/builtin.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional

from app.schemas.system_skills import SystemSkillCatalogItem
from app.services.system_skill_providers.providers.base import (
    SystemSkillProvider,
    SystemSkillProviderConfig,
    SystemSkillProviderResult,
)


class BuiltinSystemSkillProvider(SystemSkillProvider):
    def get_config(self) -> SystemSkillProviderConfig:
        return SystemSkillProviderConfig(
            key="builtin",
            name="Built-in",
            description="Built-in system skills",
            requires_token=False,
            priority=10,
        )

    async def fetch_skills(
        self,
        *,
        keyword: Optional[str],
        tags: Optional[List[str]],
        page: int,
        page_size: int,
        token: Optional[str] = None,
        user_name: Optional[str] = None,
    ) -> SystemSkillProviderResult:
        items = [
            SystemSkillCatalogItem(
                id="@builtin/image-gen",
                providerKey="builtin",
                providerName="Built-in",
                name="image-gen",
                displayName="Image Gen",
                description="Generate or edit images",
                iconUrl=None,
                tags=["image", "media"],
                version="1.0.0",
                author="Wegent",
                category="system",
                capabilities=["generate_image", "edit_image"],
                detailUrl=None,
            ),
            SystemSkillCatalogItem(
                id="@builtin/openai-docs",
                providerKey="builtin",
                providerName="Built-in",
                name="openai-docs",
                displayName="OpenAI Docs",
                description="Reference OpenAI documentation",
                iconUrl=None,
                tags=["docs", "openai"],
                version="1.0.0",
                author="Wegent",
                category="system",
                capabilities=["reference_docs"],
                detailUrl=None,
            ),
        ]
        filtered = self._filter_items(items, keyword=keyword, tags=tags)
        start = (page - 1) * page_size
        end = start + page_size
        return SystemSkillProviderResult(
            total=len(filtered),
            page=page,
            page_size=page_size,
            items=filtered[start:end],
        )

    def _filter_items(
        self,
        items: List[SystemSkillCatalogItem],
        *,
        keyword: Optional[str],
        tags: Optional[List[str]],
    ) -> List[SystemSkillCatalogItem]:
        normalized_keyword = (keyword or "").strip().lower()
        normalized_tags = {tag.strip().lower() for tag in tags or [] if tag.strip()}

        def matches(item: SystemSkillCatalogItem) -> bool:
            if normalized_keyword:
                haystack = " ".join(
                    [item.name, item.displayName, item.description]
                ).lower()
                if normalized_keyword not in haystack:
                    return False
            if normalized_tags and normalized_tags.isdisjoint(
                {tag.lower() for tag in item.tags}
            ):
                return False
            return True

        return [item for item in items if matches(item)]
```

- [ ] **Step 5: Implement registry and exports**

Create `backend/app/services/system_skill_providers/core/registry.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Dict, List, Optional

from app.services.system_skill_providers.providers.base import (
    SystemSkillProvider,
    SystemSkillProviderConfig,
)
from app.services.system_skill_providers.providers.builtin import BuiltinSystemSkillProvider


class SystemSkillProviderRegistry:
    def __init__(self) -> None:
        self._providers: Dict[str, SystemSkillProvider] = {}

    def register(self, provider: SystemSkillProvider) -> None:
        config = provider.get_config()
        self._providers[config.key] = provider

    def get(self, key: str) -> Optional[SystemSkillProvider]:
        return self._providers.get(key)

    def list_all(self) -> List[SystemSkillProviderConfig]:
        configs = [provider.get_config() for provider in self._providers.values()]
        return sorted(configs, key=lambda item: (item.priority, item.name))

    def providers(self) -> List[SystemSkillProvider]:
        return [
            self._providers[config.key]
            for config in self.list_all()
            if config.key in self._providers
        ]


system_skill_provider_registry = SystemSkillProviderRegistry()
system_skill_provider_registry.register(BuiltinSystemSkillProvider())
```

Create `backend/app/services/system_skill_providers/core/__init__.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0
```

Create `backend/app/services/system_skill_providers/providers/__init__.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.system_skill_providers.providers.base import (
    SystemSkillProvider,
    SystemSkillProviderConfig,
    SystemSkillProviderResult,
)
from app.services.system_skill_providers.providers.builtin import BuiltinSystemSkillProvider

__all__ = [
    "BuiltinSystemSkillProvider",
    "SystemSkillProvider",
    "SystemSkillProviderConfig",
    "SystemSkillProviderResult",
]
```

Create `backend/app/services/system_skill_providers/__init__.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.services.system_skill_providers.core.registry import (
    SystemSkillProviderRegistry,
    system_skill_provider_registry,
)

__all__ = ["SystemSkillProviderRegistry", "system_skill_provider_registry"]
```

- [ ] **Step 6: Run registry/provider tests and verify they pass**

Run:

```bash
cd backend
uv run pytest tests/services/test_system_skill_providers_service.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add backend/app/services/system_skill_providers backend/tests/services/test_system_skill_providers_service.py
git commit -m "feat(backend): add system skill provider registry"
```

## Task 3: Service Layer and InstalledSkill Merge

**Files:**
- Create: `backend/app/services/system_skill_providers/service.py`
- Modify: `backend/tests/services/test_system_skill_providers_service.py`

- [ ] **Step 1: Add failing service tests**

Append to `backend/tests/services/test_system_skill_providers_service.py`:

```python
from app.models.kind import Kind
from app.services.system_skill_providers.service import SystemSkillProviderService


def _create_installed_skill(test_db, user_id: int, *, enabled: bool) -> Kind:
    installed = Kind(
        api_version="agent.wecode.io/v1",
        kind="InstalledSkill",
        name="builtin-image-gen",
        namespace="default",
        user_id=user_id,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledSkill",
            "metadata": {"name": "builtin-image-gen", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "system",
                    "providerKey": "builtin",
                    "skillKey": "image-gen",
                    "catalogItemId": "@builtin/image-gen",
                },
                "displayName": "Image Gen",
                "description": "Generate or edit images",
                "version": "1.0.0",
                "installState": "installed",
                "enabled": enabled,
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(installed)
    test_db.commit()
    test_db.refresh(installed)
    return installed


@pytest.mark.anyio
async def test_service_merges_installed_but_disabled_state(test_db, test_user):
    _create_installed_skill(test_db, test_user.id, enabled=False)
    service = SystemSkillProviderService()

    response = await service.list_system_skills(
        db=test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        provider_key="builtin",
        keyword="image",
        tags=None,
        page=1,
        page_size=20,
    )

    assert response.total == 1
    assert response.items[0].id == "@builtin/image-gen"
    assert response.items[0].installState == "installed"
    assert response.items[0].enabled is False


@pytest.mark.anyio
async def test_service_returns_not_installed_when_no_installed_skill(test_db, test_user):
    service = SystemSkillProviderService()

    response = await service.list_system_skills(
        db=test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        provider_key="builtin",
        keyword="openai",
        tags=None,
        page=1,
        page_size=20,
    )

    assert response.total == 1
    assert response.items[0].id == "@builtin/openai-docs"
    assert response.items[0].installState == "not_installed"
    assert response.items[0].enabled is False
```

- [ ] **Step 2: Run service tests and verify they fail**

Run:

```bash
cd backend
uv run pytest tests/services/test_system_skill_providers_service.py -q
```

Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.system_skill_providers.service'`.

- [ ] **Step 3: Implement service**

Create `backend/app/services/system_skill_providers/service.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Dict, List, Optional, Tuple

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.system_skills import (
    SystemSkillCatalogItem,
    SystemSkillListResponse,
    SystemSkillProviderError,
    SystemSkillProviderInfo,
    SystemSkillProviderListResponse,
)
from app.services.system_skill_providers.core.registry import (
    SystemSkillProviderRegistry,
    system_skill_provider_registry,
)
from app.services.system_skill_providers.providers.base import SystemSkillProvider


class SystemSkillProviderService:
    def __init__(
        self,
        registry: SystemSkillProviderRegistry = system_skill_provider_registry,
    ) -> None:
        self._registry = registry

    def list_providers(self) -> SystemSkillProviderListResponse:
        providers = [
            SystemSkillProviderInfo(
                key=config.key,
                name=config.name,
                description=config.description,
                requiresToken=config.requires_token,
                hasToken=False,
                priority=config.priority,
            )
            for config in self._registry.list_all()
        ]
        return SystemSkillProviderListResponse(providers=providers)

    async def list_system_skills(
        self,
        *,
        db: Session,
        user_id: int,
        user_name: Optional[str],
        provider_key: Optional[str],
        keyword: Optional[str],
        tags: Optional[List[str]],
        page: int,
        page_size: int,
    ) -> SystemSkillListResponse:
        providers = self._select_providers(provider_key)
        installed = self._load_installed_state(db, user_id)
        items: List[SystemSkillCatalogItem] = []
        errors: List[SystemSkillProviderError] = []

        for provider in providers:
            config = provider.get_config()
            try:
                result = await provider.fetch_skills(
                    keyword=keyword,
                    tags=tags,
                    page=page,
                    page_size=page_size,
                    token=None,
                    user_name=user_name,
                )
                for item in result.items:
                    items.append(self._merge_installed_state(item, installed))
            except Exception:
                errors.append(
                    SystemSkillProviderError(
                        providerKey=config.key,
                        code="provider_error",
                        message="Provider request failed",
                    )
                )

        return SystemSkillListResponse(
            total=len(items),
            page=page,
            pageSize=page_size,
            items=items,
            providerErrors=errors,
        )

    def _select_providers(
        self, provider_key: Optional[str]
    ) -> List[SystemSkillProvider]:
        if provider_key:
            provider = self._registry.get(provider_key)
            return [provider] if provider else []
        return self._registry.providers()

    def _load_installed_state(
        self, db: Session, user_id: int
    ) -> Dict[Tuple[str, str], dict]:
        rows = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "InstalledSkill",
                Kind.is_active == True,
            )
            .all()
        )
        installed: Dict[Tuple[str, str], dict] = {}
        for row in rows:
            spec = row.json.get("spec", {}) if isinstance(row.json, dict) else {}
            source = spec.get("source", {}) if isinstance(spec, dict) else {}
            provider_key = source.get("providerKey")
            skill_key = source.get("skillKey")
            if provider_key and skill_key:
                installed[(provider_key, skill_key)] = spec
        return installed

    def _merge_installed_state(
        self,
        item: SystemSkillCatalogItem,
        installed: Dict[Tuple[str, str], dict],
    ) -> SystemSkillCatalogItem:
        spec = installed.get((item.providerKey, item.name))
        if not spec:
            return item.model_copy(update={"installState": "not_installed", "enabled": False})

        return item.model_copy(
            update={
                "installState": spec.get("installState", "installed"),
                "enabled": bool(spec.get("enabled", False)),
            }
        )


system_skill_provider_service = SystemSkillProviderService()
```

- [ ] **Step 4: Run service tests and verify they pass**

Run:

```bash
cd backend
uv run pytest tests/services/test_system_skill_providers_service.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add backend/app/services/system_skill_providers/service.py backend/tests/services/test_system_skill_providers_service.py
git commit -m "feat(backend): merge system skill install state"
```

## Task 4: API Endpoints

**Files:**
- Create: `backend/app/api/endpoints/system_skills.py`
- Modify: `backend/app/api/api.py`
- Test: `backend/tests/api/endpoints/test_system_skills_api.py`

- [ ] **Step 1: Write failing API tests**

Create `backend/tests/api/endpoints/test_system_skills_api.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_list_system_skill_providers(test_client: TestClient, test_token: str):
    response = test_client.get(
        "/api/system-skills/providers",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["providers"][0]["key"] == "builtin"
    assert payload["providers"][0]["requiresToken"] is False


def test_search_system_skills_returns_catalog_items(
    test_client: TestClient,
    test_token: str,
):
    response = test_client.get(
        "/api/system-skills?providerKey=builtin&keyword=image",
        headers=_auth_header(test_token),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["items"][0]["id"] == "@builtin/image-gen"
    assert payload["items"][0]["installState"] == "not_installed"
    assert payload["items"][0]["enabled"] is False
    assert payload["providerErrors"] == []
```

- [ ] **Step 2: Run API tests and verify they fail**

Run:

```bash
cd backend
uv run pytest tests/api/endpoints/test_system_skills_api.py -q
```

Expected: FAIL with 404 for `/api/system-skills/providers`.

- [ ] **Step 3: Implement endpoint**

Create `backend/app/api/endpoints/system_skills.py`:

```python
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.system_skills import (
    SystemSkillListResponse,
    SystemSkillProviderListResponse,
)
from app.services.system_skill_providers.service import system_skill_provider_service

router = APIRouter()


@router.get("/providers", response_model=SystemSkillProviderListResponse)
def list_system_skill_providers(
    current_user: User = Depends(security.get_current_user),
) -> SystemSkillProviderListResponse:
    return system_skill_provider_service.list_providers()


@router.get("", response_model=SystemSkillListResponse)
async def list_system_skills(
    providerKey: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    tags: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    pageSize: int = Query(20, ge=1, le=100),
    category: str = Query("system"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
) -> SystemSkillListResponse:
    parsed_tags = [tag.strip() for tag in tags.split(",")] if tags else None
    return await system_skill_provider_service.list_system_skills(
        db=db,
        user_id=current_user.id,
        user_name=current_user.user_name,
        provider_key=providerKey,
        keyword=keyword,
        tags=parsed_tags,
        page=page,
        page_size=pageSize,
    )
```

- [ ] **Step 4: Register router**

Modify `backend/app/api/api.py` imports to include `system_skills`:

```python
from app.api.endpoints import (
    admin,
    api_keys,
    attachments_open,
    auth,
    deep_research,
    devices,
    dingtalk_docs,
    groups,
    health,
    knowledge,
    knowledge_open,
    knowledge_transfer,
    mcp_providers,
    oidc,
    openapi_responses,
    pet,
    projects,
    prompt_optimization,
    quota,
    repository,
    share,
    skill_identity,
    skill_market,
    system_skills,
    subtasks,
    tables,
    token_issuers,
    users,
    utils,
    web_scraper,
    wiki,
    wizard,
    work_queue,
)
```

Add router include near the skill market router:

```python
api_router.include_router(
    system_skills.router, prefix="/system-skills", tags=["system-skills"]
)
```

- [ ] **Step 5: Run API tests and verify they pass**

Run:

```bash
cd backend
uv run pytest tests/api/endpoints/test_system_skills_api.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add backend/app/api/endpoints/system_skills.py backend/app/api/api.py backend/tests/api/endpoints/test_system_skills_api.py
git commit -m "feat(backend): expose system skills catalog api"
```

## Task 5: Full Verification

**Files:**
- No new source files.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
cd backend
uv run pytest tests/services/test_system_skill_providers_service.py tests/api/endpoints/test_system_skills_api.py -q
```

Expected: all tests pass.

- [ ] **Step 2: Run compatibility tests for existing skills and MCP providers**

Run:

```bash
cd backend
uv run pytest tests/api/test_skills_api.py tests/services/test_mcp_providers_service.py tests/api/endpoints/test_mcp_providers_endpoint.py -q
```

Expected: all tests pass.

- [ ] **Step 3: Run formatting/lint check if configured for backend**

Run:

```bash
cd backend
uv run python -m compileall app/schemas/system_skills.py app/services/system_skill_providers app/api/endpoints/system_skills.py
```

Expected: command exits with code 0.

- [ ] **Step 4: Commit any verification-only fixes**

If verification required small fixes, commit them:

```bash
git add backend/app backend/tests
git commit -m "fix(backend): stabilize system skills catalog"
```

If no fixes were needed, do not create an empty commit.

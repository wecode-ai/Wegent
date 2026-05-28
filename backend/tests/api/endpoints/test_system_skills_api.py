# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_db
from app.api.endpoints import system_skills
from app.core import security
from app.schemas.system_skills import (
    InstalledSkill,
    InstalledSkillListResponse,
    InstalledSkillSource,
    InstalledSkillSpec,
    SystemSkillCatalogItem,
    SystemSkillInstallRequest,
    SystemSkillListResponse,
    SystemSkillProviderInfo,
    SystemSkillProviderListResponse,
    SystemSkillUpdateInstalledRequest,
)


class StubSystemSkillProviderService:
    def __init__(self) -> None:
        self.list_calls: list[dict[str, Any]] = []
        self.install_calls: list[dict[str, Any]] = []
        self.update_calls: list[dict[str, Any]] = []
        self.uninstall_calls: list[dict[str, Any]] = []

    def list_providers(self) -> SystemSkillProviderListResponse:
        return SystemSkillProviderListResponse(
            providers=[
                SystemSkillProviderInfo(
                    key="builtin",
                    name="Built-in",
                    description="Built-in system skills",
                    requiresToken=False,
                    hasToken=False,
                    priority=10,
                )
            ]
        )

    async def list_system_skills(
        self,
        *,
        db: Any,
        user_id: int,
        user_name: str,
        provider_key: str | None,
        keyword: str | None,
        tags: list[str] | None,
        page: int,
        page_size: int,
    ) -> SystemSkillListResponse:
        self.list_calls.append(
            {
                "db": db,
                "user_id": user_id,
                "user_name": user_name,
                "provider_key": provider_key,
                "keyword": keyword,
                "tags": tags,
                "page": page,
                "page_size": page_size,
            }
        )
        return SystemSkillListResponse(
            total=1,
            page=page,
            pageSize=page_size,
            items=[
                SystemSkillCatalogItem(
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
                    installState="not_installed",
                    enabled=False,
                    updatedAt=datetime(2026, 5, 27, tzinfo=timezone.utc),
                )
            ],
            providerErrors=[],
        )

    async def install_system_skill(
        self,
        *,
        db: Any,
        user_id: int,
        request: SystemSkillInstallRequest,
    ) -> InstalledSkill:
        self.install_calls.append({"db": db, "user_id": user_id, "request": request})
        return InstalledSkill(
            metadata={"name": "weibo-wehot", "namespace": "default"},
            spec=InstalledSkillSpec(
                source=InstalledSkillSource(
                    type="system",
                    providerKey=request.providerKey,
                    skillKey=request.skillKey,
                    catalogItemId=request.catalogItemId,
                ),
                displayName=request.displayName,
                description=request.description,
                version=request.version,
                installState="installed",
                enabled=True,
            ),
        )

    def list_installed_system_skills(
        self, *, db: Any, user_id: int
    ) -> InstalledSkillListResponse:
        return InstalledSkillListResponse(
            items=[
                InstalledSkill(
                    metadata={"name": "weibo-wehot", "namespace": "default"},
                    spec=InstalledSkillSpec(
                        source=InstalledSkillSource(
                            type="system",
                            providerKey="weibo",
                            skillKey="wehot",
                            catalogItemId="@weibo/shitao7_wehot",
                        ),
                        displayName="wehot",
                        description="Weibo hot search",
                        version="1.0.0",
                        installState="installed",
                        enabled=True,
                    ),
                )
            ]
        )

    def update_installed_system_skill(
        self,
        *,
        db: Any,
        user_id: int,
        installed_id: int,
        request: SystemSkillUpdateInstalledRequest,
    ) -> InstalledSkill:
        self.update_calls.append(
            {
                "db": db,
                "user_id": user_id,
                "installed_id": installed_id,
                "request": request,
            }
        )
        return InstalledSkill(
            metadata={"name": "weibo-wehot", "namespace": "default"},
            spec=InstalledSkillSpec(
                source=InstalledSkillSource(
                    type="system",
                    providerKey="weibo",
                    skillKey="wehot",
                    catalogItemId="@weibo/shitao7_wehot",
                ),
                displayName="wehot",
                description="Weibo hot search",
                version="1.0.0",
                installState="installed",
                enabled=request.enabled,
            ),
        )

    def uninstall_installed_system_skill(
        self,
        *,
        db: Any,
        user_id: int,
        installed_id: int,
    ) -> None:
        self.uninstall_calls.append(
            {"db": db, "user_id": user_id, "installed_id": installed_id}
        )


@pytest.fixture
def stub_service(monkeypatch: pytest.MonkeyPatch) -> StubSystemSkillProviderService:
    service = StubSystemSkillProviderService()
    monkeypatch.setattr(system_skills, "system_skill_provider_service", service)
    return service


@pytest.fixture
def system_skills_client(stub_service: StubSystemSkillProviderService) -> TestClient:
    app = FastAPI()
    app.include_router(system_skills.router, prefix="/api/system-skills")

    db = object()

    def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: SimpleNamespace(
        id=123,
        user_name="api-user",
    )

    return TestClient(app)


def test_list_system_skill_providers_returns_builtin(
    system_skills_client: TestClient,
) -> None:
    response = system_skills_client.get("/api/system-skills/providers")

    assert response.status_code == 200
    payload = response.json()
    assert payload["providers"] == [
        {
            "key": "builtin",
            "name": "Built-in",
            "description": "Built-in system skills",
            "requiresToken": False,
            "hasToken": False,
            "priority": 10,
        }
    ]


def test_search_system_skills_returns_image_gen_catalog_item(
    system_skills_client: TestClient,
    stub_service: StubSystemSkillProviderService,
) -> None:
    response = system_skills_client.get(
        "/api/system-skills",
        params={
            "providerKey": "builtin",
            "keyword": "image",
            "tags": "image, frontend",
            "category": "system",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["page"] == 1
    assert payload["pageSize"] == 20
    assert payload["items"][0]["id"] == "@builtin/image-gen"
    assert payload["items"][0]["providerKey"] == "builtin"
    assert payload["items"][0]["displayName"] == "Image Gen"
    assert payload["items"][0]["installState"] == "not_installed"
    assert payload["items"][0]["enabled"] is False
    assert payload["providerErrors"] == []
    assert stub_service.list_calls[0]["provider_key"] == "builtin"
    assert stub_service.list_calls[0]["keyword"] == "image"
    assert stub_service.list_calls[0]["tags"] == ["image", "frontend"]
    assert stub_service.list_calls[0]["user_id"] == 123


def test_search_system_skills_rejects_non_system_category(
    system_skills_client: TestClient,
) -> None:
    response = system_skills_client.get(
        "/api/system-skills",
        params={"category": "personal"},
    )

    assert response.status_code == 422


def test_install_system_skill_forwards_current_user(
    system_skills_client: TestClient,
    stub_service: StubSystemSkillProviderService,
) -> None:
    response = system_skills_client.post(
        "/api/system-skills/install",
        json={
            "providerKey": "weibo",
            "skillKey": "wehot",
            "catalogItemId": "@weibo/shitao7_wehot",
            "displayName": "wehot",
            "description": "Weibo hot search",
            "version": "1.0.0",
        },
    )

    assert response.status_code == 201
    assert response.json()["spec"]["enabled"] is True
    assert stub_service.install_calls[0]["user_id"] == 123
    assert (
        stub_service.install_calls[0]["request"].catalogItemId == "@weibo/shitao7_wehot"
    )


def test_list_installed_system_skills_returns_user_items(
    system_skills_client: TestClient,
) -> None:
    response = system_skills_client.get("/api/system-skills/installed")

    assert response.status_code == 200
    assert response.json()["items"][0]["spec"]["source"]["skillKey"] == "wehot"


def test_update_installed_system_skill_forwards_enabled_state(
    system_skills_client: TestClient,
    stub_service: StubSystemSkillProviderService,
) -> None:
    response = system_skills_client.put(
        "/api/system-skills/installed/42",
        json={"enabled": False},
    )

    assert response.status_code == 200
    assert response.json()["spec"]["enabled"] is False
    assert stub_service.update_calls[0]["installed_id"] == 42
    assert stub_service.update_calls[0]["request"].enabled is False


def test_uninstall_installed_system_skill_forwards_current_user(
    system_skills_client: TestClient,
    stub_service: StubSystemSkillProviderService,
) -> None:
    response = system_skills_client.delete("/api/system-skills/installed/42")

    assert response.status_code == 204
    assert len(stub_service.uninstall_calls) == 1
    assert stub_service.uninstall_calls[0]["user_id"] == 123
    assert stub_service.uninstall_calls[0]["installed_id"] == 42

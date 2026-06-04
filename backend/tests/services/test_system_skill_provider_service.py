# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import io
import zipfile

import pytest

from app.models.kind import Kind
from app.models.skill_binary import SkillBinary
from app.schemas.system_skills import (
    PersonalSkillInstallRequest,
    SystemSkillCatalogItem,
    SystemSkillInstallRequest,
    SystemSkillProviderListResponse,
    SystemSkillUpdateInstalledRequest,
)
from app.services.system_skill_providers.core.registry import (
    SystemSkillProviderRegistry,
)
from app.services.system_skill_providers.providers.base import (
    SystemSkillProvider,
    SystemSkillProviderConfig,
    SystemSkillProviderResult,
)
from app.services.system_skill_providers.service import SystemSkillProviderService


class StaticSystemSkillProvider(SystemSkillProvider):
    def __init__(
        self,
        *,
        key: str = "builtin",
        name: str = "Built-in",
        priority: int = 10,
        requires_token: bool = False,
        items: list[SystemSkillCatalogItem] | None = None,
    ) -> None:
        self._config = SystemSkillProviderConfig(
            key=key,
            name=name,
            description=f"{name} system skills",
            requires_token=requires_token,
            priority=priority,
        )
        self.fetch_count = 0
        self._items = items or [
            SystemSkillCatalogItem(
                id="@builtin/image-gen",
                providerKey="builtin",
                providerName="Built-in",
                name="image-gen",
                displayName="Image Gen",
                description="Generate or edit images",
                tags=["image", "media"],
                version="1.0.0",
                author="Wegent",
                category="system",
                capabilities=["generate_image"],
            )
        ]
        self.downloaded_skill_keys: list[str] = []

    def get_config(self) -> SystemSkillProviderConfig:
        return self._config

    async def fetch_skills(
        self,
        *,
        keyword: str | None,
        tags: list[str] | None,
        page: int,
        page_size: int,
        token: str | None = None,
        user_name: str | None = None,
    ) -> SystemSkillProviderResult:
        self.fetch_count += 1
        items = self._filter_items(keyword=keyword, tags=tags)
        start = (page - 1) * page_size
        end = start + page_size
        return SystemSkillProviderResult(
            total=len(items),
            page=page,
            page_size=page_size,
            items=items[start:end],
        )

    async def download_skill(
        self,
        *,
        source_skill_key: str,
        version: str | None = None,
    ) -> bytes:
        self.downloaded_skill_keys.append(source_skill_key)
        return _create_skill_zip(
            skill_name=source_skill_key,
            description="Downloaded system skill",
        )

    def _filter_items(
        self, *, keyword: str | None, tags: list[str] | None
    ) -> list[SystemSkillCatalogItem]:
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

        return [item for item in self._items if matches(item)]


class FailingSystemSkillProvider(SystemSkillProvider):
    def get_config(self) -> SystemSkillProviderConfig:
        return SystemSkillProviderConfig(
            key="remote",
            name="Remote",
            description="Remote system skills",
            requires_token=False,
            priority=20,
        )

    async def fetch_skills(
        self,
        *,
        keyword: str | None,
        tags: list[str] | None,
        page: int,
        page_size: int,
        token: str | None = None,
        user_name: str | None = None,
    ) -> SystemSkillProviderResult:
        raise RuntimeError("remote provider failed")


def _build_service(*providers: SystemSkillProvider) -> SystemSkillProviderService:
    registry = SystemSkillProviderRegistry()
    for provider in providers:
        registry.register(provider)
    return SystemSkillProviderService(registry=registry)


def _create_skill_zip(*, skill_name: str, description: str) -> bytes:
    skill_md = f"""---
description: "{description}"
version: "1.0.0"
author: "System"
tags: ["system"]
---

Use this skill.
"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(f"{skill_name}/SKILL.md", skill_md)
    return buffer.getvalue()


def _catalog_item(
    *,
    provider_key: str,
    name: str,
    display_name: str,
) -> SystemSkillCatalogItem:
    return SystemSkillCatalogItem(
        id=f"@{provider_key}/{name}",
        providerKey=provider_key,
        providerName=provider_key.title(),
        name=name,
        displayName=display_name,
        description=f"{display_name} description",
        tags=["system"],
        version="1.0.0",
        author="Wegent",
        category="system",
        capabilities=[name],
    )


def _create_installed_skill(test_db, user_id: int, *, enabled: bool) -> Kind:
    installed = Kind(
        user_id=user_id,
        kind="InstalledSkill",
        name="builtin-image-gen",
        namespace="default",
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


def _create_skill_definition(test_db, user_id: int) -> Kind:
    skill = Kind(
        user_id=user_id,
        kind="Skill",
        name="image-gen",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": "image-gen", "namespace": "default"},
            "spec": {"description": "Generate or edit images"},
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    return skill


def _create_personal_skill_definition(test_db, user_id: int) -> Kind:
    skill = Kind(
        user_id=user_id,
        kind="Skill",
        name="excel-helper",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": "excel-helper", "namespace": "default"},
            "spec": {
                "displayName": "Excel Helper",
                "description": "Analyze Excel workbooks",
                "version": "1.0.0",
                "author": "Alice",
                "tags": ["personal"],
            },
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    return skill


def _create_personal_installed_skill(
    test_db,
    user_id: int,
    *,
    skill: Kind,
    enabled: bool = True,
    active: bool = True,
    suffix: str = "",
) -> Kind:
    installed = Kind(
        user_id=user_id,
        kind="InstalledSkill",
        name=f"personal-{skill.name}{suffix}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledSkill",
            "metadata": {
                "name": f"personal-{skill.name}{suffix}",
                "namespace": "default",
            },
            "spec": {
                "source": {
                    "type": "personal",
                    "skillKey": skill.name,
                    "catalogItemId": f"personal/{skill.id}",
                },
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": skill.namespace,
                    "user_id": skill.user_id,
                },
                "displayName": skill.json["spec"].get("displayName") or skill.name,
                "description": skill.json["spec"].get("description", ""),
                "installState": "installed" if active else "uninstalled",
                "enabled": enabled,
            },
            "status": {"state": "Available"},
        },
        is_active=active,
    )
    test_db.add(installed)
    test_db.commit()
    test_db.refresh(installed)
    return installed


def test_list_providers_returns_provider_list_response() -> None:
    service = _build_service(StaticSystemSkillProvider())

    response = service.list_providers()

    assert isinstance(response, SystemSkillProviderListResponse)
    assert [provider.key for provider in response.providers] == ["builtin"]
    assert response.providers[0].requiresToken is False
    assert response.providers[0].hasToken is False


@pytest.mark.anyio
async def test_list_system_skills_returns_not_installed_state(test_db, test_user):
    service = _build_service(StaticSystemSkillProvider())

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
    assert response.items[0].installState == "not_installed"
    assert response.items[0].enabled is False
    assert response.providerErrors == []


@pytest.mark.anyio
async def test_list_system_skills_merges_installed_but_disabled_state(
    test_db, test_user
):
    _create_installed_skill(test_db, test_user.id, enabled=False)
    service = _build_service(StaticSystemSkillProvider())

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
    assert response.items[0].installedSkillId is not None
    assert response.items[0].enabled is False


@pytest.mark.anyio
async def test_list_system_skills_keeps_provider_errors_partial(test_db, test_user):
    service = _build_service(StaticSystemSkillProvider(), FailingSystemSkillProvider())

    response = await service.list_system_skills(
        db=test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        provider_key=None,
        keyword="image",
        tags=None,
        page=1,
        page_size=20,
    )

    assert response.total == 1
    assert response.items[0].id == "@builtin/image-gen"
    assert len(response.providerErrors) == 1
    assert response.providerErrors[0].providerKey == "remote"
    assert response.providerErrors[0].code == "provider_error"


@pytest.mark.anyio
async def test_list_system_skills_applies_global_pagination_across_providers(
    test_db, test_user
):
    first_provider = StaticSystemSkillProvider(
        key="alpha",
        name="Alpha",
        priority=10,
        items=[
            _catalog_item(provider_key="alpha", name="one", display_name="One"),
            _catalog_item(provider_key="alpha", name="two", display_name="Two"),
        ],
    )
    second_provider = StaticSystemSkillProvider(
        key="beta",
        name="Beta",
        priority=20,
        items=[
            _catalog_item(provider_key="beta", name="three", display_name="Three"),
            _catalog_item(provider_key="beta", name="four", display_name="Four"),
        ],
    )
    service = _build_service(first_provider, second_provider)

    first_page = await service.list_system_skills(
        db=test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        provider_key=None,
        keyword=None,
        tags=None,
        page=1,
        page_size=2,
    )
    second_page = await service.list_system_skills(
        db=test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        provider_key=None,
        keyword=None,
        tags=None,
        page=2,
        page_size=2,
    )

    assert first_page.total == 4
    assert [item.id for item in first_page.items] == ["@alpha/one", "@alpha/two"]
    assert len(first_page.items) == 2
    assert second_page.total == 4
    assert [item.id for item in second_page.items] == ["@beta/three", "@beta/four"]
    assert len(second_page.items) == 2


@pytest.mark.anyio
async def test_list_system_skills_ignores_matching_skill_definition_without_installed_skill(
    test_db, test_user
):
    _create_skill_definition(test_db, test_user.id)
    service = _build_service(StaticSystemSkillProvider())

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

    assert response.items[0].installState == "not_installed"
    assert response.items[0].enabled is False


@pytest.mark.anyio
async def test_list_system_skills_reports_token_required_provider_without_fetching(
    test_db, test_user
):
    provider = StaticSystemSkillProvider(
        key="private",
        name="Private",
        requires_token=True,
        items=[
            _catalog_item(
                provider_key="private",
                name="private-skill",
                display_name="Private Skill",
            )
        ],
    )
    service = _build_service(provider)

    response = await service.list_system_skills(
        db=test_db,
        user_id=test_user.id,
        user_name=test_user.user_name,
        provider_key=None,
        keyword=None,
        tags=None,
        page=1,
        page_size=20,
    )

    assert response.total == 0
    assert response.items == []
    assert provider.fetch_count == 0
    assert len(response.providerErrors) == 1
    assert response.providerErrors[0].providerKey == "private"
    assert response.providerErrors[0].code == "token_required"


@pytest.mark.anyio
async def test_install_system_skill_downloads_skill_and_creates_installed_state(
    test_db, test_user
):
    provider = StaticSystemSkillProvider()
    service = _build_service(provider)

    installed = await service.install_system_skill(
        db=test_db,
        user_id=test_user.id,
        request=SystemSkillInstallRequest(
            providerKey="builtin",
            skillKey="image-gen",
            catalogItemId="@builtin/acme_image-gen",
            displayName="Image Gen",
            description="Generate or edit images",
            version="1.0.0",
        ),
    )

    skill = (
        test_db.query(Kind)
        .filter(
            Kind.user_id == test_user.id,
            Kind.kind == "Skill",
            Kind.name == "image-gen",
            Kind.namespace == "default",
            Kind.is_active == True,
        )
        .one()
    )
    binary = test_db.query(SkillBinary).filter(SkillBinary.kind_id == skill.id).one()

    assert provider.downloaded_skill_keys == ["acme_image-gen"]
    assert binary.file_size > 0
    assert installed.spec.enabled is True
    assert installed.spec.installState == "installed"
    assert installed.spec.skillRef is not None
    assert installed.spec.skillRef.name == "image-gen"
    assert installed.spec.skillRef.user_id == test_user.id


def test_install_personal_skill_creates_installed_state(test_db, test_user):
    skill = _create_personal_skill_definition(test_db, test_user.id)
    service = _build_service(StaticSystemSkillProvider())

    installed = service.install_personal_skill(
        db=test_db,
        user_id=test_user.id,
        request=PersonalSkillInstallRequest(skillId=skill.id),
    )

    assert installed.spec.source.type == "personal"
    assert installed.spec.source.skillKey == "excel-helper"
    assert installed.spec.enabled is True
    assert installed.spec.installState == "installed"
    assert installed.spec.skillRef is not None
    assert installed.spec.skillRef.name == "excel-helper"
    assert installed.spec.skillRef.user_id == test_user.id


def test_install_personal_skill_reactivates_existing_installed_state(
    test_db, test_user
):
    skill = _create_personal_skill_definition(test_db, test_user.id)
    service = _build_service(StaticSystemSkillProvider())
    first = service.install_personal_skill(
        db=test_db,
        user_id=test_user.id,
        request=PersonalSkillInstallRequest(skillId=skill.id),
    )
    service.uninstall_installed_system_skill(
        db=test_db,
        user_id=test_user.id,
        installed_id=int(first.metadata["labels"]["id"]),
    )

    second = service.install_personal_skill(
        db=test_db,
        user_id=test_user.id,
        request=PersonalSkillInstallRequest(skillId=skill.id),
    )

    refreshed = test_db.get(Kind, int(first.metadata["labels"]["id"]))
    installed_rows = (
        test_db.query(Kind)
        .filter(Kind.user_id == test_user.id, Kind.kind == "InstalledSkill")
        .all()
    )
    assert int(second.metadata["labels"]["id"]) == int(first.metadata["labels"]["id"])
    assert refreshed.is_active is True
    assert refreshed.json["spec"]["installState"] == "installed"
    assert len(installed_rows) == 1


def test_install_personal_skill_deactivates_duplicate_installed_states(
    test_db, test_user
):
    skill = _create_personal_skill_definition(test_db, test_user.id)
    older = _create_personal_installed_skill(
        test_db,
        test_user.id,
        skill=skill,
        active=False,
        enabled=False,
        suffix="-old",
    )
    duplicate = _create_personal_installed_skill(
        test_db,
        test_user.id,
        skill=skill,
        active=True,
        enabled=True,
        suffix="-duplicate",
    )
    service = _build_service(StaticSystemSkillProvider())

    installed = service.install_personal_skill(
        db=test_db,
        user_id=test_user.id,
        request=PersonalSkillInstallRequest(skillId=skill.id),
    )

    refreshed_older = test_db.get(Kind, older.id)
    refreshed_duplicate = test_db.get(Kind, duplicate.id)
    assert int(installed.metadata["labels"]["id"]) == duplicate.id
    assert refreshed_duplicate.is_active is True
    assert refreshed_duplicate.json["spec"]["installState"] == "installed"
    assert refreshed_older.is_active is False
    assert refreshed_older.json["spec"]["installState"] == "uninstalled"


def test_install_personal_skill_deactivates_legacy_system_duplicate_by_skill_ref(
    test_db, test_user
):
    skill = _create_personal_skill_definition(test_db, test_user.id)
    legacy_system = Kind(
        user_id=test_user.id,
        kind="InstalledSkill",
        name=f"legacy-{skill.name}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledSkill",
            "metadata": {"name": f"legacy-{skill.name}", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "system",
                    "providerKey": "legacy",
                    "skillKey": skill.name,
                    "catalogItemId": f"@legacy/{skill.name}",
                },
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": skill.namespace,
                    "user_id": skill.user_id,
                },
                "displayName": skill.json["spec"].get("displayName") or skill.name,
                "description": skill.json["spec"].get("description", ""),
                "installState": "installed",
                "enabled": True,
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    test_db.add(legacy_system)
    test_db.commit()
    test_db.refresh(legacy_system)
    service = _build_service(StaticSystemSkillProvider())

    installed = service.install_personal_skill(
        db=test_db,
        user_id=test_user.id,
        request=PersonalSkillInstallRequest(skillId=skill.id),
    )

    refreshed_legacy = test_db.get(Kind, legacy_system.id)
    installed_rows = (
        test_db.query(Kind)
        .filter(Kind.user_id == test_user.id, Kind.kind == "InstalledSkill")
        .all()
    )
    assert installed.spec.source.type == "personal"
    assert int(installed.metadata["labels"]["id"]) != legacy_system.id
    assert refreshed_legacy.is_active is False
    assert refreshed_legacy.json["spec"]["installState"] == "uninstalled"
    assert len(installed_rows) == 2


@pytest.mark.anyio
async def test_update_installed_system_skill_toggles_enabled_state(test_db, test_user):
    installed = _create_installed_skill(test_db, test_user.id, enabled=True)
    service = _build_service(StaticSystemSkillProvider())

    updated = service.update_installed_system_skill(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed.id,
        request=SystemSkillUpdateInstalledRequest(enabled=False),
    )

    refreshed = test_db.get(Kind, installed.id)
    assert updated.spec.enabled is False
    assert refreshed.json["spec"]["enabled"] is False


def test_uninstall_system_skill_soft_deletes_installed_state(test_db, test_user):
    installed = _create_installed_skill(test_db, test_user.id, enabled=True)
    service = _build_service(StaticSystemSkillProvider())

    service.uninstall_installed_system_skill(
        db=test_db,
        user_id=test_user.id,
        installed_id=installed.id,
    )

    refreshed = test_db.get(Kind, installed.id)
    listed = service.list_installed_system_skills(db=test_db, user_id=test_user.id)
    assert refreshed.is_active is False
    assert listed.items == []


def test_uninstall_personal_skill_deactivates_duplicate_installed_states(
    test_db, test_user
):
    skill = _create_personal_skill_definition(test_db, test_user.id)
    first = _create_personal_installed_skill(
        test_db,
        test_user.id,
        skill=skill,
        suffix="-first",
    )
    duplicate = _create_personal_installed_skill(
        test_db,
        test_user.id,
        skill=skill,
        suffix="-duplicate",
    )
    service = _build_service(StaticSystemSkillProvider())

    service.uninstall_installed_system_skill(
        db=test_db,
        user_id=test_user.id,
        installed_id=first.id,
    )

    refreshed_first = test_db.get(Kind, first.id)
    refreshed_duplicate = test_db.get(Kind, duplicate.id)
    listed = service.list_installed_system_skills(db=test_db, user_id=test_user.id)
    assert refreshed_first.is_active is False
    assert refreshed_first.json["spec"]["installState"] == "uninstalled"
    assert refreshed_duplicate.is_active is False
    assert refreshed_duplicate.json["spec"]["installState"] == "uninstalled"
    assert listed.items == []


def test_uninstall_personal_skill_deactivates_legacy_system_duplicate(
    test_db, test_user
):
    skill = _create_personal_skill_definition(test_db, test_user.id)
    legacy_system = Kind(
        user_id=test_user.id,
        kind="InstalledSkill",
        name=f"weibo-{skill.name}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledSkill",
            "metadata": {"name": f"weibo-{skill.name}", "namespace": "default"},
            "spec": {
                "source": {
                    "type": "system",
                    "providerKey": "weibo",
                    "skillKey": skill.name,
                    "catalogItemId": f"@weibo/{skill.name}",
                },
                "skillRef": {
                    "kind": "Skill",
                    "name": skill.name,
                    "namespace": skill.namespace,
                    "user_id": skill.user_id,
                },
                "displayName": skill.json["spec"].get("displayName") or skill.name,
                "description": skill.json["spec"].get("description", ""),
                "installState": "installed",
                "enabled": True,
            },
            "status": {"state": "Available"},
        },
        is_active=True,
    )
    personal = _create_personal_installed_skill(
        test_db,
        test_user.id,
        skill=skill,
    )
    test_db.add(legacy_system)
    test_db.commit()
    test_db.refresh(legacy_system)
    service = _build_service(StaticSystemSkillProvider())

    service.uninstall_installed_system_skill(
        db=test_db,
        user_id=test_user.id,
        installed_id=personal.id,
    )

    refreshed_legacy = test_db.get(Kind, legacy_system.id)
    refreshed_personal = test_db.get(Kind, personal.id)
    listed = service.list_installed_system_skills(db=test_db, user_id=test_user.id)
    assert refreshed_personal.is_active is False
    assert refreshed_personal.json["spec"]["installState"] == "uninstalled"
    assert refreshed_legacy.is_active is False
    assert refreshed_legacy.json["spec"]["installState"] == "uninstalled"
    assert listed.items == []

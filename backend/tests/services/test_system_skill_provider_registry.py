# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.system_skills import (
    InstalledSkill,
    InstalledSkillRef,
    InstalledSkillSource,
    InstalledSkillSpec,
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
from app.services.system_skill_providers.providers.base import SystemSkillProviderConfig


def test_system_skill_provider_list_response_serializes_camel_case_fields():
    response = SystemSkillProviderListResponse(
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

    payload = response.model_dump()

    assert payload["providers"][0]["requiresToken"] is False
    assert payload["providers"][0]["hasToken"] is False


def test_system_skill_catalog_response_serializes_contract_fields():
    item = SystemSkillCatalogItem(
        id="@builtin/image-gen",
        providerKey="builtin",
        providerName="Built-in",
        name="image-gen",
        displayName="Image Gen",
        description="Generate or edit images",
        iconUrl=None,
        tags=["image"],
        version="1.0.0",
        author="Wegent",
        category="system",
        capabilities=["generate_image"],
        detailUrl=None,
        installState="installed",
        enabled=False,
        requiresPermission=False,
        permissionUrl=None,
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

    assert payload["items"][0]["providerKey"] == "builtin"
    assert payload["items"][0]["displayName"] == "Image Gen"
    assert payload["items"][0]["installState"] == "installed"
    assert payload["items"][0]["requiresPermission"] is False
    assert payload["providerErrors"][0]["providerKey"] == "remote"
    assert payload["providerErrors"][0]["code"] == "timeout"


def test_installed_skill_crd_keeps_source_ref_spec_and_status():
    crd = InstalledSkill(
        metadata={"name": "builtin-image-gen", "namespace": "default"},
        spec=InstalledSkillSpec(
            source=InstalledSkillSource(
                type="system",
                providerKey="builtin",
                skillKey="image-gen",
                catalogItemId="@builtin/image-gen",
            ),
            skillRef=InstalledSkillRef(
                kind="Skill",
                name="image-gen",
                namespace="system",
                user_id=0,
            ),
            displayName="Image Gen",
            description="Generate or edit images",
            version="1.0.0",
            installState="installed",
            enabled=False,
        ),
    )

    payload = crd.model_dump()

    assert payload["kind"] == "InstalledSkill"
    assert payload["spec"]["source"]["providerKey"] == "builtin"
    assert payload["spec"]["skillRef"]["user_id"] == 0
    assert payload["spec"]["installState"] == "installed"
    assert payload["spec"]["enabled"] is False
    assert payload["status"]["state"] == "Available"


class DummySystemSkillProvider:
    def get_config(self) -> SystemSkillProviderConfig:
        return SystemSkillProviderConfig(
            key="dummy",
            name="Dummy",
            description="Dummy system skills",
            requires_token=False,
            priority=10,
        )


def test_registry_lists_registered_providers_by_priority():
    registry = SystemSkillProviderRegistry()

    registry.register(DummySystemSkillProvider())

    providers = registry.list_all()
    assert [item.key for item in providers] == ["dummy"]
    assert providers[0].name == "Dummy"
    assert registry.get("dummy") is not None
    assert registry.get("missing") is None


def test_default_registry_starts_without_internal_providers():
    providers = system_skill_provider_registry.list_all()

    assert providers == []

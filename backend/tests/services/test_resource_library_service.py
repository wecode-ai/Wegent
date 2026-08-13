# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import base64
import json
import logging
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.orm.attributes import flag_modified

from app.api.endpoints.adapter.shells import list_unified_shells
from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.marketplace_resource import MarketplaceResource
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.bot import BotCreate
from app.schemas.resource_library import (
    ResourceLibraryCreateListingRequest,
    ResourceLibraryPublicationUpdateRequest,
)
from app.services.adapters.bot_kinds import BotKindsService
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.adapters.shell_utils import get_shell_by_name, get_shell_info_by_name
from app.services.adapters.team_kinds import team_kinds_service
from app.services.capability_reference_service import list_referenced_capabilities
from app.services.execution.request_builder import TaskRequestBuilder
from app.services.model_aggregation_service import model_aggregation_service
from app.services.resource_library_service import resource_library_service
from app.services.skill_binding_service import (
    SkillBindingContext,
    skill_binding_service,
)
from app.services.skill_resolution import find_skill_by_ref


def _create_skill(
    test_db,
    *,
    user_id: int,
    name: str,
    namespace: str = "default",
    capability: dict | None = None,
) -> Kind:
    spec = {
        "description": f"{name} description",
        "displayName": name.replace("-", " ").title(),
        "version": "1.0.0",
        "tags": ["test"],
    }
    if capability:
        spec["capability"] = capability
    skill = Kind(
        user_id=user_id,
        kind="Skill",
        name=name,
        namespace=namespace,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {"name": name, "namespace": namespace},
            "spec": spec,
        },
        is_active=True,
    )
    test_db.add(skill)
    test_db.commit()
    test_db.refresh(skill)
    return skill


def _create_user(test_db, name: str) -> User:
    user = User(
        user_name=name,
        password_hash=get_password_hash("testpassword123"),
        email=f"{name}@example.com",
        is_active=True,
        git_info=None,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def test_system_marketplace_listing_uses_current_source_display_fields(
    test_db,
    test_user,
):
    source = _create_skill(
        test_db,
        user_id=0,
        name="system-source-fields",
        capability={
            "displayName": "Old Market Name",
            "description": "Old market description",
            "icon": "/old-market-icon.png",
            "tags": ["technical_development"],
        },
    )
    source.json["spec"]["displayName"] = "Current Skill Name"
    source.json["spec"]["description"] = "Current skill description"
    source.json["spec"]["icon"] = "/current-skill-icon.png"
    flag_modified(source, "json")
    test_db.commit()

    listing = resource_library_service.to_listing(
        test_db,
        source,
        user_id=test_user.id,
    )

    assert listing.display_name == "Current Skill Name"
    assert listing.description == "Current skill description"
    assert listing.icon == "/current-skill-icon.png"
    assert listing.tags == ["technical_development"]


def test_marketplace_listing_ignores_legacy_listing_name(test_db, test_user):
    source = _create_skill(
        test_db,
        user_id=test_user.id,
        name="current-source-name",
        capability={
            "listingName": "legacy-market-name",
            "displayName": "Published Skill",
            "publishStatus": "published",
        },
    )

    listing = resource_library_service.to_listing(
        test_db,
        source,
        user_id=test_user.id,
    )

    assert listing.name == "current-source-name"


def _create_group_with_member(
    test_db,
    user: User,
    role: str = "Developer",
    name: str = "capability-team",
    owner_user_id: int | None = None,
) -> str:
    namespace = Namespace(
        name=name,
        display_name=name.replace("-", " ").title(),
        owner_user_id=owner_user_id if owner_user_id is not None else user.id,
        visibility="private",
        description="",
        level="group",
        is_active=True,
    )
    test_db.add(namespace)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=namespace.id,
            entity_type="user",
            entity_id=str(user.id),
            role=role,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=user.id,
            share_link_id=0,
            reviewed_by_user_id=user.id,
            copied_resource_id=0,
        )
    )
    test_db.commit()
    return namespace.name


def _create_agent(test_db, *, owner_user_id: int = 0) -> Kind:
    shell = Kind(
        user_id=0,
        kind="Shell",
        name="Chat",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Shell",
            "metadata": {"name": "Chat", "namespace": "default"},
            "spec": {"shellType": "Chat", "requiresWorkspace": False},
        },
        is_active=True,
    )
    ghost = Kind(
        user_id=owner_user_id,
        kind="Ghost",
        name="market-ghost",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Ghost",
            "metadata": {"name": "market-ghost", "namespace": "default"},
            "spec": {"systemPrompt": "You are helpful", "mcpServers": {}},
        },
        is_active=True,
    )
    bot = Kind(
        user_id=owner_user_id,
        kind="Bot",
        name="market-bot",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Bot",
            "metadata": {"name": "market-bot", "namespace": "default"},
            "spec": {
                "ghostRef": {"name": "market-ghost", "namespace": "default"},
                "shellRef": {"name": "Chat", "namespace": "default"},
            },
        },
        is_active=True,
    )
    test_db.add_all([shell, ghost, bot])
    test_db.commit()
    team = Kind(
        user_id=owner_user_id,
        kind="Team",
        name="market-agent",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {
                "name": "market-agent",
                "namespace": "default",
                "displayName": "Market Agent",
            },
            "spec": {
                "members": [
                    {
                        "botRef": {"name": "market-bot", "namespace": "default"},
                        "role": "leader",
                        "prompt": "",
                    }
                ],
                "collaborationModel": "solo",
                "bind_mode": ["chat"],
                "description": "Market agent",
                "requiresWorkspace": False,
                "capability": {
                    "visibility": "public",
                    "publishStatus": "published",
                    "version": "1.0.0",
                },
            },
        },
        is_active=True,
    )
    test_db.add(team)
    test_db.commit()
    test_db.refresh(team)
    return team


def _create_published_agent(test_db) -> Kind:
    publisher = _create_user(test_db, "capability-publisher")
    return _create_agent(test_db, owner_user_id=publisher.id)


def test_active_system_team_and_skill_are_listed_without_backfill(test_db, test_user):
    team = Kind(
        user_id=0,
        kind="Team",
        name="system-agent",
        namespace="default",
        json={
            "kind": "Team",
            "metadata": {"name": "system-agent", "displayName": "System Agent"},
            "spec": {
                "members": [],
                "collaborationModel": "solo",
                "bind_mode": ["code"],
            },
        },
        is_active=True,
    )
    skill = _create_skill(test_db, user_id=0, name="system-skill")
    dependency = Kind(
        user_id=0,
        kind="Bot",
        name="hidden-bot",
        namespace="default",
        json={"kind": "Bot", "metadata": {"name": "hidden-bot"}, "spec": {}},
        is_active=True,
    )
    test_db.add_all([team, dependency])
    test_db.commit()

    result = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type=None,
        keyword=None,
        tags=[],
        limit=20,
    )

    assert {item.id for item in result.items} == {team.id, skill.id}
    assert {item.resource_type for item in result.items} == {"agent", "skill"}
    assert next(item for item in result.items if item.id == team.id).bind_modes == [
        "code"
    ]
    assert next(item for item in result.items if item.id == skill.id).bind_modes == []


def test_system_only_discovery_excludes_user_publications(test_db, test_user):
    published_agent = _create_published_agent(test_db)
    publisher = test_db.get(User, published_agent.user_id)
    resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="agent",
            source_id=published_agent.id,
            display_name="Published Agent",
            tags=["technical_development"],
            version="1.0.0",
        ),
        current_user=publisher,
    )
    system_agent = Kind(
        user_id=0,
        kind="Team",
        name="system-only-agent",
        namespace="default",
        json={
            "kind": "Team",
            "metadata": {
                "name": "system-only-agent",
                "displayName": "System Only Agent",
            },
            "spec": {"members": [], "collaborationModel": "solo"},
        },
        is_active=True,
    )
    test_db.add(system_agent)
    test_db.commit()
    test_db.refresh(system_agent)

    result = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="agent",
        keyword=None,
        tags=[],
        limit=20,
        system_only=True,
    )

    assert [item.id for item in result.items] == [system_agent.id]


def test_agent_publisher_manages_example_conversation(test_db):
    agent = _create_published_agent(test_db)
    publisher = test_db.get(User, agent.user_id)

    published = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="agent",
            source_id=agent.id,
            display_name="Published Agent",
            tags=["technical_development"],
            version="1.0.0",
            example_conversations=[
                {
                    "title": "First example",
                    "url": "https://example.com/shared/first",
                },
                {
                    "title": "Second example",
                    "url": "https://example.com/shared/second",
                },
            ],
        ),
        current_user=publisher,
    )
    updated = resource_library_service.update_publication(
        test_db,
        listing_id=agent.id,
        request=ResourceLibraryPublicationUpdateRequest(
            example_conversations=[
                {
                    "title": "Updated example",
                    "url": "https://example.com/shared/updated",
                }
            ]
        ),
        current_user=publisher,
    )

    assert [item.title for item in published.example_conversations] == [
        "First example",
        "Second example",
    ]
    assert [item.title for item in updated.example_conversations] == ["Updated example"]
    assert test_db.get(Kind, agent.id).json["spec"]["capability"]["marketplace"][
        "exampleConversations"
    ] == [
        {
            "title": "Updated example",
            "url": "https://example.com/shared/updated",
        }
    ]


def test_featured_discovery_uses_admin_selection(test_db, test_user):
    featured_agent = Kind(
        user_id=0,
        kind="Team",
        name="featured-filter-agent-included",
        namespace="default",
        json={
            "kind": "Team",
            "metadata": {"name": "featured-filter-agent-included"},
            "spec": {
                "members": [],
                "collaborationModel": "solo",
                "capability": {"marketplace": {"recommendationScore": 90}},
            },
        },
        is_active=True,
    )
    excluded_agent = Kind(
        user_id=0,
        kind="Team",
        name="featured-filter-agent-excluded",
        namespace="default",
        json={
            "kind": "Team",
            "metadata": {"name": "featured-filter-agent-excluded"},
            "spec": {
                "members": [],
                "collaborationModel": "solo",
                "capability": {"marketplace": {"recommendationScore": 0}},
            },
        },
        is_active=True,
    )
    test_db.add_all([featured_agent, excluded_agent])
    test_db.commit()

    result = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="agent",
        keyword="featured-filter-agent",
        tags=[],
        limit=20,
        featured_only=True,
    )

    assert [item.id for item in result.items] == [featured_agent.id]


def test_discovery_hides_installed_skill_only_without_search_filters(
    test_db, test_user
):
    skill = _create_skill(
        test_db,
        user_id=0,
        name="installed-data-skill",
        capability={
            "visibility": "public",
            "publishStatus": "published",
            "tags": ["technical_development"],
        },
    )
    skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        created_by=test_user.id,
    )

    default_result = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword=None,
        tags=[],
        limit=20,
    )
    tag_result = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword=None,
        tags=["technical_development"],
        limit=20,
    )
    keyword_result = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword="installed-data",
        tags=[],
        limit=20,
    )

    assert skill.id not in {item.id for item in default_result.items}
    assert [item.id for item in tag_result.items] == [skill.id]
    assert tag_result.items[0].is_installed is True
    assert [item.id for item in keyword_result.items] == [skill.id]
    assert keyword_result.items[0].is_installed is True


def test_discovery_cursor_continues_after_last_resource(test_db, test_user):
    older = _create_skill(
        test_db,
        user_id=0,
        name="older-skill",
    )
    newer = _create_skill(
        test_db,
        user_id=0,
        name="newer-skill",
    )
    older.updated_at = datetime(2026, 1, 1)
    newer.updated_at = datetime(2026, 1, 2)
    test_db.commit()

    first_page = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword=None,
        tags=[],
        limit=1,
    )
    second_page = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword=None,
        tags=[],
        cursor=first_page.next_cursor,
        limit=1,
    )

    assert first_page.has_more is True
    assert first_page.next_cursor
    assert [item.id for item in first_page.items] == [newer.id]
    assert second_page.has_more is False
    assert second_page.next_cursor is None
    assert [item.id for item in second_page.items] == [older.id]


def test_discovery_accepts_legacy_cursor(test_db, test_user):
    older = _create_skill(
        test_db,
        user_id=0,
        name="legacy-cursor-older-skill",
    )
    newer = _create_skill(
        test_db,
        user_id=0,
        name="legacy-cursor-newer-skill",
    )
    older.updated_at = datetime(2026, 1, 1)
    newer.updated_at = datetime(2026, 1, 2)
    test_db.commit()

    legacy_cursor = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "updated_at": newer.updated_at.isoformat(),
                    "kind_id": newer.id,
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    result = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword="legacy-cursor",
        tags=[],
        cursor=legacy_cursor,
        limit=1,
    )

    assert [item.id for item in result.items] == [older.id]
    assert result.next_cursor is None


def test_discovery_cursor_merges_system_and_published_resources(test_db, test_user):
    system_skill = _create_skill(
        test_db,
        user_id=0,
        name="mixed-system-skill",
    )
    published_skill = _create_skill(
        test_db,
        user_id=test_user.id,
        name="mixed-published-skill",
        capability={
            "visibility": "public",
            "publishStatus": "published",
            "tags": ["technical_development"],
        },
    )
    system_skill.updated_at = datetime(2026, 1, 1)
    test_db.add(
        MarketplaceResource(
            kind_id=published_skill.id,
            owner_user_id=test_user.id,
            resource_type="skill",
            recommendation_score=90,
            updated_at=datetime(2026, 1, 2),
        )
    )
    test_db.commit()

    first_page = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword="mixed-",
        tags=[],
        limit=1,
    )
    second_page = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword="mixed-",
        tags=[],
        cursor=first_page.next_cursor,
        limit=1,
    )

    assert [item.id for item in first_page.items] == [published_skill.id]
    assert first_page.has_more is True
    assert [item.id for item in second_page.items] == [system_skill.id]
    assert second_page.has_more is False


def test_discovery_filters_hidden_system_skills_without_breaking_pagination(
    test_db, test_user
):
    older = _create_skill(test_db, user_id=0, name="older-visible-skill")
    newer = _create_skill(test_db, user_id=0, name="newer-visible-skill")
    hidden = _create_skill(test_db, user_id=0, name="newest-hidden-skill")
    hidden.json["spec"]["visible"] = False
    flag_modified(hidden, "json")
    older.updated_at = datetime(2026, 1, 1)
    newer.updated_at = datetime(2026, 1, 2)
    hidden.updated_at = datetime(2026, 1, 3)
    test_db.commit()

    first_page = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword=None,
        tags=[],
        limit=1,
    )
    second_page = resource_library_service.list_public(
        test_db,
        user_id=test_user.id,
        resource_type="skill",
        keyword=None,
        tags=[],
        cursor=first_page.next_cursor,
        limit=1,
    )

    assert [item.id for item in first_page.items] == [newer.id]
    assert first_page.has_more is True
    assert [item.id for item in second_page.items] == [older.id]
    assert second_page.has_more is False


@pytest.mark.parametrize("target_namespace", ["default", "capability-team"])
def test_system_agent_cannot_be_installed(test_db, test_user, target_namespace: str):
    source = _create_agent(test_db)
    if target_namespace != "default":
        target_namespace = _create_group_with_member(test_db, test_user)

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.install(
            test_db,
            listing_id=source.id,
            target_namespace=target_namespace,
            current_user=test_user,
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == (
        "System agents are globally available and cannot be installed"
    )


@pytest.mark.parametrize("kind", ["Model", "Shell", "Retriever"])
@pytest.mark.parametrize("target_namespace", ["default", "capability-team"])
def test_system_capability_is_directly_available_and_cannot_be_installed(
    test_db, test_user, kind: str, target_namespace: str
):
    name = f"system-{kind.lower()}"
    source = Kind(
        user_id=0,
        kind=kind,
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": "default"},
            "spec": {},
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.commit()
    test_db.refresh(source)
    if target_namespace != "default":
        target_namespace = _create_group_with_member(test_db, test_user)

    listing = resource_library_service.to_listing(test_db, source, user_id=test_user.id)
    assert listing.is_installed is True

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.install(
            test_db,
            listing_id=source.id,
            target_namespace=target_namespace,
            current_user=test_user,
        )

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == (
        "System capabilities are globally available and cannot be installed"
    )


def test_stale_system_capability_reference_is_ignored(test_db, test_user):
    source = Kind(
        user_id=0,
        kind="Model",
        name="system-model-with-stale-reference",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": "system-model-with-stale-reference",
                "namespace": "default",
            },
            "spec": {},
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.flush()
    test_db.add(
        ResourceMember.create(
            resource_type="Model",
            resource_id=source.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role=BaseRole.Reporter.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=test_user.id,
        )
    )
    test_db.commit()

    assert (
        list_referenced_capabilities(
            test_db,
            kind="Model",
            user_id=test_user.id,
            namespace="default",
        )
        == []
    )


def test_editing_system_publication_materializes_complete_metadata(
    test_db, test_admin_user
):
    skill = _create_skill(test_db, user_id=0, name="system-rule-skill")

    updated = resource_library_service.update_publication(
        test_db,
        listing_id=skill.id,
        request=ResourceLibraryPublicationUpdateRequest(allow_group_install=False),
        current_user=test_admin_user,
    )

    assert updated.status == "published"
    assert updated.allow_group_install is False
    assert (
        resource_library_service.get_public_listing(
            test_db, listing_id=skill.id, user_id=test_admin_user.id
        ).id
        == skill.id
    )


def test_private_skill_sharing_scope_can_be_read_and_updated(test_db, test_user):
    skill = _create_skill(test_db, user_id=test_user.id, name="private-scope-skill")
    group_name = _create_group_with_member(test_db, test_user)

    initial = resource_library_service.get_manageable_publication(
        test_db,
        listing_id=skill.id,
        current_user=test_user,
    )
    assert initial.status == "archived"
    assert initial.target_groups == []

    updated = resource_library_service.update_publication(
        test_db,
        listing_id=skill.id,
        request=ResourceLibraryPublicationUpdateRequest(
            status="archived",
            target_groups=[group_name],
            allow_personal_install=False,
            allow_group_install=True,
        ),
        current_user=test_user,
    )

    assert updated.status == "archived"
    assert updated.target_groups == [group_name]
    assert updated.allow_personal_install is False
    assert updated.allow_group_install is True
    assert (
        len(
            skill_binding_service.list_group_bindings(test_db, group_name, test_user.id)
        )
        == 1
    )


def test_private_skill_sharing_scope_rejects_non_owner(test_db, test_user):
    owner = _create_user(test_db, "private-scope-owner")
    skill = _create_skill(test_db, user_id=owner.id, name="owner-only-skill")

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.get_manageable_publication(
            test_db,
            listing_id=skill.id,
            current_user=test_user,
        )

    assert exc_info.value.status_code == 403


def test_list_published_only_returns_current_user_publications(
    test_db, test_user, test_admin_user, caplog
):
    user_skill = _create_skill(
        test_db, user_id=test_user.id, name="user-published-skill"
    )
    admin_skill = _create_skill(
        test_db, user_id=test_admin_user.id, name="admin-published-skill"
    )

    user_listing = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="skill",
            source_id=user_skill.id,
            display_name="User Published Skill",
            tags=["technical_development"],
        ),
        current_user=test_user,
    )
    admin_listing = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="skill",
            source_id=admin_skill.id,
            display_name="Admin Published Skill",
            tags=["technical_development"],
        ),
        current_user=test_admin_user,
    )

    with caplog.at_level(
        logging.INFO,
        logger="app.services.resource_library_service",
    ):
        user_result = resource_library_service.list_published(
            test_db,
            current_user=test_user,
            resource_type="skill",
            page=1,
            limit=20,
        )
    admin_result = resource_library_service.list_published(
        test_db,
        current_user=test_admin_user,
        resource_type="skill",
        page=1,
        limit=20,
    )

    assert [item.id for item in user_result.items] == [user_listing.id]
    assert [item.id for item in admin_result.items] == [admin_listing.id]
    assert user_listing.publisher_user_id == test_user.id
    assert admin_listing.publisher_user_id == test_admin_user.id
    assert user_listing.publisher_user_name == test_user.user_name
    assert admin_listing.publisher_user_name == test_admin_user.user_name
    assert (
        test_db.get(MarketplaceResource, user_listing.id).owner_user_id == test_user.id
    )
    assert (
        test_db.get(MarketplaceResource, admin_listing.id).owner_user_id
        == test_admin_user.id
    )
    assert "[resource_library_timing] my_published" in caplog.text
    assert "total=1" in caplog.text
    assert "index_rows=1" in caplog.text
    assert "kind_rows=1" in caplog.text
    assert "count_ms=" in caplog.text
    assert "index_page_ms=" in caplog.text
    assert "kind_batch_ms=" in caplog.text
    assert "serialize_ms=" in caplog.text


def test_update_skill_publication_distributes_to_selected_groups(test_db, test_user):
    source = _create_skill(
        test_db, user_id=test_user.id, name="team-targeted-published-skill"
    )
    group_name = _create_group_with_member(test_db, test_user)
    resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="skill",
            source_id=source.id,
            display_name="Team Targeted Published Skill",
            tags=["technical_development"],
        ),
        current_user=test_user,
    )

    updated = resource_library_service.update_publication(
        test_db,
        listing_id=source.id,
        request=ResourceLibraryPublicationUpdateRequest(
            allow_group_install=True,
            target_groups=[group_name, group_name, " "],
        ),
        current_user=test_user,
    )

    assert updated.target_groups == [group_name]
    bindings = skill_binding_service.list_group_bindings(
        test_db, group_name, test_user.id
    )
    assert len(bindings) == 1
    assert bindings[0].json["spec"]["skillRef"]["skillId"] == source.id

    removed_from_scope = resource_library_service.update_publication(
        test_db,
        listing_id=source.id,
        request=ResourceLibraryPublicationUpdateRequest(target_groups=[]),
        current_user=test_user,
    )

    assert removed_from_scope.target_groups == []
    assert (
        len(
            skill_binding_service.list_group_bindings(test_db, group_name, test_user.id)
        )
        == 0
    )


def test_group_install_list_skips_binding_with_inactive_skill(test_db, test_user):
    source = _create_skill(
        test_db,
        user_id=test_user.id,
        name="removed-group-skill",
    )
    group_name = _create_group_with_member(test_db, test_user)
    skill_binding_service.add_group_skill(
        test_db,
        group_namespace=group_name,
        skill_id=source.id,
        created_by=test_user.id,
    )
    source.is_active = False
    test_db.commit()

    installs = resource_library_service.list_group_installs(
        test_db,
        group_namespace=group_name,
        current_user=test_user,
        resource_type="skill",
        page=1,
        limit=20,
    )

    assert installs.items == []
    assert installs.total == 0


def test_group_install_list_returns_empty_for_inaccessible_group(test_db, test_user):
    group_owner = _create_user(test_db, "inaccessible-group-owner")
    group_name = _create_group_with_member(test_db, group_owner)

    installs = resource_library_service.list_group_installs(
        test_db,
        group_namespace=group_name,
        current_user=test_user,
        resource_type="skill",
        page=2,
        limit=20,
    )

    assert installs.items == []
    assert installs.total == 0
    assert installs.page == 2
    assert installs.limit == 20


def test_group_install_batch_combines_accessible_groups(test_db, test_user):
    first_group = _create_group_with_member(test_db, test_user, name="batch-group-one")
    second_group = _create_group_with_member(test_db, test_user, name="batch-group-two")
    inaccessible_owner = _create_user(test_db, "batch-inaccessible-owner")
    inaccessible_group = _create_group_with_member(
        test_db,
        inaccessible_owner,
        name="batch-inaccessible-group",
    )
    first_skill = _create_skill(
        test_db,
        user_id=test_user.id,
        name="batch-skill-one",
        namespace=first_group,
    )
    second_skill = _create_skill(
        test_db,
        user_id=test_user.id,
        name="batch-skill-two",
        namespace=second_group,
    )
    _create_skill(
        test_db,
        user_id=inaccessible_owner.id,
        name="batch-hidden-skill",
        namespace=inaccessible_group,
    )

    installs = resource_library_service.list_group_installs_batch(
        test_db,
        group_namespaces=[first_group, second_group, inaccessible_group, first_group],
        current_user=test_user,
        resource_type="skill",
        page=1,
        limit=20,
    )

    assert {item.listing_id for item in installs.items} == {
        first_skill.id,
        second_skill.id,
    }
    assert installs.total == 2


def test_group_install_batch_includes_group_owned_agent(test_db, test_user):
    group_name = _create_group_with_member(
        test_db,
        test_user,
        name="batch-agent-group",
    )
    agent = _create_agent(test_db, owner_user_id=test_user.id)
    agent.namespace = group_name
    agent.json["metadata"]["namespace"] = group_name
    flag_modified(agent, "json")
    test_db.commit()

    installs = resource_library_service.list_group_installs_batch(
        test_db,
        group_namespaces=[group_name],
        current_user=test_user,
        resource_type="agent",
        page=1,
        limit=20,
    )

    assert [item.listing_id for item in installs.items] == [agent.id]
    assert installs.items[0].installed_reference == {
        "namespace": group_name,
        "name": agent.name,
        "kind": "Team",
        "team_id": agent.id,
        "resource_type": "agent",
        "ownership": "group",
    }


def test_group_install_list_includes_group_owned_skill(test_db, test_user):
    group_name = _create_group_with_member(test_db, test_user)
    source = _create_skill(
        test_db,
        user_id=test_user.id,
        name="legacy-group-skill",
        namespace=group_name,
    )

    installs = resource_library_service.list_group_installs(
        test_db,
        group_namespace=group_name,
        current_user=test_user,
        resource_type="skill",
        page=1,
        limit=20,
    )

    assert [item.listing_id for item in installs.items] == [source.id]
    assert installs.items[0].installed_reference["kind"] == "Skill"
    assert installs.items[0].installed_reference["ownership"] == "group"


def test_missing_publication_index_does_not_scan_install_bindings(test_db, test_user):
    source = _create_skill(
        test_db,
        user_id=test_user.id,
        name="unindexed-skill",
    )
    skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=source.id,
        created_by=test_user.id,
    )

    assert resource_library_service._listing_install_count(test_db, source) == 0


def test_archiving_published_skill_revokes_existing_install_access(test_db, test_user):
    source = _create_skill(test_db, user_id=test_user.id, name="published-skill")
    consumer = _create_user(test_db, "capability-consumer")
    request = ResourceLibraryCreateListingRequest(
        resource_type="skill",
        source_id=source.id,
        display_name="Published Skill",
        description="Published description",
        tags=["technical_development"],
        version="1.1.0",
    )

    listing = resource_library_service.publish(
        test_db, request=request, current_user=test_user
    )
    assert test_db.get(MarketplaceResource, source.id) is not None
    first_install = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=consumer,
    )
    second_install = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=consumer,
    )

    assert listing.current_version.version == "1.1.0"
    assert listing.tags == ["technical_development"]
    assert listing.feature_tags == ["test"]
    assert "listingName" not in source.json["spec"]["capability"]
    assert first_install.id == second_install.id
    assert first_install.installed_reference["skill_id"] == source.id
    publication = test_db.get(MarketplaceResource, source.id)
    assert publication is not None
    assert publication.install_count == 1

    resource_library_service.update_publication(
        test_db,
        listing_id=source.id,
        request=ResourceLibraryPublicationUpdateRequest(status="archived"),
        current_user=test_user,
    )
    assert test_db.get(MarketplaceResource, source.id) is None
    refs = skill_binding_service.list_user_default_skill_refs(test_db, consumer.id)
    assert refs == []
    assert (
        find_skill_by_ref(
            test_db,
            skill_name=source.name,
            namespace=source.namespace,
            is_public=True,
            user_id=consumer.id,
            skill_id=source.id,
        )
        is None
    )

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.install(
            test_db,
            listing_id=source.id,
            target_namespace="default",
            current_user=_create_user(test_db, "late-consumer"),
        )
    assert exc_info.value.status_code == 404


def test_published_model_install_is_a_live_reference(test_db, test_user, monkeypatch):
    source = Kind(
        user_id=test_user.id,
        kind="Model",
        name="shared-model",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {
                "name": "shared-model",
                "namespace": "default",
                "displayName": "Shared Model",
            },
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "model_id": "gpt-test",
                        "api_key": "publisher-secret",
                    }
                }
            },
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.commit()
    consumer = _create_user(test_db, "model-consumer")

    listing = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="model",
            source_name=source.name,
            source_namespace=source.namespace,
            display_name="Shared Model",
            version="1.0.0",
        ),
        current_user=test_user,
    )
    install = resource_library_service.install(
        test_db,
        listing_id=listing.id,
        target_namespace="default",
        current_user=consumer,
    )

    reference = test_db.get(ResourceMember, install.id)
    assert reference is not None
    assert reference.resource_type == "Model"
    assert reference.resource_id == source.id
    assert install.installed_kind_id == source.id
    assert (
        test_db.query(Kind)
        .filter(
            Kind.user_id == consumer.id,
            Kind.kind == "Model",
            Kind.name == source.name,
        )
        .count()
        == 0
    )
    assert resource_library_service.to_listing(
        test_db, source, user_id=consumer.id
    ).is_installed
    source.json["spec"]["modelConfig"]["env"]["model_id"] = "gpt-updated"
    flag_modified(source, "json")
    test_db.commit()

    monkeypatch.setattr(
        "app.services.model_aggregation_service.kind_service.list_resources",
        lambda user_id, kind, namespace: [],
    )
    models = model_aggregation_service.list_available_models(
        test_db,
        consumer,
        scope="personal",
    )
    referenced_model = next(item for item in models if item["name"] == source.name)
    assert referenced_model["modelId"] == "gpt-updated"
    assert referenced_model["isReference"] is True
    assert referenced_model["listingId"] == source.id


def test_model_publish_request_sets_personal_team_and_marketplace_scope(
    test_db, test_user
):
    source = Kind(
        user_id=test_user.id,
        kind="Model",
        name="scoped-model",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Model",
            "metadata": {"name": "scoped-model", "namespace": "default"},
            "spec": {
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "model_id": "gpt-test",
                        "api_key": "publisher-secret",
                    }
                }
            },
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.commit()
    test_db.refresh(source)
    group_name = _create_group_with_member(test_db, test_user)

    team_scope = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="model",
            source_name=source.name,
            source_namespace=source.namespace,
            display_name="Scoped Model",
            status="archived",
            target_groups=[group_name],
            allow_personal_install=False,
            allow_group_install=True,
        ),
        current_user=test_user,
    )

    assert team_scope.status == "archived"
    assert team_scope.target_groups == [group_name]
    assert test_db.get(MarketplaceResource, source.id) is None
    assert (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Model",
            ResourceMember.resource_id == source.id,
        )
        .count()
        == 1
    )
    loaded = resource_library_service.get_manageable_publication_by_source(
        test_db,
        resource_type="model",
        source_name=source.name,
        source_namespace=source.namespace,
        current_user=test_user,
    )
    assert loaded.target_groups == [group_name]

    personal_scope = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="model",
            source_name=source.name,
            source_namespace=source.namespace,
            display_name="Scoped Model",
            status="archived",
            target_groups=[],
            allow_personal_install=False,
            allow_group_install=False,
        ),
        current_user=test_user,
    )
    assert personal_scope.status == "archived"
    assert personal_scope.target_groups == []
    assert (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Model",
            ResourceMember.resource_id == source.id,
        )
        .count()
        == 0
    )

    marketplace_scope = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="model",
            source_name=source.name,
            source_namespace=source.namespace,
            display_name="Scoped Model",
            status="published",
            allow_personal_install=True,
            allow_group_install=True,
        ),
        current_user=test_user,
    )
    assert marketplace_scope.status == "published"
    assert test_db.get(MarketplaceResource, source.id) is not None


@pytest.mark.parametrize(
    ("resource_type", "kind", "name", "spec"),
    [
        (
            "shell",
            "Shell",
            "shared-shell",
            {"shellType": "ClaudeCode", "baseImage": "shell:v1"},
        ),
        (
            "retriever",
            "Retriever",
            "shared-retriever",
            {
                "storageConfig": {
                    "type": "elasticsearch",
                    "url": "http://search-v1",
                    "indexStrategy": {"mode": "per_user"},
                }
            },
        ),
    ],
)
def test_foundation_resource_references_follow_source_updates(
    test_db,
    test_user,
    resource_type,
    kind,
    name,
    spec,
):
    source = Kind(
        user_id=test_user.id,
        kind=kind,
        name=name,
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": kind,
            "metadata": {"name": name, "namespace": "default"},
            "spec": spec,
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.commit()
    consumer = _create_user(test_db, f"{resource_type}-consumer")
    listing = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type=resource_type,
            source_name=name,
            display_name=name,
            version="1.0.0",
        ),
        current_user=test_user,
    )
    install = resource_library_service.install(
        test_db,
        listing_id=listing.id,
        target_namespace="default",
        current_user=consumer,
    )

    if kind == "Shell":
        source.json["spec"]["baseImage"] = "shell:v2"
    else:
        source.json["spec"]["storageConfig"]["url"] = "http://search-v2"
    flag_modified(source, "json")
    test_db.commit()

    if kind == "Shell":
        resolved = get_shell_by_name(test_db, name, consumer.id)
        assert resolved is source
        assert resolved.json["spec"]["baseImage"] == "shell:v2"
        shell_info = get_shell_info_by_name(test_db, name, consumer.id)
        assert shell_info["shell_type"] == "ClaudeCode"
        assert shell_info["base_image"] == "shell:v2"
        assert shell_info["is_reference"] is True
        unified = list_unified_shells(
            scope="personal",
            group_name=None,
            db=test_db,
            current_user=consumer,
        )
        referenced = next(item for item in unified["data"] if item["name"] == name)
        assert referenced["isReference"] is True
        assert referenced["listingId"] == source.id
        bot = Kind(
            user_id=consumer.id,
            kind="Bot",
            name="reference-shell-bot",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Bot",
                "metadata": {
                    "name": "reference-shell-bot",
                    "namespace": "default",
                },
                "spec": {
                    "ghostRef": {"name": "unused", "namespace": "default"},
                    "shellRef": {"name": name, "namespace": "default"},
                },
            },
            is_active=True,
        )
        runtime_shell_info = TaskRequestBuilder(test_db)._resolve_shell_info(
            bot,
            consumer.id,
        )
        assert runtime_shell_info == {
            "shell_type": "ClaudeCode",
            "base_image": "shell:v2",
        }
        public_model = Kind(
            user_id=0,
            kind="Model",
            name="reference-shell-test-model",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "Model",
                "metadata": {
                    "name": "reference-shell-test-model",
                    "namespace": "default",
                },
                "spec": {
                    "modelConfig": {
                        "env": {
                            "model": "openai",
                            "model_id": "reference-shell-test-model",
                        }
                    }
                },
            },
            is_active=True,
        )
        test_db.add(public_model)
        test_db.commit()
        created_bot = BotKindsService(Kind).create_with_user(
            test_db,
            obj_in=BotCreate(
                name="bot-using-referenced-shell",
                shell_name=name,
                agent_config={
                    "bind_model": public_model.name,
                    "bind_model_type": "public",
                },
            ),
            user_id=consumer.id,
        )
        assert created_bot["shell_name"] == name
        assert created_bot["shell_type"] == "ClaudeCode"

        with pytest.raises(HTTPException) as exc_info:
            resource_library_service.uninstall_kind_reference(
                test_db,
                listing_id=source.id,
                target_namespace="default",
                current_user=consumer,
            )
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["code"] == "CAPABILITY_REFERENCE_IN_USE"
        assert exc_info.value.detail["referenced_bots"] == [
            {
                "id": created_bot["id"],
                "name": "bot-using-referenced-shell",
                "namespace": "default",
            }
        ]
        created_bot_kind = test_db.get(Kind, created_bot["id"])
        created_bot_kind.is_active = False
        test_db.commit()
    else:
        resolved = retriever_kinds_service.get_retriever(
            test_db,
            user_id=consumer.id,
            name=name,
            namespace="default",
        )
        assert resolved.spec.storageConfig.url == "http://search-v2"
        referenced = next(
            item
            for item in retriever_kinds_service.list_retrievers(
                test_db,
                user_id=consumer.id,
                scope="personal",
            )
            if item["name"] == name
        )
        assert referenced["isReference"] is True
        assert referenced["listingId"] == source.id
        knowledge_base = Kind(
            user_id=consumer.id,
            kind="KnowledgeBase",
            name="kb-using-referenced-retriever",
            namespace="default",
            json={
                "apiVersion": "agent.wecode.io/v1",
                "kind": "KnowledgeBase",
                "metadata": {
                    "name": "kb-using-referenced-retriever",
                    "namespace": "default",
                },
                "spec": {
                    "name": "Knowledge Base Using Referenced Retriever",
                    "retrievalConfig": {
                        "retriever_name": name,
                        "retriever_namespace": "default",
                    },
                },
            },
            is_active=True,
        )
        test_db.add(knowledge_base)
        test_db.commit()
        test_db.refresh(knowledge_base)

        usage = resource_library_service.get_kind_reference_usage(
            test_db,
            listing_id=source.id,
            target_namespace="default",
            current_user=consumer,
        )
        assert [item.model_dump() for item in usage.referenced_knowledge_bases] == [
            {
                "id": knowledge_base.id,
                "name": "Knowledge Base Using Referenced Retriever",
                "namespace": "default",
            }
        ]

        with pytest.raises(HTTPException) as exc_info:
            resource_library_service.uninstall_kind_reference(
                test_db,
                listing_id=source.id,
                target_namespace="default",
                current_user=consumer,
            )
        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["code"] == "CAPABILITY_REFERENCE_IN_USE"
        assert exc_info.value.detail["referenced_knowledge_bases"] == [
            {
                "id": knowledge_base.id,
                "name": "Knowledge Base Using Referenced Retriever",
                "namespace": "default",
            }
        ]
        knowledge_base.is_active = False
        test_db.commit()

    resource_library_service.uninstall_kind_reference(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=consumer,
    )
    assert test_db.get(ResourceMember, install.id) is None
    assert test_db.get(MarketplaceResource, source.id).install_count == 1


def test_leaving_group_revokes_user_default_private_skill_access(
    test_db,
    test_user,
    test_admin_user,
):
    group_name = _create_group_with_member(
        test_db,
        test_user,
        role="Reporter",
        name="private-skill-team",
        owner_user_id=test_admin_user.id,
    )
    skill = _create_skill(
        test_db,
        user_id=test_admin_user.id,
        name="private-group-skill",
        namespace=group_name,
    )
    binding = skill_binding_service.add_user_default_skill(
        test_db,
        user_id=test_user.id,
        skill_id=skill.id,
        created_by=test_user.id,
    )

    assert skill_binding_service.list_user_default_skill_ids(test_db, test_user.id) == {
        skill.id
    }

    namespace = test_db.query(Namespace).filter(Namespace.name == group_name).one()
    membership = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Namespace",
            ResourceMember.resource_id == namespace.id,
            ResourceMember.entity_id == str(test_user.id),
            ResourceMember.status == MemberStatus.APPROVED.value,
        )
        .one()
    )
    test_db.delete(membership)
    test_db.commit()

    test_db.refresh(binding)
    assert binding.is_active is True
    assert skill_binding_service.list_user_default_bindings(test_db, test_user.id) == []
    assert (
        skill_binding_service.list_user_default_skill_refs(test_db, test_user.id) == []
    )
    assert (
        find_skill_by_ref(
            test_db,
            skill_name=skill.name,
            namespace=skill.namespace,
            is_public=False,
            user_id=test_user.id,
            skill_id=skill.id,
        )
        is None
    )


def test_group_skill_binding_is_available_to_group_runtime(test_db, test_user):
    publisher = _create_user(test_db, "group-skill-publisher")
    source = _create_skill(
        test_db,
        user_id=publisher.id,
        name="group-market-skill",
        capability={
            "visibility": "public",
            "publishStatus": "published",
            "publishedBy": publisher.id,
        },
    )
    group_name = _create_group_with_member(test_db, test_user)

    install = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace=group_name,
        current_user=test_user,
    )
    refs = skill_binding_service.list_user_default_skill_refs(
        test_db,
        test_user.id,
        context=SkillBindingContext(group_namespace=group_name),
    )
    group_installs = resource_library_service.list_group_installs(
        test_db,
        group_namespace=group_name,
        current_user=test_user,
        resource_type="skill",
        page=1,
        limit=20,
    )

    assert install.installed_reference["namespace"] == group_name
    assert [ref["skill_id"] for ref in refs] == [source.id]
    assert [item.id for item in group_installs.items] == [install.id]

    bot_service = BotKindsService(Kind)
    bot_service._validate_skills(
        test_db,
        [source.name],
        test_user.id,
        group_name,
    )
    bot_refs = bot_service._get_skill_refs(
        test_db,
        [source.name],
        test_user.id,
        group_name,
    )
    assert bot_refs[source.name].skill_id == source.id
    assert (
        find_skill_by_ref(
            test_db,
            skill_name=source.name,
            namespace=source.namespace,
            is_public=False,
            user_id=test_user.id,
            team_namespace=group_name,
            skill_id=source.id,
        )
        == source
    )


def test_reporter_cannot_add_skill_to_group(test_db, test_user):
    source = _create_skill(test_db, user_id=0, name="restricted-group-skill")
    group_name = _create_group_with_member(test_db, test_user, role="Reporter")

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.install(
            test_db,
            listing_id=source.id,
            target_namespace=group_name,
            current_user=test_user,
        )

    assert exc_info.value.status_code == 403


def test_developer_cannot_publish_group_capability(test_db, test_user):
    group_name = _create_group_with_member(test_db, test_user, role="Developer")
    source = Kind(
        user_id=test_user.id,
        kind="Skill",
        name="developer-owned-group-skill",
        namespace=group_name,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Skill",
            "metadata": {
                "name": "developer-owned-group-skill",
                "namespace": group_name,
            },
            "spec": {"version": "1.0.0"},
        },
        is_active=True,
    )
    test_db.add(source)
    test_db.commit()

    with pytest.raises(HTTPException) as exc_info:
        resource_library_service.publish(
            test_db,
            request=ResourceLibraryCreateListingRequest(
                resource_type="skill",
                source_id=source.id,
                display_name="Developer Group Skill",
            ),
            current_user=test_user,
        )

    assert exc_info.value.status_code == 403


def test_group_agent_install_is_idempotent_and_stays_in_group(test_db, test_user):
    source = _create_published_agent(test_db)
    group_name = _create_group_with_member(test_db, test_user)

    first = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace=group_name,
        current_user=test_user,
    )
    second = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace=group_name,
        current_user=test_user,
    )
    group_installs = resource_library_service.list_group_installs(
        test_db,
        group_namespace=group_name,
        current_user=test_user,
        resource_type="agent",
        page=1,
        limit=20,
    )

    assert second.id == first.id
    assert first.installed_reference["namespace"] == group_name
    assert [item.id for item in group_installs.items] == [first.id]
    assert [
        team["id"]
        for team in team_kinds_service.get_user_teams(
            test_db,
            user_id=test_user.id,
            scope="group",
            group_name=group_name,
        )
    ] == [source.id]
    assert (
        resource_library_service.list_installs(
            test_db,
            current_user=test_user,
            resource_type="agent",
            page=1,
            limit=20,
        ).items
        == []
    )


def test_agent_publication_targets_multiple_groups_by_reference(test_db, test_user):
    source = _create_agent(test_db, owner_user_id=test_user.id)
    first_group = _create_group_with_member(test_db, test_user, name="agent-target-one")
    second_group = _create_group_with_member(
        test_db, test_user, name="agent-target-two"
    )
    team_count_before = test_db.query(Kind).filter(Kind.kind == "Team").count()

    updated = resource_library_service.update_publication(
        test_db,
        listing_id=source.id,
        request=ResourceLibraryPublicationUpdateRequest(
            target_groups=[first_group, second_group]
        ),
        current_user=test_user,
    )

    assert updated.target_groups == [first_group, second_group]
    assert test_db.query(Kind).filter(Kind.kind == "Team").count() == team_count_before
    for group_name in (first_group, second_group):
        group_installs = resource_library_service.list_group_installs(
            test_db,
            group_namespace=group_name,
            current_user=test_user,
            resource_type="agent",
            page=1,
            limit=20,
        )
        assert len(group_installs.items) == 1
        assert group_installs.items[0].installed_reference["team_id"] == source.id
        assert group_installs.items[0].installed_reference["namespace"] == group_name


def test_agent_bindings_merge_intrinsic_group_and_replace_extra_groups(
    test_db, test_user
):
    source_group = _create_group_with_member(
        test_db,
        test_user,
        role="Maintainer",
        name="agent-source-group",
    )
    extra_group = _create_group_with_member(
        test_db,
        test_user,
        role="Developer",
        name="agent-extra-group",
    )
    source = _create_agent(test_db, owner_user_id=test_user.id)
    source.namespace = source_group
    source.json["metadata"]["namespace"] = source_group
    flag_modified(source, "json")
    test_db.add(
        Kind(
            user_id=test_user.id,
            kind="CapabilityInstallation",
            name="legacy-agent-binding",
            namespace=extra_group,
            json={
                "kind": "CapabilityInstallation",
                "spec": {"sourceRef": {"kindId": source.id}},
            },
            is_active=True,
        )
    )
    test_db.commit()

    synced = resource_library_service.sync_agent_bindings(
        test_db,
        agent_id=source.id,
        group_names=[source_group, extra_group],
        current_user=test_user,
    )
    loaded = resource_library_service.get_agent_bindings(
        test_db,
        agent_id=source.id,
        current_user=test_user,
    )

    assert synced.group_names == [source_group, extra_group]
    assert loaded.group_names == [source_group, extra_group]
    assert (
        test_db.query(Kind).filter(Kind.kind == "CapabilityInstallation").count() == 0
    )
    assert (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Team",
            ResourceMember.resource_id == source.id,
            ResourceMember.entity_type == "namespace",
        )
        .count()
        == 1
    )

    removed = resource_library_service.sync_agent_bindings(
        test_db,
        agent_id=source.id,
        group_names=[source_group],
        current_user=test_user,
    )

    assert removed.group_names == [source_group]
    assert (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "Team",
            ResourceMember.resource_id == source.id,
            ResourceMember.entity_type == "namespace",
        )
        .count()
        == 0
    )


def test_agent_install_is_an_idempotent_reference_to_the_source(test_db, test_user):
    source = _create_published_agent(test_db)

    first = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )
    second = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )

    assert second.id == first.id
    assert second.installed_reference["team_id"] == source.id
    assert second.installed_kind_id == source.id
    member = test_db.get(ResourceMember, second.id)
    assert member is not None
    assert member.resource_type == "Team"
    assert member.resource_id == source.id
    assert member.entity_type == "user"
    assert member.entity_id == str(test_user.id)
    assert member.status == MemberStatus.APPROVED.value
    assert (
        test_db.query(Kind).filter(Kind.kind == "CapabilityInstallation").count() == 0
    )
    assert (
        team_kinds_service.get_team_detail(
            test_db,
            team_id=source.id,
            user_id=test_user.id,
        )["id"]
        == source.id
    )


@pytest.mark.parametrize(
    "existing_role",
    [
        BaseRole.Owner.value,
        BaseRole.Maintainer.value,
        BaseRole.Developer.value,
    ],
)
def test_reinstalling_agent_preserves_higher_member_role(
    test_db, test_user, existing_role
):
    source = _create_published_agent(test_db)
    first = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )
    member = test_db.get(ResourceMember, first.id)
    assert member is not None
    member.role = existing_role
    test_db.commit()

    resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )

    test_db.refresh(member)
    assert member.role == existing_role


def test_agent_reference_binding_does_not_copy_the_agent_graph(test_db, test_user):
    source = _create_published_agent(test_db)
    graph_counts_before = {
        kind: test_db.query(Kind).filter(Kind.kind == kind).count()
        for kind in ("Team", "Bot", "Ghost")
    }

    install = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )

    assert install.installed_reference["team_id"] == source.id
    assert {
        kind: test_db.query(Kind).filter(Kind.kind == kind).count()
        for kind in ("Team", "Bot", "Ghost")
    } == graph_counts_before


def test_uninstall_personal_agent_reference_keeps_source_agent(test_db, test_user):
    source = _create_published_agent(test_db)
    install = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )

    resource_library_service.uninstall_kind_reference(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )

    assert test_db.get(ResourceMember, install.id) is None
    assert test_db.get(Kind, source.id) is source
    assert source.is_active is True
    assert (
        resource_library_service.list_installs(
            test_db,
            current_user=test_user,
            resource_type="agent",
            page=1,
            limit=20,
        ).items
        == []
    )


def test_agent_reference_binding_keeps_dependencies_on_the_source(test_db, test_user):
    source = _create_published_agent(test_db)
    graph_ids_before = {
        kind: {row.id for row in test_db.query(Kind).filter(Kind.kind == kind).all()}
        for kind in ("Bot", "Ghost")
    }

    install = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )

    assert {
        kind: {row.id for row in test_db.query(Kind).filter(Kind.kind == kind).all()}
        for kind in ("Bot", "Ghost")
    } == graph_ids_before


def test_source_agent_changes_are_visible_through_existing_reference(
    test_db, test_user
):
    source = _create_published_agent(test_db)
    install = resource_library_service.install(
        test_db,
        listing_id=source.id,
        target_namespace="default",
        current_user=test_user,
    )
    source.json["spec"]["description"] = "Updated at the canonical source"
    flag_modified(source, "json")
    test_db.commit()

    personal = resource_library_service.list_installs(
        test_db,
        current_user=test_user,
        resource_type="agent",
        page=1,
        limit=20,
    )

    assert personal.items[0].id == install.id
    assert personal.items[0].installed_reference["team_id"] == source.id
    assert personal.items[0].listing.description == "Updated at the canonical source"

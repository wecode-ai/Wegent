# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.orm.attributes import flag_modified

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_library_publication import ResourceLibraryPublication
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.schemas.base_role import BaseRole
from app.schemas.resource_library import (
    ResourceLibraryCreateListingRequest,
    ResourceLibraryPublicationUpdateRequest,
)
from app.services.adapters.bot_kinds import BotKindsService
from app.services.adapters.team_kinds import team_kinds_service
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
            "spec": {"members": [], "collaborationModel": "solo"},
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
    test_db, test_user, test_admin_user
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
            name=user_skill.name,
            display_name="User Published Skill",
        ),
        current_user=test_user,
    )
    admin_listing = resource_library_service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="skill",
            source_id=admin_skill.id,
            name=admin_skill.name,
            display_name="Admin Published Skill",
        ),
        current_user=test_admin_user,
    )

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
            name=source.name,
            display_name="Team Targeted Published Skill",
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
        name="published-skill",
        display_name="Published Skill",
        description="Published description",
        tags=["docs", "Docs"],
        version="1.1.0",
    )

    listing = resource_library_service.publish(
        test_db, request=request, current_user=test_user
    )
    assert test_db.get(ResourceLibraryPublication, source.id) is not None
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
    assert listing.tags == ["docs"]
    assert first_install.id == second_install.id
    assert first_install.installed_reference["skill_id"] == source.id
    publication = test_db.get(ResourceLibraryPublication, source.id)
    assert publication is not None
    assert publication.install_count == 1

    resource_library_service.update_publication(
        test_db,
        listing_id=source.id,
        request=ResourceLibraryPublicationUpdateRequest(status="archived"),
        current_user=test_user,
    )
    assert test_db.get(ResourceLibraryPublication, source.id) is None
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
                name=source.name,
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

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from app.schemas.resource_library import (
    ResourceLibraryCreateListingRequest,
    ResourceLibraryPublicationUpdateRequest,
)
from app.services.resource_library_service import resource_library_service
from tests.services.test_resource_library_service import (
    _create_agent,
    _create_group_with_member,
    _create_user,
)


def _group_agent(db: Session, owner: User, namespace: str) -> Kind:
    source = _create_agent(db, owner_user_id=owner.id)
    source.namespace = namespace
    source.json["metadata"]["namespace"] = namespace
    flag_modified(source, "json")
    db.commit()
    return source


@pytest.mark.parametrize("role", ["Developer", "Maintainer", "Owner"])
@pytest.mark.parametrize("is_owner", [True, False])
def test_group_agent_editor_can_manage_bindings_and_publication(
    test_db, test_user, role, is_owner
):
    source_group = _create_group_with_member(test_db, test_user, role=role)
    target_group = _create_group_with_member(test_db, test_user, name="target-group")
    owner = test_user if is_owner else _create_user(test_db, "agent-owner")
    source = _group_agent(test_db, owner, source_group)
    service = resource_library_service

    loaded = service.get_agent_bindings(
        test_db, agent_id=source.id, current_user=test_user
    )
    assert loaded.group_names == [source_group]

    service.bind_agent(
        test_db,
        agent_id=source.id,
        target_namespace=target_group,
        current_user=test_user,
    )
    bound = service.get_agent_bindings(
        test_db, agent_id=source.id, current_user=test_user
    )
    assert set(bound.group_names) == {source_group, target_group}

    synced = service.sync_agent_bindings(
        test_db, agent_id=source.id, group_names=[], current_user=test_user
    )
    assert synced.group_names == [source_group]

    published = service.publish(
        test_db,
        request=ResourceLibraryCreateListingRequest(
            resource_type="agent",
            source_id=source.id,
            display_name="Group Agent",
            tags=["technical_development"],
        ),
        current_user=test_user,
    )
    assert published.status == "published"
    updated = service.update_publication(
        test_db,
        listing_id=source.id,
        request=ResourceLibraryPublicationUpdateRequest(description="Updated"),
        current_user=test_user,
    )
    assert updated.description == "Updated"


@pytest.mark.parametrize("role", ["Reporter", "RestrictedAnalyst"])
@pytest.mark.parametrize("operation", ["read", "bind", "sync", "publish"])
def test_group_agent_owner_with_read_only_role_is_denied(
    test_db, test_user, role, operation
):
    group = _create_group_with_member(test_db, test_user, role=role)
    source = _group_agent(test_db, test_user, group)
    service = resource_library_service

    with pytest.raises(HTTPException) as exc_info:
        if operation == "read":
            service.get_agent_bindings(
                test_db, agent_id=source.id, current_user=test_user
            )
        elif operation == "bind":
            service.bind_agent(
                test_db,
                agent_id=source.id,
                target_namespace="default",
                current_user=test_user,
            )
        elif operation == "sync":
            service.sync_agent_bindings(
                test_db, agent_id=source.id, group_names=[], current_user=test_user
            )
        else:
            service.publish(
                test_db,
                request=ResourceLibraryCreateListingRequest(
                    resource_type="agent",
                    source_id=source.id,
                    display_name="Group Agent",
                    tags=["technical_development"],
                ),
                current_user=test_user,
            )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Publish permission denied"


@pytest.mark.parametrize("operation", ["bind", "sync"])
def test_group_agent_developer_still_needs_target_group_permission(
    test_db, test_user, operation
):
    group = _create_group_with_member(test_db, test_user)
    target = _create_group_with_member(
        test_db, test_user, role="Reporter", name="read-only-target"
    )
    source = _group_agent(test_db, test_user, group)

    with pytest.raises(HTTPException) as exc_info:
        if operation == "bind":
            resource_library_service.bind_agent(
                test_db,
                agent_id=source.id,
                target_namespace=target,
                current_user=test_user,
            )
        else:
            resource_library_service.sync_agent_bindings(
                test_db,
                agent_id=source.id,
                group_names=[target],
                current_user=test_user,
            )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Developer role is required to install into a group"
    bindings = resource_library_service.get_agent_bindings(
        test_db, agent_id=source.id, current_user=test_user
    )
    assert bindings.group_names == [group]

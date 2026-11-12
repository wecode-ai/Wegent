"""Group grants preserve the source's existing delegated sharing policy."""

from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.services.external_entity_resolver import _external_entity_resolvers
from app.services.group_resource_permissions import authorize_group_team
from app.services.resource_authority_reads import current_authority_reads
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver
from tests.services.test_thread_participation import make_group, person


def source(db, actor, mode):
    key = uuid4().hex
    name = f"source-authority-{key}"
    owner = person(db, f"team-source-owner-{key}")
    team = Kind(
        kind="Team",
        namespace="default",
        name="Delegated source",
        user_id=owner.id,
        is_active=True,
        json={},
    )
    db.add(team)
    db.flush()
    if mode in {"namespace", "parent", "namespace_entity"}:
        namespace = Namespace(name=name, owner_user_id=owner.id, is_active=True)
        db.add(namespace)
        db.flush()
        membership = ResourceMember(
            resource_type="Namespace",
            resource_id=namespace.id,
            entity_type="user",
            entity_id=str(actor.id),
            role="Maintainer",
            status="approved",
        )
        db.add(membership)
        if mode == "parent":
            db.add(
                Namespace(name=f"{name}/child", owner_user_id=owner.id, is_active=True)
            )
            team.namespace = f"{name}/child"
        elif mode == "namespace":
            team.namespace = namespace.name
        else:
            db.add(
                ResourceMember(
                    resource_type="Team",
                    resource_id=team.id,
                    entity_type="namespace",
                    entity_id=str(namespace.id),
                    role="Maintainer",
                    status="approved",
                )
            )
        db.flush()
        return team, membership
    grant = ResourceMember(
        resource_type="Team",
        resource_id=team.id,
        entity_type="user",
        entity_id=str(actor.id),
        role="Maintainer",
        status="approved",
    )
    db.add(grant)
    db.flush()
    return team, grant


@pytest.mark.parametrize("mode", ["direct", "namespace", "parent", "namespace_entity"])
def test_group_team_uses_original_delegated_source_and_refuses_withdrawal(
    test_db, test_user, monkeypatch, mode
):
    monkeypatch.setitem(
        _external_entity_resolvers, "namespace", NamespaceEntityResolver
    )
    group = make_group(test_db, test_user, [])
    team, source_grant = source(test_db, test_user, mode)
    assert current_authority_reads() is False
    authorize_group_team(test_db, group, test_user.id, team.id)
    assert current_authority_reads() is False
    target = (
        test_db.query(ResourceMember)
        .filter_by(
            resource_type="Team",
            resource_id=team.id,
            entity_type="chat_group",
            entity_id=group.id,
        )
        .one()
    )
    assert target.status == "approved"
    assert team.user_id != test_user.id
    target.status = "rejected"
    source_grant.status = "rejected"
    test_db.flush()
    with pytest.raises(HTTPException):
        authorize_group_team(test_db, group, test_user.id, team.id)
    assert current_authority_reads() is False
    assert target.status == "rejected"

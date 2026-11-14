# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Default Skill discovery preserves access rules while batching metadata reads."""

from copy import deepcopy
from typing import Any

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.schemas.namespace import GroupRole
from app.services.external_entity_resolver import _external_entity_resolvers
from app.services.group_permission import get_effective_roles_in_groups
from app.services.share.namespace_entity_resolver import NamespaceEntityResolver
from app.services.skill_binding_service import skill_binding_service
from tests.api.test_skills_api import (
    _add_group_member,
    _create_group,
    _create_user,
)
from tests.services.test_skill_binding_service import _create_skill


def _asset(
    db: Session,
    user_id: int,
    name: str,
    *,
    namespace: str = "default",
    capability: Any = None,
) -> Kind:
    skill = _create_skill(db, user_id=user_id, name=name)
    skill.namespace = namespace
    skill.json = {
        **skill.json,
        "metadata": {"name": name, "namespace": namespace},
        "spec": {**skill.json["spec"], "capability": capability},
    }
    db.commit()
    return skill


def _enable(db: Session, skill: Kind, user_id: int) -> Kind:
    return skill_binding_service.add_user_default_skill(
        db, user_id=user_id, skill_id=skill.id, created_by=user_id
    )


def _set_capability(skill: Kind, capability: Any) -> None:
    payload = deepcopy(skill.json)
    payload["spec"]["capability"] = capability
    skill.json = payload


def test_default_skill_batch_preserves_access_and_rechecks_revocation(
    test_db: Session, test_user: User
) -> None:
    publisher = _create_user(test_db, "batch-publisher", "batch@example.com")
    parent = _create_group(test_db, publisher, "batch-parent")
    child = _create_group(test_db, publisher, "batch-parent/child")
    _add_group_member(test_db, parent, test_user, "Reporter")
    published = {"visibility": "public", "publishStatus": "published"}
    skills = {
        "owned": _asset(test_db, test_user.id, "owned", capability="invalid"),
        "system": _asset(test_db, 0, "system"),
        "published": _asset(test_db, publisher.id, "published", capability=published),
        "archived": _asset(test_db, publisher.id, "archived", capability=published),
        "private": _asset(test_db, publisher.id, "private", capability=published),
        "malformed": _asset(test_db, publisher.id, "malformed", capability=published),
        "missing-capability": _asset(
            test_db, publisher.id, "missing-capability", capability=published
        ),
        "inactive": _asset(test_db, test_user.id, "inactive"),
        "inherited": _asset(test_db, publisher.id, "inherited", namespace=child.name),
    }
    for skill in skills.values():
        _enable(test_db, skill, test_user.id)

    _set_capability(
        skills["archived"], {"visibility": "public", "publishStatus": "archived"}
    )
    _set_capability(
        skills["private"], {"visibility": "private", "publishStatus": "published"}
    )
    _set_capability(skills["malformed"], ["public", "published"])
    payload = deepcopy(skills["missing-capability"].json)
    payload["spec"].pop("capability")
    skills["missing-capability"].json = payload
    skills["inactive"].is_active = False
    test_db.commit()
    expected = {
        skills[name].id for name in ("owned", "system", "published", "inherited")
    }
    individually_allowed = {
        skill.id
        for skill in skills.values()
        if skill_binding_service.can_user_access_skill(
            test_db, skill=skill, user_id=test_user.id
        )
    }
    assert individually_allowed == expected
    assert (
        skill_binding_service.list_user_default_skill_ids(test_db, test_user.id)
        == expected
    )
    assert (
        skill_binding_service.list_user_default_skill_ids(test_db, test_user.id)
        == expected
    )

    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "Namespace",
        ResourceMember.resource_id == parent.id,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(test_user.id),
    ).delete(synchronize_session=False)
    test_db.commit()
    revoked_expected = expected - {skills["inherited"].id}
    assert not skill_binding_service.can_user_access_skill(
        test_db, skill=skills["inherited"], user_id=test_user.id
    )
    assert (
        skill_binding_service.list_user_default_skill_ids(test_db, test_user.id)
        == revoked_expected
    )
    assert {
        ref["skill_id"]
        for ref in skill_binding_service.list_user_default_skill_refs(
            test_db, test_user.id
        )
    } == revoked_expected

    _add_group_member(test_db, parent, test_user, "RestrictedAnalyst")
    assert not skill_binding_service.can_user_access_skill(
        test_db, skill=skills["inherited"], user_id=test_user.id
    )
    assert (
        skill_binding_service.list_user_default_skill_ids(test_db, test_user.id)
        == revoked_expected
    )
    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "Namespace",
        ResourceMember.resource_id == parent.id,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(test_user.id),
    ).update({ResourceMember.role: "Reporter"}, synchronize_session=False)
    test_db.commit()
    assert (
        skill_binding_service.list_user_default_skill_ids(test_db, test_user.id)
        == expected
    )


def test_default_skill_batch_does_not_promote_namespace_entity_grants(
    test_db: Session, test_user: User, monkeypatch
) -> None:
    monkeypatch.setitem(
        _external_entity_resolvers, "namespace", NamespaceEntityResolver
    )
    publisher = _create_user(test_db, "entity-publisher", "entity@example.com")
    source = _create_group(test_db, publisher, "batch-source")
    target = _create_group(test_db, publisher, "batch-target")
    _add_group_member(test_db, source, test_user, "Reporter")
    _add_group_member(test_db, target, test_user, "Reporter")
    skill = _asset(test_db, publisher.id, "entity-skill", namespace=target.name)
    _enable(test_db, skill, test_user.id)
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=target.id,
            entity_type="namespace",
            entity_id=str(source.id),
            role="Owner",
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=publisher.id,
            reviewed_by_user_id=publisher.id,
        )
    )
    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "Namespace",
        ResourceMember.resource_id == target.id,
        ResourceMember.entity_type == "user",
        ResourceMember.entity_id == str(test_user.id),
    ).delete(synchronize_session=False)
    test_db.commit()

    assert get_effective_roles_in_groups(test_db, test_user.id, [target.name]) == {
        target.name: GroupRole.Owner
    }
    assert not skill_binding_service.can_user_access_skill(
        test_db, skill=skill, user_id=test_user.id
    )
    assert (
        skill_binding_service.list_user_default_skill_ids(test_db, test_user.id)
        == set()
    )


def test_default_skill_batch_excludes_invalid_and_dangling_bindings(
    test_db: Session, test_user: User
) -> None:
    names = (
        "valid",
        "wrong-target",
        "wrong-type",
        "invalid-ref",
        "missing",
        "disabled",
    )
    skills = {name: _asset(test_db, test_user.id, name) for name in names}
    bindings = {
        name: _enable(test_db, skill, test_user.id) for name, skill in skills.items()
    }
    for name, key, value in (
        ("wrong-target", "targetId", "user:999999"),
        ("wrong-type", "targetType", "group"),
        ("invalid-ref", "skillRef", {"skillId": "invalid"}),
    ):
        payload = deepcopy(bindings[name].json)
        payload["spec"][key] = value
        bindings[name].json = payload
    bindings["disabled"].is_active = False
    test_db.delete(skills["missing"])
    test_db.commit()

    assert skill_binding_service.list_user_default_skill_ids(test_db, test_user.id) == {
        skills["valid"].id
    }
    assert [
        binding.id
        for binding in skill_binding_service.list_user_default_bindings(
            test_db, test_user.id
        )
    ] == [bindings["valid"].id]


def test_default_skill_query_count_is_independent_of_installed_skill_count(
    test_db: Session, test_user: User
) -> None:
    user_id = test_user.id
    expected = set()

    def add_skills(start: int, stop: int) -> None:
        for number in range(start, stop):
            skill = _asset(test_db, user_id, f"batch-count-{number}")
            expected.add(skill.id)
            _enable(test_db, skill, user_id)

    def read_ids() -> list[tuple[str, Any]]:
        statements = []

        def record(_conn, _cursor, statement, parameters, _context, _many) -> None:
            if statement.lstrip().startswith("SELECT") and "FROM kinds" in statement:
                statements.append((statement, parameters))

        test_db.expire_all()
        engine = test_db.get_bind()
        event.listen(engine, "before_cursor_execute", record)
        try:
            actual = skill_binding_service.list_user_default_skill_ids(test_db, user_id)
        finally:
            event.remove(engine, "before_cursor_execute", record)
        assert actual == expected
        assert not any(
            "kinds.json AS kinds_json" in sql and "Skill" in parameters
            for sql, parameters in statements
        )
        return statements

    add_skills(0, 2)
    first = read_ids()
    add_skills(2, 8)
    second = read_ids()
    assert len(first) == len(second) == 2

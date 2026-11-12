"""Public navigation contracts when external Directory facts are unknown."""

import pytest

from app.models.kind import Kind
from app.models.resource_member import ResourceMember
from tests.permission_fixtures import permission_subject  # noqa: F401


@pytest.mark.parametrize("entry", ["list", "acl", "external"])
def test_owned_list_consumers_ignore_unrelated_group_failure(
    test_db, permission_subject, entry
):
    from app.models.namespace import Namespace
    from app.schemas.knowledge import ResourceScope
    from app.services.knowledge.knowledge_service import (
        ExternalKnowledgeBaseListFilters,
        KnowledgeService,
    )
    from app.services.knowledge.knowledge_visibility_query import (
        get_acl_accessible_knowledge_base_ids,
    )

    visitor, ids, directory, _ = permission_subject
    for library in test_db.query(Kind).filter(Kind.id.in_(ids)).all():
        library.user_id = visitor.id
    group = Namespace(
        name="unrelated-team",
        display_name="Unrelated",
        owner_user_id=visitor.id,
        is_active=True,
    )
    test_db.add(group)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="directory_group",
            entity_id="unknown-group",
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    if entry == "acl":
        actual = get_acl_accessible_knowledge_base_ids(
            test_db, user_id=visitor.id, candidate_ids=ids
        )
    elif entry == "external":
        rows, total = KnowledgeService.list_external_knowledge_bases(
            test_db,
            user_id=visitor.id,
            filters=ExternalKnowledgeBaseListFilters(scope=ResourceScope.ALL),
        )
        actual = {kb.id for kb in rows}
        assert total == 12
    else:
        actual = {
            kb.id for kb in KnowledgeService.list_knowledge_bases(test_db, visitor.id)
        }
    assert actual == set(ids)


@pytest.mark.parametrize("filter_kind", ["keyword", "owner"])
def test_external_list_filters_before_resolving_unknown_permissions(
    test_db, permission_subject, filter_kind
):
    from app.schemas.knowledge import ResourceScope
    from app.services.knowledge.knowledge_service import (
        ExternalKnowledgeBaseListFilters,
        KnowledgeService,
    )

    visitor, ids, directory, _ = permission_subject
    library = test_db.get(Kind, ids[0])
    library.user_id = visitor.id
    library.json = {"spec": {"name": "chosen", "directAccessRequirement": "read"}}
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    filters = ExternalKnowledgeBaseListFilters(
        scope=ResourceScope.ALL,
        keyword="chosen" if filter_kind == "keyword" else None,
        owner_user_ids=(visitor.id,) if filter_kind == "owner" else (),
    )
    page, total = KnowledgeService.list_external_knowledge_bases(
        test_db, user_id=visitor.id, filters=filters
    )
    assert total == 1
    assert [kb.id for kb in page] == [ids[0]]


def test_owned_team_navigation_survives_unknown_group_membership(
    test_db, permission_subject
):
    from app.models.namespace import Namespace
    from app.services.knowledge.knowledge_service import KnowledgeService

    visitor, ids, directory, _ = permission_subject
    library = test_db.get(Kind, ids[0])
    library.user_id = visitor.id
    library.namespace = "owned-team"
    group = Namespace(name=library.namespace, owner_user_id=visitor.id, is_active=True)
    test_db.add(group)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Reporter",
            status="approved",
        )
    )
    # Other personal libraries must not introduce decisive unknown facts.
    for kb in test_db.query(Kind).filter(Kind.id.in_(ids[1:])).all():
        kb.user_id = visitor.id
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    grouped = KnowledgeService.get_all_knowledge_bases_grouped(test_db, visitor.id)
    assert [kb.id for group in grouped.groups for kb in group.knowledge_bases] == [
        ids[0]
    ]


@pytest.mark.parametrize("requirement", [None, ""])
@pytest.mark.parametrize(
    "entry",
    [
        "list",
        "external",
        "get_all_knowledge_bases_grouped",
        "get_personal_knowledge_bases_grouped",
        "get_accessible_knowledge",
    ],
)
def test_legacy_navigation_preserves_empty_opening_requirement(
    test_db, permission_subject, requirement, entry
):
    from app.schemas.knowledge import ResourceScope
    from app.services.knowledge.knowledge_service import (
        ExternalKnowledgeBaseListFilters,
        KnowledgeService,
    )

    visitor, ids, directory, _ = permission_subject
    for library in test_db.query(Kind).filter(Kind.id.in_(ids)).all():
        library.user_id = visitor.id
        library.json = {"spec": {"directAccessRequirement": requirement}}
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    if entry == "get_personal_knowledge_bases_grouped":
        from pydantic import ValidationError

        # This response schema has always rejected explicit null/empty values.
        with pytest.raises(ValidationError):
            KnowledgeService.get_personal_knowledge_bases_grouped(test_db, visitor.id)
        return
    if entry == "list":
        rows = KnowledgeService.list_knowledge_bases(test_db, visitor.id)
    elif entry == "external":
        rows, total = KnowledgeService.list_external_knowledge_bases(
            test_db,
            user_id=visitor.id,
            filters=ExternalKnowledgeBaseListFilters(scope=ResourceScope.ALL),
        )
        assert total == 12
    else:
        response = getattr(KnowledgeService, entry)(test_db, visitor.id)
        rows = (
            response.personal.created_by_me
            if entry == "get_all_knowledge_bases_grouped"
            else (
                response["created_by_me"]
                if entry == "get_personal_knowledge_bases_grouped"
                else response.personal
            )
        )
    assert {kb.id for kb in rows} == set(ids)


ENTRIES = [
    "list",
    "external",
    "ordinary",
    "acl",
    "all-grouped",
    "personal-grouped",
    "accessible",
]


def navigation_ids(db, user_id, entry):
    from app.schemas.knowledge import ResourceScope
    from app.services.knowledge.knowledge_service import (
        ExternalKnowledgeBaseListFilters,
        KnowledgeService,
    )
    from app.services.knowledge.knowledge_visibility_query import (
        get_acl_accessible_knowledge_base_ids,
    )

    if entry == "list":
        rows = KnowledgeService.list_knowledge_bases(db, user_id)
    elif entry == "external":
        rows, total = KnowledgeService.list_external_knowledge_bases(
            db,
            user_id=user_id,
            filters=ExternalKnowledgeBaseListFilters(scope=ResourceScope.ALL),
        )
        assert total == len(rows)
    elif entry == "ordinary":
        rows, total = KnowledgeService.list_knowledge_bases_paginated(db, user_id)
        assert total == len(rows)
    elif entry == "acl":
        ids = [
            row[0]
            for row in db.query(Kind.id).filter(Kind.kind == "KnowledgeBase").all()
        ]
        return get_acl_accessible_knowledge_base_ids(
            db, user_id=user_id, candidate_ids=ids
        )
    elif entry == "all-grouped":
        response = KnowledgeService.get_all_knowledge_bases_grouped(db, user_id)
        rows = [
            *response.personal.created_by_me,
            *response.personal.shared_with_me,
            *(kb for group in response.groups for kb in group.knowledge_bases),
            *response.organization.knowledge_bases,
        ]
    elif entry == "personal-grouped":
        response = KnowledgeService.get_personal_knowledge_bases_grouped(db, user_id)
        rows = [*response["created_by_me"], *response["shared_with_me"]]
    else:
        response = KnowledgeService.get_accessible_knowledge(db, user_id)
        rows = [
            *response.personal,
            *(kb for group in response.team for kb in group.knowledge_bases),
        ]
    return {kb.id for kb in rows}


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize(
    "grant,requirement",
    [
        ("Reporter", "read"),
        ("RestrictedAnalyst", "read"),
        (None, "read"),
        ("Developer", "edit"),
        ("Reporter", "edit"),
    ],
)
def test_navigation_projects_unknown_facts_at_public_boundaries(
    test_db, permission_subject, entry, grant, requirement
):
    from fastapi import HTTPException

    visitor, ids, directory, _ = permission_subject
    for library in test_db.query(Kind).filter(Kind.id.in_(ids)).all():
        library.json = {
            "spec": {"name": library.name, "directAccessRequirement": requirement}
        }
        if grant:
            test_db.add(
                ResourceMember(
                    resource_type="KnowledgeBase",
                    resource_id=library.id,
                    entity_type="user",
                    entity_id=str(visitor.id),
                    role=grant,
                    status="approved",
                )
            )
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    # Unknown Directory roles are Reporter, so they cannot satisfy the edit requirement.
    decisive = grant is None and requirement == "read"
    if decisive:
        with pytest.raises(HTTPException) as failure:
            navigation_ids(test_db, visitor.id, entry)
        assert failure.value.status_code == 503
        assert failure.value.headers["Retry-After"] == "1"
    else:
        expected = grant in {"Reporter", "Developer"} and (
            requirement == "read" or grant == "Developer" or entry == "acl"
        )
        assert navigation_ids(test_db, visitor.id, entry) == (
            set(ids) if expected else set()
        )


def test_chat_defaults_keep_raw_acl_and_agent_owner_identity(
    test_db, permission_subject
):
    from app.models.task import TaskResource
    from app.services.chat.task_default_knowledge_bases import (
        resolve_task_default_knowledge_base_ids,
    )
    from tests.services.adapters.test_team_child_namespace_authorization import (
        _create_parent_agent_graph,
    )

    visitor, ids, directory, _ = permission_subject
    library = test_db.get(Kind, ids[0])
    library.json = {"spec": {"directAccessRequirement": "edit"}}
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=library.id,
            entity_type="user",
            entity_id=str(visitor.id),
            role="Reporter",
            status="approved",
        )
    )
    team = _create_parent_agent_graph(
        test_db, visitor, "default", default_knowledge_base_id=library.id
    )
    task = TaskResource(
        user_id=visitor.id,
        kind="Task",
        name="default-selection",
        namespace="default",
        is_active=1,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "default-selection", "namespace": "default"},
            "spec": {
                "title": "Select",
                "prompt": "hello",
                "teamRef": {
                    "name": team.name,
                    "namespace": "default",
                    "user_id": visitor.id,
                },
                "workspaceRef": {"name": "workspace", "namespace": "default"},
            },
        },
    )
    test_db.add(task)
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    assert resolve_task_default_knowledge_base_ids(test_db, task.id, visitor.id) == [
        library.id
    ]


@pytest.mark.parametrize(
    "path",
    [
        "/api/knowledge-bases/all-grouped",
        "/api/knowledge-bases/personal/grouped",
        "/api/knowledge-bases/accessible",
        "/api/knowledge-bases?scope=all&offset=3&limit=4",
    ],
)
@pytest.mark.parametrize("owner", [True, False])
def test_navigation_http_retains_success_and_retry_contract(
    test_client, test_db, permission_subject, path, owner
):
    from app.core.security import create_access_token

    visitor, ids, directory, _ = permission_subject
    if owner:
        for library in test_db.query(Kind).filter(Kind.id.in_(ids)).all():
            library.user_id = visitor.id
        test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    token = create_access_token({"sub": visitor.user_name})
    response = test_client.get(path, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == (200 if owner else 503), response.text
    body = response.json()
    if not owner:
        assert response.headers["retry-after"] == "1"
        assert body["detail"]["status"] == "unknown"
    elif path.endswith("all-grouped"):
        assert set(body) == {"personal", "groups", "organization", "summary"}
        assert {kb["id"] for kb in body["personal"]["created_by_me"]} == set(ids)
    elif path.endswith("personal/grouped"):
        assert set(body) == {"created_by_me", "shared_with_me"}
        assert len(body["created_by_me"]) == 12
    elif path.endswith("accessible"):
        assert len(body["personal"]) == 12
        assert body["team"] == []
    else:
        assert body["total"] == 12
        assert body["returned_count"] == 4
        assert body["offset"] == 3
        assert body["limit"] == 4
        assert body["has_more"] is True
        assert [kb["id"] for kb in body["items"]] == sorted(ids, reverse=True)[3:7]
    assert directory.call_count == 1


def test_nonpaginated_all_keeps_namespace_derived_team_before_organization(
    test_db, permission_subject
):
    from app.models.namespace import Namespace
    from app.services.external_entity_resolver import register_entity_resolver
    from app.services.knowledge.knowledge_service import KnowledgeService
    from app.services.share.namespace_entity_resolver import NamespaceEntityResolver

    register_entity_resolver("namespace", NamespaceEntityResolver)
    visitor, ids, _, _ = permission_subject
    library = test_db.get(Kind, ids[0])
    team = Namespace(
        name="namespace-derived-team", owner_user_id=library.user_id, is_active=True
    )
    source = Namespace(
        name="membership-source", owner_user_id=library.user_id, is_active=True
    )
    org = Namespace(
        name="organization",
        owner_user_id=library.user_id,
        is_active=True,
        level="organization",
    )
    test_db.add_all([team, source, org])
    test_db.flush()
    library.namespace = team.name
    for kb in test_db.query(Kind).filter(Kind.id.in_(ids[1:])).all():
        kb.is_active = False
    test_db.add_all(
        [
            ResourceMember(
                resource_type="Namespace",
                resource_id=source.id,
                entity_type="user",
                entity_id=str(visitor.id),
                role="Reporter",
                status="approved",
            ),
            ResourceMember(
                resource_type="Namespace",
                resource_id=team.id,
                entity_type="namespace",
                entity_id=str(source.id),
                role="Reporter",
                status="approved",
            ),
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=library.id,
                entity_type="user",
                entity_id=str(visitor.id),
                role="Reporter",
                status="approved",
            ),
        ]
    )
    company = Kind(
        kind="KnowledgeBase",
        name="company",
        namespace=org.name,
        user_id=library.user_id,
        is_active=True,
        json={"spec": {"directAccessRequirement": "read"}},
    )
    test_db.add(company)
    test_db.flush()
    assert [
        kb.id for kb in KnowledgeService.list_knowledge_bases(test_db, visitor.id)
    ] == [library.id, company.id]


@pytest.mark.parametrize("entry", ENTRIES)
@pytest.mark.parametrize(
    "child_department,child_role,direct_role,expected",
    [
        ("D0", "Reporter", "Reporter", True),
        ("D1", "Reporter", "Reporter", "unknown"),
        ("D0", "Reporter", "RestrictedAnalyst", False),
    ],
)
def test_navigation_preserves_correlated_inheritance_and_denial(
    test_db,
    permission_subject,
    entry,
    child_department,
    child_role,
    direct_role,
    expected,
):
    from fastapi import HTTPException

    from app.models.namespace import Namespace

    visitor, ids, directory, _ = permission_subject
    library = test_db.get(Kind, ids[0])
    library.namespace = "parent/child"
    parent = Namespace(name="parent", owner_user_id=library.user_id, is_active=True)
    child = Namespace(
        name=library.namespace, owner_user_id=library.user_id, is_active=True
    )
    test_db.add_all([parent, child])
    test_db.flush()
    test_db.add_all(
        [
            ResourceMember(
                resource_type="Namespace",
                resource_id=parent.id,
                entity_type="directory_group",
                entity_id="D0",
                role="RestrictedAnalyst",
                status="approved",
            ),
            ResourceMember(
                resource_type="Namespace",
                resource_id=child.id,
                entity_type="directory_group",
                entity_id=child_department,
                role=child_role,
                status="approved",
            ),
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=library.id,
                entity_type="user",
                entity_id=str(visitor.id),
                role=direct_role,
                status="approved",
            ),
        ]
    )
    for kb in test_db.query(Kind).filter(Kind.id.in_(ids[1:])).all():
        kb.user_id = visitor.id
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    if expected == "unknown" and entry != "personal-grouped":
        with pytest.raises(HTTPException) as failure:
            navigation_ids(test_db, visitor.id, entry)
        assert failure.value.status_code == 503
    else:
        actual = navigation_ids(test_db, visitor.id, entry)
        include = expected is True and entry != "personal-grouped"
        assert actual == set(ids[1:] + ([ids[0]] if include else []))


@pytest.mark.parametrize("scope", ["group", "organization"])
def test_scoped_pagination_limits_candidates_before_unknown_decisions(
    test_db, permission_subject, scope
):
    from app.models.namespace import Namespace
    from app.schemas.knowledge import ResourceScope
    from app.services.knowledge.knowledge_service import KnowledgeService

    visitor, ids, directory, _ = permission_subject
    group = Namespace(
        name="requested", owner_user_id=visitor.id, level=scope, is_active=True
    )
    test_db.add(group)
    test_db.flush()
    for kb in test_db.query(Kind).filter(Kind.id.in_(ids)).all():
        kb.namespace = group.name
    test_db.add_all(
        [
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type="user",
                entity_id=str(visitor.id),
                role="Reporter",
                status="approved",
            ),
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=ids[0],
                entity_type="user",
                entity_id=str(visitor.id),
                role="Reporter",
                status="approved",
            ),
        ]
    )
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    from app.services.knowledge.knowledge_visibility_query import (
        build_knowledge_discovery_query,
    )

    query, _ = build_knowledge_discovery_query(
        test_db,
        visitor.id,
        ids[:1],
        scope=ResourceScope(scope),
        group_name=group.name if scope == "group" else None,
    )
    assert query.count() == 1
    assert [kb.id for kb in query.all()] == ids[:1]


def test_personal_list_preserves_owner_priority_when_timestamps_tie(
    test_db, permission_subject
):
    from app.schemas.knowledge import ResourceScope
    from app.services.knowledge.knowledge_service import KnowledgeService

    visitor, ids, directory, _ = permission_subject
    test_db.get(Kind, ids[1]).user_id = visitor.id
    for library in test_db.query(Kind).filter(Kind.id.in_(ids[2:])).all():
        library.is_active = False
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=ids[0],
            entity_type="user",
            entity_id=str(visitor.id),
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    from datetime import datetime

    test_db.query(Kind).filter(Kind.id.in_(ids[:2])).update(
        {Kind.updated_at: datetime(2026, 1, 1)}, synchronize_session="fetch"
    )
    directory.side_effect = RuntimeError("Directory unavailable")
    rows = KnowledgeService.list_knowledge_bases(
        test_db, visitor.id, ResourceScope.PERSONAL
    )
    assert [row.id for row in rows] == [ids[1], ids[0]]


def test_all_grouped_preserves_explicit_group_projection(test_db, permission_subject):
    from app.models.namespace import Namespace
    from app.services.knowledge.knowledge_service import KnowledgeService

    visitor, ids, directory, _ = permission_subject
    parent = Namespace(name="parent", owner_user_id=visitor.id, is_active=True)
    child = Namespace(name="parent/child", owner_user_id=visitor.id, is_active=True)
    test_db.add_all([parent, child])
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=parent.id,
            entity_type="user",
            entity_id=str(visitor.id),
            role="Reporter",
            status="approved",
        )
    )
    # This library has inherited opening permission, but no explicit group binding.
    child_library = Kind(
        kind="KnowledgeBase",
        name="child",
        namespace=child.name,
        user_id=1,
        is_active=True,
        json={"spec": {"directAccessRequirement": "read"}},
    )
    test_db.add(child_library)
    for kb in test_db.query(Kind).filter(Kind.id.in_(ids)).all():
        kb.user_id = visitor.id
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    response = KnowledgeService.get_all_knowledge_bases_grouped(test_db, visitor.id)
    assert [group.group_name for group in response.groups] == [parent.name]
    assert all(
        kb.id != child_library.id
        for group in response.groups
        for kb in group.knowledge_bases
    )
    # The accessible/chat API has always expanded inherited groups.
    accessible = KnowledgeService.get_accessible_knowledge(test_db, visitor.id)
    assert any(
        kb.id == child_library.id
        for group in accessible.team
        for kb in group.knowledge_bases
    )


def test_organization_display_role_does_not_repeat_unrelated_directory_failure(
    test_db, permission_subject
):
    from app.models.namespace import Namespace
    from app.services.knowledge.knowledge_service import KnowledgeService

    visitor, ids, directory, _ = permission_subject
    org = Namespace(
        name="company", owner_user_id=visitor.id, level="organization", is_active=True
    )
    test_db.add(org)
    test_db.flush()
    for library in test_db.query(Kind).filter(Kind.id.in_(ids)).all():
        library.namespace = org.name
        library.user_id = visitor.id
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=org.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    directory.side_effect = RuntimeError("Directory unavailable")
    response = KnowledgeService.get_all_knowledge_bases_grouped(test_db, visitor.id)
    assert {kb.id for kb in response.organization.knowledge_bases} == set(ids)
    assert response.organization.kb_count == 12
    assert directory.call_count == 1


@pytest.mark.parametrize("group_role", ["Reporter", "Developer"])
@pytest.mark.parametrize("available", [False, True])
def test_creator_group_visibility_does_not_promote_other_library_roles(
    test_db, permission_subject, group_role, available
):
    from app.models.namespace import Namespace
    from app.services.knowledge.knowledge_service import KnowledgeService

    viewer, ids, directory, _ = permission_subject
    owned = test_db.get(Kind, ids[0])
    shared = test_db.get(Kind, ids[1])
    group = Namespace(
        name="mixed-ownership", owner_user_id=shared.user_id, is_active=True
    )
    test_db.add(group)
    test_db.flush()
    owned.user_id = viewer.id
    owned.namespace = group.name
    shared.namespace = group.name
    for library in test_db.query(Kind).filter(Kind.id.in_(ids[2:])).all():
        library.is_active = False
    test_db.add_all(
        [
            ResourceMember(
                resource_type="Namespace",
                resource_id=group.id,
                entity_type="directory_group",
                entity_id="D0",
                role=group_role,
                status="approved",
            ),
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=shared.id,
                entity_type="user",
                entity_id=str(viewer.id),
                role="Reporter",
                status="approved",
            ),
        ]
    )
    test_db.flush()
    if not available:
        directory.side_effect = RuntimeError("Directory unavailable")

    response = KnowledgeService.get_all_knowledge_bases_grouped(test_db, viewer.id)

    assert [item.group_name for item in response.groups] == [group.name]
    rows = {kb.id: kb for kb in response.groups[0].knowledge_bases}
    assert set(rows) == {owned.id, shared.id}
    assert rows[shared.id].my_role == (group_role if available else "Reporter")
    assert rows[owned.id].my_role == (group_role if available else "Owner")
    assert response.groups[0].kb_count == 2

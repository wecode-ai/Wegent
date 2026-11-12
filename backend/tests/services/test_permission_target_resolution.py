"""Explicit capability targets do not depend on unrelated memberships."""

import pytest

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from tests.permission_fixtures import permission_subject  # noqa: F401
from tests.services.test_group_action_consumers_unknown import (  # noqa: F401
    action_resources,
)


@pytest.fixture
def scoped_target(test_db, action_resources):
    viewer, group, team, skill = action_resources
    unrelated = Namespace(name="unrelated-target", owner_user_id=1, is_active=True)
    test_db.add(unrelated)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=unrelated.id,
            entity_type="directory_group",
            entity_id="D999",
            role="Reporter",
            status="approved",
        )
    )
    shell = Kind(
        kind="Shell",
        name="target-shell",
        namespace=group.name,
        user_id=1,
        is_active=True,
        json={
            "metadata": {"name": "target-shell", "namespace": group.name},
            "spec": {"shellType": "Chat"},
        },
    )
    test_db.add(shell)
    test_db.flush()
    return viewer, group, shell, skill


def test_explicit_shell_ignores_unrelated_unknown(test_db, scoped_target):
    from app.services.adapters.shell_utils import get_shell_by_name

    viewer, group, shell, _ = scoped_target
    assert get_shell_by_name(test_db, shell.name, viewer.id, group.name) == shell


def test_explicit_skill_ignores_unrelated_unknown(test_db, scoped_target):
    from app.services.skill_resolution import find_skill_by_ref

    viewer, group, _, skill = scoped_target
    assert (
        find_skill_by_ref(
            test_db,
            skill_name=skill.name,
            namespace=group.name,
            is_public=False,
            user_id=viewer.id,
            skill_id=skill.id,
        )
        == skill
    )


def test_named_group_model_ignores_unrelated_unknown(test_db, scoped_target):
    from app.services.model_aggregation_service import (
        ModelType,
        model_aggregation_service,
    )

    viewer, group, _, _ = scoped_target
    model = Kind(
        kind="Model",
        name="target-model",
        namespace="default",
        user_id=1,
        is_active=True,
        json={
            "metadata": {"name": "target-model", "namespace": "default"},
            "spec": {
                "modelType": "llm",
                "modelConfig": {
                    "env": {
                        "model": "openai",
                        "model_id": "target-upstream",
                    }
                },
            },
        },
    )
    test_db.add(model)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Model",
            resource_id=model.id,
            entity_type="namespace",
            entity_id=str(group.id),
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    result = model_aggregation_service.get_model_by_name_and_type(
        test_db, viewer, model.name, ModelType.GROUP
    )
    assert result["modelId"] == "target-upstream"
    assert result["namespace"] == group.name


def test_explicit_shell_info_does_not_enumerate_groups(test_db, scoped_target):
    from app.services.adapters.shell_utils import get_shell_info_by_name

    viewer, group, shell, _ = scoped_target
    info = get_shell_info_by_name(test_db, shell.name, viewer.id, group.name)
    assert info["namespace"] == group.name
    assert info["shell_type"] == "Chat"


def test_named_shell_json_ignores_unrelated_unknown(test_db, scoped_target):
    from app.services.adapters.shell_utils import find_shell_json

    viewer, _, shell, _ = scoped_target
    assert find_shell_json(test_db, shell.name, viewer.id) == shell.json


def test_target_lookup_does_not_leak_membership_across_execution_scope(
    test_db, permission_subject
):
    from app.services.capability_lookup import ExecutionCapabilityLookup
    from app.services.execution_permission_scope import execution_resource_scope
    from app.services.external_entity_resolver import entity_resolution_scope

    viewer, _, _, _ = permission_subject
    group = Namespace(name="dynamic-scope", owner_user_id=1, is_active=True)
    test_db.add(group)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Developer",
            status="approved",
        )
    )
    test_db.flush()
    lookup = ExecutionCapabilityLookup(test_db, viewer.id)
    with entity_resolution_scope(test_db):
        assert lookup.is_group_member(group.name)
        with execution_resource_scope():
            assert not lookup.is_group_member(group.name)
        assert lookup.is_group_member(group.name)


def test_batch_shell_targets_do_not_enumerate_unrelated_groups(test_db, scoped_target):
    from app.services.adapters.shell_utils import get_shells_by_owners_batch

    viewer, group, shell, _ = scoped_target
    key = (viewer.id, shell.name, group.name)
    assert get_shells_by_owners_batch(test_db, {key})[key] == shell


def test_child_group_details_keep_precise_roles_but_scope_candidates(
    test_db, scoped_target, permission_subject
):
    from app.services.group_service import get_child_groups

    viewer, _, _, _ = scoped_target
    parent = Namespace(name="visible-parent", owner_user_id=1, is_active=True)
    child = Namespace(name="visible-parent/explicit", owner_user_id=1, is_active=True)
    inherited = Namespace(
        name="visible-parent/inherited-only", owner_user_id=1, is_active=True
    )
    test_db.add_all([parent, child, inherited])
    test_db.flush()
    for namespace, role in [(parent, "Owner"), (child, "Reporter")]:
        test_db.add(
            ResourceMember(
                resource_type="Namespace",
                resource_id=namespace.id,
                entity_type="user",
                entity_id=str(viewer.id),
                role=role,
                status="approved",
            )
        )
    test_db.flush()
    result = get_child_groups(test_db, parent.name, viewer.id)
    assert [(row.name, row.my_role) for row in result] == [(child.name, "Reporter")]
    assert permission_subject[2].call_count == 0


@pytest.mark.parametrize("same_source", [False, True])
def test_candidate_selection_preserves_source_identity_and_fact_dependencies(
    test_db, scoped_target, same_source, permission_subject
):
    from fastapi import HTTPException

    from app.models.user import User
    from app.services.capability_lookup import ExecutionCapabilityLookup

    viewer, known_group, _, _ = scoped_target
    unknown_group = Namespace(name="aaa-candidate", owner_user_id=1, is_active=True)
    test_db.add(unknown_group)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=unknown_group.id,
            entity_type="directory_group",
            entity_id="D9",
            role="Reporter",
            status="approved",
        )
    )
    first = Kind(
        kind="Model",
        name="same-name",
        namespace="default",
        user_id=1,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(first)
    test_db.flush()
    second = first
    if not same_source:
        owner = User(
            user_name="other-model-owner", password_hash="unused", is_active=True
        )
        test_db.add(owner)
        test_db.flush()
        second = Kind(
            kind="Model",
            name=first.name,
            namespace="default",
            user_id=owner.id,
            is_active=True,
            json={"spec": {}},
        )
        test_db.add(second)
        test_db.flush()
    for source, group in [(first, unknown_group), (second, known_group)]:
        test_db.add(
            ResourceMember(
                resource_type="Model",
                resource_id=source.id,
                entity_type="namespace",
                entity_id=str(group.id),
                role="Reporter",
                status="approved",
            )
        )
    test_db.flush()
    lookup = ExecutionCapabilityLookup(test_db, viewer.id)
    if same_source:
        assert lookup.group_model(first.name) == first
    else:
        with pytest.raises(HTTPException) as failure:
            lookup.group_model(first.name)
        assert failure.value.status_code == 503
    assert permission_subject[2].call_count == 1


def test_cached_candidates_keep_execution_scope_isolation(test_db, permission_subject):
    from app.services.capability_lookup import ExecutionCapabilityLookup
    from app.services.execution_permission_scope import execution_resource_scope
    from app.services.external_entity_resolver import entity_resolution_scope

    viewer, _, _, _ = permission_subject
    group = Namespace(name="candidate-scope", owner_user_id=1, is_active=True)
    test_db.add(group)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Developer",
            status="approved",
        )
    )
    model = Kind(
        kind="Model",
        name="scoped-model",
        namespace=group.name,
        user_id=1,
        is_active=True,
        json={"spec": {}},
    )
    test_db.add(model)
    test_db.flush()
    lookup = ExecutionCapabilityLookup(test_db, viewer.id)
    with entity_resolution_scope(test_db):
        assert lookup.group_model(model.name) == model
        with execution_resource_scope():
            assert lookup.group_model(model.name) is None
        assert lookup.group_model(model.name) == model


def test_group_search_scopes_exact_role_metadata_to_matches(
    test_db, scoped_target, permission_subject
):
    from app.services.group_service import search_groups

    viewer, _, _, _ = scoped_target
    known = Namespace(name="search-known", owner_user_id=1, is_active=True)
    test_db.add(known)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=known.id,
            entity_type="user",
            entity_id=str(viewer.id),
            role="Owner",
            status="approved",
        )
    )
    test_db.flush()
    rows, total = search_groups(test_db, "search-known", user_id=viewer.id)
    assert total == 1
    assert [(row.name, row.my_role) for row in rows] == [(known.name, "Owner")]
    assert permission_subject[2].call_count == 0


def test_group_search_keeps_organization_admin_override(test_db, permission_subject):
    from app.services.group_service import search_groups

    viewer, _, _, _ = permission_subject
    organization = Namespace(
        name="search-organization",
        owner_user_id=1,
        is_active=True,
        level="organization",
    )
    test_db.add(organization)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=organization.id,
            entity_type="directory_group",
            entity_id="D999",
            role="Owner",
            status="approved",
        )
    )
    test_db.flush()
    rows, total = search_groups(
        test_db,
        organization.name,
        user_id=viewer.id,
        user_role="admin",
        include_organization=True,
    )
    assert total == 1
    assert rows[0].my_role == "Owner"
    assert permission_subject[2].call_count == 0


@pytest.mark.parametrize("native_exists", [False, True])
def test_explicit_shell_resolves_candidates_before_membership(
    test_db, permission_subject, native_exists
):
    from fastapi import HTTPException

    from app.services.adapters.shell_utils import get_shell_by_name

    viewer, _, directory, _ = permission_subject
    directory.return_value = None
    group = Namespace(name="missing-shell-group", owner_user_id=1, is_active=True)
    test_db.add(group)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=group.id,
            entity_type="directory_group",
            entity_id="D999",
            role="Reporter",
            status="approved",
        )
    )
    public = Kind(
        kind="Shell",
        name="public-fallback",
        namespace="default",
        user_id=0,
        is_active=True,
        json={"spec": {"shellType": "Chat"}},
    )
    test_db.add(public)
    if native_exists:
        test_db.add(
            Kind(
                kind="Shell",
                name=public.name,
                namespace=group.name,
                user_id=1,
                is_active=True,
                json={"spec": {"shellType": "Chat"}},
            )
        )
    test_db.flush()
    if native_exists:
        with pytest.raises(HTTPException) as failure:
            get_shell_by_name(test_db, public.name, viewer.id, group.name)
        assert failure.value.status_code == 503
    else:
        assert get_shell_by_name(test_db, public.name, viewer.id, group.name) == public
        assert directory.call_count == 0


@pytest.mark.parametrize("operation", ["update", "delete"])
def test_shell_mutation_uses_only_matching_native_candidates(
    test_db, scoped_target, operation
):
    from app.api.endpoints.adapter.shells import (
        ShellUpdateRequest,
        delete_shell,
        update_shell,
    )

    viewer, _, shell, _ = scoped_target
    shell.json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Shell",
        **shell.json,
        "status": {"state": "Available"},
    }
    test_db.flush()
    if operation == "update":
        result = update_shell(
            shell.name, ShellUpdateRequest(displayName="Updated"), test_db, viewer
        )
        assert result["displayName"] == "Updated"
    else:
        delete_shell(shell.name, test_db, viewer)
        assert test_db.get(Kind, shell.id) is None


def test_chat_kb_reference_ignores_unrelated_role_metadata(
    test_db, scoped_target, permission_subject
):
    from app.services.openapi.kb_resolver import resolve_knowledge_base_names

    viewer, _, _, _ = scoped_target
    library = test_db.get(Kind, permission_subject[1][0])
    library.user_id = viewer.id
    test_db.flush()
    result = resolve_knowledge_base_names(test_db, viewer.id, [{"id": library.id}])
    assert [item.kb_id for item in result.resolved] == [library.id]
    assert permission_subject[2].call_count == 1

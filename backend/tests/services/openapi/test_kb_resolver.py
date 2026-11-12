"""Knowledge references resolve through real native ACLs and document scopes."""

import pytest
from fastapi import HTTPException

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.resource_member import ResourceMember
from app.services.openapi.kb_resolver import (
    KnowledgeBaseNameResolver,
    KnowledgeBaseResolutionResult,
    ResolvedKnowledgeBase,
    resolve_knowledge_base_names,
)
from tests.permission_fixtures import permission_subject  # noqa: F401


@pytest.fixture
def references(test_db, permission_subject):
    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    libraries = [test_db.get(Kind, kb_id) for kb_id in ids[:4]]
    group = Namespace(name="resolver-group", owner_user_id=1, is_active=True)
    org = Namespace(
        name="resolver-org", owner_user_id=1, is_active=True, level="organization"
    )
    test_db.add_all([group, org])
    test_db.flush()
    test_db.query(ResourceMember).filter(
        ResourceMember.resource_type == "KnowledgeBase",
        ResourceMember.resource_id.in_(ids),
    ).delete(synchronize_session=False)
    libraries[0].user_id = viewer.id
    libraries[2].namespace = group.name
    libraries[3].namespace = org.name
    for resource_type, resource_id in [
        ("KnowledgeBase", libraries[1].id),
        ("Namespace", group.id),
    ]:
        test_db.add(
            ResourceMember(
                resource_type=resource_type,
                resource_id=resource_id,
                entity_type="user",
                entity_id=str(viewer.id),
                role="Reporter",
                status="approved",
            )
        )
    test_db.flush()
    return viewer, libraries, directory


@pytest.mark.parametrize("source", [0, 1, 2, 3])
@pytest.mark.parametrize("by_id", [False, True])
def test_resolve_personal_shared_group_and_organization(
    test_db, references, source, by_id
):
    viewer, libraries, directory = references
    kb = libraries[source]
    ref = (
        {"id": kb.id}
        if by_id
        else {"namespace": kb.namespace, "name": kb.json["spec"]["name"]}
    )
    result = resolve_knowledge_base_names(test_db, viewer.id, [ref])
    assert [(item.kb_id, item.namespace, item.name) for item in result.resolved] == [
        (kb.id, kb.namespace, kb.json["spec"]["name"])
    ]
    assert result.not_found == result.no_access == []
    assert directory.call_count == 0


def test_multiple_references_preserve_order_and_duplicates(test_db, references):
    viewer, libraries, _ = references
    ids = [libraries[i].id for i in [2, 0, 2, 3, 1]]
    result = KnowledgeBaseNameResolver(test_db, viewer.id).resolve(
        [{"id": kb_id} for kb_id in ids]
    )
    assert [item.kb_id for item in result.resolved] == ids


@pytest.mark.parametrize(
    "ref,status",
    [
        ({"name": ""}, 404),
        ({"id": "bad"}, 404),
        ({"id": -123}, 403),
        ({"namespace": "missing", "name": "private"}, 403),
    ],
)
def test_invalid_and_inaccessible_references_keep_error_contract(
    test_db, references, ref, status
):
    viewer, _, _ = references
    with pytest.raises(HTTPException) as failure:
        resolve_knowledge_base_names(test_db, viewer.id, [ref])
    assert failure.value.status_code == status


def test_partial_failure_returns_each_error_without_inventing_access(
    test_db, references
):
    viewer, libraries, _ = references
    result = resolve_knowledge_base_names(
        test_db,
        viewer.id,
        [{"id": libraries[0].id}, {"id": -1}, {"name": ""}],
        raise_on_error=False,
    )
    assert [item.kb_id for item in result.resolved] == [libraries[0].id]
    assert result.no_access == [{"id": -1}]
    assert result.not_found == [{"name": ""}]


def test_group_membership_removal_revokes_named_reference(test_db, references):
    viewer, libraries, _ = references
    test_db.query(ResourceMember).filter_by(
        resource_type="Namespace", entity_id=str(viewer.id)
    ).delete()
    test_db.commit()
    with pytest.raises(HTTPException) as failure:
        resolve_knowledge_base_names(test_db, viewer.id, [{"id": libraries[2].id}])
    assert failure.value.status_code == 403


def test_folder_only_scope_uses_real_root_documents(test_db, references):
    viewer, libraries, _ = references
    kb = libraries[0]
    document = KnowledgeDocument(
        kind_id=kb.id,
        user_id=viewer.id,
        name="root",
        folder_id=0,
        file_extension="txt",
        status="enabled",
        is_active=True,
    )
    test_db.add(document)
    test_db.flush()
    result = resolve_knowledge_base_names(
        test_db,
        viewer.id,
        [
            {
                "id": kb.id,
                "scope_specified": True,
                "folder_ids": [0],
                "document_ids": [],
                "include_subfolders": True,
            }
        ],
    )
    assert result.resolved[0].resolved_document_ids == [document.id]
    assert result.resolved[0].scope_restricted
    assert result.resolved[0].folder_ids == [0]
    assert result.resolved[0].explicit_document_ids == []


def test_empty_reference_list_returns_empty_without_queries(test_db, references):
    from tests.permission_fixtures import sql_count

    viewer, _, _ = references
    with sql_count(test_db) as statements:
        result = resolve_knowledge_base_names(test_db, viewer.id, [])
    assert result == KnowledgeBaseResolutionResult([], [], [])
    assert not statements


def test_result_fields():
    item = ResolvedKnowledgeBase(1, "default", "kb1", "KB1")
    result = KnowledgeBaseResolutionResult(
        [item], [{"name": "missing"}], [{"name": "private"}]
    )
    assert item.kb_id == 1
    assert item.namespace == "default"
    assert item.name == "kb1"
    assert item.display_name == "KB1"
    assert result.resolved == [item]
    assert result.not_found == [{"name": "missing"}]
    assert result.no_access == [{"name": "private"}]


def test_named_reference_keeps_shared_after_personal_priority(test_db, references):
    from datetime import datetime

    viewer, libraries, _ = references
    personal, shared = libraries[:2]
    personal.json = {
        "spec": {"name": "Same display", "directAccessRequirement": "read"}
    }
    shared.json = {"spec": {"name": "Same display", "directAccessRequirement": "read"}}
    personal.updated_at = datetime(2020, 1, 1)
    shared.updated_at = datetime(2026, 1, 1)
    test_db.flush()
    result = resolve_knowledge_base_names(
        test_db, viewer.id, [{"namespace": "default", "name": "Same display"}]
    )
    assert [item.kb_id for item in result.resolved] == [shared.id]

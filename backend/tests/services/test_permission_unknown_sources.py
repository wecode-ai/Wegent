"""Resource actions combine independent and correlated authorization sources."""

from app.models.resource_member import ResourceMember
from app.services.share.team_share_service import TeamShareService
from tests.permission_fixtures import permission_subject  # noqa: F401
from tests.services.test_group_action_consumers_unknown import (  # noqa: F401
    action_resources,
)


def test_group_read_survives_unknown_team_share(test_db, action_resources):
    viewer, _, team, _ = action_resources
    test_db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    assert TeamShareService().get_resource(test_db, team.id, viewer.id) == team


def test_owner_can_add_member_despite_unknown_share(test_db, action_resources):
    from app.schemas.share import MemberRole

    viewer, _, team, _ = action_resources
    team.user_id = viewer.id
    test_db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Owner",
            status="approved",
        )
    )
    test_db.flush()
    result = TeamShareService().add_member(
        test_db, team.id, viewer.id, 1, MemberRole.Reporter
    )
    assert result.entity_id == "1"


def test_kb_document_edit_does_not_require_exact_role(test_db, permission_subject):
    from app.services.knowledge.knowledge_service import KnowledgeService

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    test_db.query(ResourceMember).filter_by(
        resource_type="KnowledgeBase", resource_id=ids[0], entity_type="directory_group"
    ).update({"role": "Maintainer"})
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=ids[0],
            entity_type="user",
            entity_id=str(viewer.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.flush()
    assert KnowledgeService.can_manage_knowledge_base_documents(
        test_db, ids[0], viewer.id
    )


def test_kb_member_list_uses_read_action(test_db, permission_subject):
    from app.services.share.knowledge_share_service import knowledge_share_service

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    test_db.query(ResourceMember).filter_by(
        resource_type="KnowledgeBase", resource_id=ids[0], entity_type="directory_group"
    ).update({"role": "Maintainer"})
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=ids[0],
            entity_type="user",
            entity_id=str(viewer.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.flush()
    assert knowledge_share_service.get_members(test_db, ids[0], viewer.id).total == 2


import pytest


@pytest.fixture
def kb_editor(test_db, permission_subject):
    from app.models.kind import Kind

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    test_db.query(ResourceMember).filter_by(
        resource_type="KnowledgeBase", resource_id=ids[0], entity_type="directory_group"
    ).update({"role": "Maintainer"})
    test_db.add(
        ResourceMember(
            resource_type="KnowledgeBase",
            resource_id=ids[0],
            entity_type="user",
            entity_id=str(viewer.id),
            role="Developer",
            status="approved",
        )
    )
    test_db.flush()
    return viewer, test_db.get(Kind, ids[0])


def test_folder_move_uses_document_action(test_db, kb_editor):
    from app.models.knowledge import KnowledgeDocument
    from app.services.knowledge.folder_service import KnowledgeFolderService

    viewer, kb = kb_editor
    document = KnowledgeDocument(
        kind_id=kb.id,
        user_id=1,
        name="movable",
        file_extension="txt",
        source_type="text",
        status="enabled",
        is_active=True,
    )
    test_db.add(document)
    test_db.flush()
    result = KnowledgeFolderService.batch_move_documents(
        test_db, [document.id], 0, viewer.id
    )
    assert result.success_count == 1
    assert result.failed_ids == []


@pytest.mark.asyncio
async def test_wiki_edit_gate_does_not_require_exact_role(test_db, kb_editor):
    from fastapi import HTTPException

    from app.api.endpoints.external_wiki import delete_kb_binding

    viewer, kb = kb_editor
    with pytest.raises(HTTPException) as failure:
        await delete_kb_binding(kb.id, -1, db=test_db, current_user=viewer)
    # Authorization succeeds; the nonexistent binding retains its normal error.
    assert failure.value.status_code == 400


@pytest.mark.parametrize(
    "required,expected",
    [("Reporter", True), ("Developer", True), ("Maintainer", None), ("Owner", False)],
)
def test_shared_actions_project_thresholds(
    test_db, action_resources, required, expected
):
    from fastapi import HTTPException

    from app.schemas.share import MemberRole

    viewer, _, team, _ = action_resources
    test_db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    if expected is None:
        with pytest.raises(HTTPException) as failure:
            TeamShareService().check_permission(
                test_db, team.id, viewer.id, MemberRole(required)
            )
        assert failure.value.status_code == 503
    else:
        assert (
            TeamShareService().check_permission(
                test_db, team.id, viewer.id, MemberRole(required)
            )
            is expected
        )


def test_team_sources_share_one_department_fact(test_db, action_resources):
    from app.models.namespace import Namespace

    viewer, child, team, _ = action_resources
    parent = Namespace(name="source-parent", owner_user_id=1, is_active=True)
    test_db.add(parent)
    test_db.flush()
    child.name = parent.name + "/child"
    team.namespace = child.name
    for member in (
        test_db.query(ResourceMember)
        .filter_by(resource_type="Namespace", resource_id=child.id)
        .all()
    ):
        if member.entity_type == "user":
            member.resource_id = parent.id
        else:
            member.role = "RestrictedAnalyst"
    test_db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    assert TeamShareService().get_resource(test_db, team.id, viewer.id) == team


def test_native_management_remains_after_share_removal(
    test_db, action_resources, permission_subject
):
    from app.models.user import User
    from app.schemas.share import MemberRole

    viewer, group, team, _ = action_resources
    test_db.query(ResourceMember).filter_by(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="user",
        entity_id=str(viewer.id),
    ).update({"role": "Maintainer"})
    target = User(user_name="removal-target", password_hash="unused", is_active=True)
    test_db.add(target)
    test_db.flush()
    member = ResourceMember(
        resource_type="Team",
        resource_id=team.id,
        entity_type="user",
        entity_id=str(target.id),
        role="Reporter",
        status="approved",
    )
    test_db.add(member)
    test_db.flush()
    assert TeamShareService().remove_member(test_db, team.id, member.id, viewer.id)
    assert permission_subject[2].call_count == 1


def test_explicit_kb_denial_is_not_lifted_by_unknown_grants(test_db, kb_editor):
    from fastapi import HTTPException

    from app.services.knowledge.knowledge_service import KnowledgeService
    from app.services.share.knowledge_share_service import knowledge_share_service

    viewer, kb = kb_editor
    test_db.query(ResourceMember).filter_by(
        resource_type="KnowledgeBase",
        resource_id=kb.id,
        entity_type="user",
        entity_id=str(viewer.id),
    ).update({"role": "RestrictedAnalyst"})
    test_db.flush()
    assert not KnowledgeService.can_manage_knowledge_base_documents(
        test_db, kb.id, viewer.id
    )
    with pytest.raises(HTTPException) as failure:
        knowledge_share_service.get_members(test_db, kb.id, viewer.id)
    assert failure.value.status_code == 404


def test_precise_kb_role_remains_unknown(test_db, kb_editor):
    from fastapi import HTTPException

    from app.services.share.knowledge_share_service import knowledge_share_service

    viewer, kb = kb_editor
    with pytest.raises(HTTPException) as failure:
        knowledge_share_service.get_my_permission(test_db, kb.id, viewer.id)
    assert failure.value.status_code == 503


def test_new_share_request_sees_revocation(
    test_db, action_resources, permission_subject
):
    from fastapi import HTTPException

    viewer, group, team, _ = action_resources
    assert TeamShareService().get_resource(test_db, team.id, viewer.id) == team
    test_db.query(ResourceMember).filter_by(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="user",
        entity_id=str(viewer.id),
    ).delete(synchronize_session=False)
    test_db.commit()
    with pytest.raises(HTTPException) as failure:
        TeamShareService().get_resource(test_db, team.id, viewer.id)
    assert failure.value.status_code == 503
    assert permission_subject[2].call_count == 2


def test_database_failure_is_not_an_authorization_unknown(test_db, action_resources):
    from sqlalchemy.exc import IntegrityError, PendingRollbackError

    from app.models.user import User

    viewer, _, team, _ = action_resources
    viewer_id, team_id = viewer.id, team.id
    try:
        test_db.add(
            User(
                id=viewer_id,
                user_name="duplicate-identity",
                password_hash="unused",
                is_active=True,
            )
        )
        with pytest.raises(IntegrityError):
            test_db.flush()
        with pytest.raises(PendingRollbackError):
            TeamShareService().get_resource(test_db, team_id, viewer_id)
    finally:
        test_db.rollback()


def test_creator_exact_kb_role_is_independent_of_lower_group_role(
    test_db, action_resources, permission_subject
):
    from app.models.kind import Kind
    from app.services.share.knowledge_share_service import knowledge_share_service

    viewer, group, _, _ = action_resources
    library = test_db.get(Kind, permission_subject[1][0])
    library.user_id = viewer.id
    library.namespace = group.name
    test_db.flush()
    result = knowledge_share_service.get_my_permission(test_db, library.id, viewer.id)
    assert result.has_access
    assert result.role.value == "Owner"


@pytest.mark.parametrize("size", [1, 12])
def test_batch_folder_permissions_reuse_actor_facts(
    test_db, permission_subject, size, record_property
):
    from app.models.knowledge import KnowledgeDocument
    from app.services.knowledge.folder_service import KnowledgeFolderService
    from tests.permission_fixtures import sql_count

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    documents = []
    for kb_id in ids[:size]:
        test_db.query(ResourceMember).filter_by(
            resource_type="KnowledgeBase",
            resource_id=kb_id,
            entity_type="directory_group",
        ).update({"role": "Maintainer"})
        test_db.add(
            ResourceMember(
                resource_type="KnowledgeBase",
                resource_id=kb_id,
                entity_type="user",
                entity_id=str(viewer.id),
                role="Developer",
                status="approved",
            )
        )
        doc = KnowledgeDocument(
            kind_id=kb_id,
            user_id=1,
            name="batch-source",
            file_extension="txt",
            source_type="text",
            status="enabled",
            is_active=True,
        )
        test_db.add(doc)
        documents.append(doc)
    test_db.flush()
    with sql_count(test_db) as statements:
        result = KnowledgeFolderService.batch_move_documents(
            test_db, [doc.id for doc in documents], 0, viewer.id
        )
    record_property("total_sql", len(statements))
    record_property(
        "member_sql", sum("resource_members" in sql.lower() for sql in statements)
    )
    record_property("directory_calls", directory.call_count)
    assert result.success_count == size
    assert directory.call_count == 1
    assert sum("resource_members" in sql.lower() for sql in statements) <= 4


def test_irrelevant_low_entity_grants_do_not_query_directory(
    test_db, action_resources, permission_subject
):
    from app.schemas.share import MemberRole

    viewer, _, team, _ = action_resources
    team.namespace = "default"
    test_db.add(
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Reporter",
            status="approved",
        )
    )
    test_db.flush()
    assert not TeamShareService().check_permission(
        test_db, team.id, viewer.id, MemberRole.Owner
    )
    assert permission_subject[2].call_count == 0


@pytest.mark.parametrize("reverse", [False, True])
def test_entity_source_order_does_not_hide_confirmed_management(
    test_db, action_resources, permission_subject, reverse
):
    from app.models.namespace import Namespace
    from app.schemas.share import MemberRole

    viewer, _, team, _ = action_resources
    related = Namespace(name="confirmed-share", owner_user_id=1, is_active=True)
    test_db.add(related)
    test_db.flush()
    test_db.add(
        ResourceMember(
            resource_type="Namespace",
            resource_id=related.id,
            entity_type="user",
            entity_id=str(viewer.id),
            role="Reporter",
            status="approved",
        )
    )
    rows = [
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="directory_group",
            entity_id="D0",
            role="Owner",
            status="approved",
        ),
        ResourceMember(
            resource_type="Team",
            resource_id=team.id,
            entity_type="namespace",
            entity_id=str(related.id),
            role="Maintainer",
            status="approved",
        ),
    ]
    test_db.add_all(list(reversed(rows)) if reverse else rows)
    test_db.flush()
    assert TeamShareService().check_permission(
        test_db, team.id, viewer.id, MemberRole.Maintainer
    )
    assert permission_subject[2].call_count <= 1


def test_precise_permission_sources_remain_unknown_for_creator(
    test_db, permission_subject
):
    from fastapi import HTTPException

    from app.models.kind import Kind
    from app.services.share.knowledge_share_service import knowledge_share_service

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    library = test_db.get(Kind, ids[0])
    library.user_id = viewer.id
    test_db.flush()
    with pytest.raises(HTTPException) as failure:
        knowledge_share_service.get_my_permission_sources(
            test_db, library.id, viewer.id
        )
    assert failure.value.status_code == 503


def test_kb_target_actions_skip_unrelated_group_facts(test_db, permission_subject):
    from app.models.kind import Kind
    from app.models.knowledge import KnowledgeDocument
    from app.models.namespace import Namespace
    from app.services.knowledge.folder_service import KnowledgeFolderService

    viewer, ids, directory, _ = permission_subject
    directory.return_value = None
    known = Namespace(name="bounded-known", owner_user_id=1, is_active=True)
    unrelated = Namespace(name="bounded-unrelated", owner_user_id=1, is_active=True)
    test_db.add_all([known, unrelated])
    test_db.flush()
    test_db.add_all(
        [
            ResourceMember(
                resource_type="Namespace",
                resource_id=known.id,
                entity_type="user",
                entity_id=str(viewer.id),
                role="Developer",
                status="approved",
            ),
            ResourceMember(
                resource_type="Namespace",
                resource_id=unrelated.id,
                entity_type="directory_group",
                entity_id="D999",
                role="Owner",
                status="approved",
            ),
        ]
    )
    library = test_db.get(Kind, ids[0])
    library.namespace = known.name
    test_db.query(ResourceMember).filter_by(
        resource_type="KnowledgeBase", resource_id=library.id
    ).delete()
    source = KnowledgeDocument(
        kind_id=library.id,
        user_id=1,
        name="bounded-source",
        file_extension="txt",
        source_type="text",
        status="enabled",
        is_active=True,
    )
    test_db.add(source)
    test_db.flush()
    result = KnowledgeFolderService.batch_move_documents(
        test_db, [source.id], 0, viewer.id
    )
    assert result.success_count == 1
    assert directory.call_count == 0


def test_team_execution_uses_guest_threshold_for_whole_action(
    test_db, action_resources
):
    from fastapi import HTTPException

    viewer, group, team, _ = action_resources
    test_db.query(ResourceMember).filter_by(
        resource_type="Namespace",
        resource_id=group.id,
        entity_type="user",
        entity_id=str(viewer.id),
    ).update({"role": "RestrictedAnalyst"})
    test_db.flush()
    service = TeamShareService()
    assert service.get_resource_for_use(test_db, team.id, viewer.id) == team
    with pytest.raises(HTTPException) as failure:
        service.get_resource(test_db, team.id, viewer.id)
    assert failure.value.status_code == 503

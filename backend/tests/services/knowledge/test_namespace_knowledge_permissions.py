# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.knowledge import KnowledgeFolder
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.user import User
from app.schemas.knowledge import (
    DocumentSourceType,
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
    KnowledgeFolderCreate,
    ResourceScope,
)
from app.schemas.namespace import GroupRole
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.share import knowledge_share_service


def _create_user(test_db: Session, username: str, role: str = "user") -> User:
    user = User(
        user_name=username,
        password_hash=get_password_hash(f"{username}-secret"),
        email=f"{username}@example.com",
        is_active=True,
        git_info=None,
        role=role,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


def _create_namespace(
    test_db: Session,
    owner: User,
    name: str,
    level: str = "group",
) -> Namespace:
    namespace = Namespace(
        name=name,
        display_name=name,
        owner_user_id=owner.id,
        visibility="internal",
        description="test namespace",
        level=level,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


def _add_member(
    test_db: Session,
    namespace: Namespace,
    user: User,
    role: GroupRole,
    invited_by_user_id: int,
) -> ResourceMember:
    member = ResourceMember(
        resource_type="Namespace",
        resource_id=namespace.id,
        entity_type="user",
        entity_id=str(user.id),
        role=role.value,
        status=MemberStatus.APPROVED.value,
        invited_by_user_id=invited_by_user_id,
        share_link_id=0,
        reviewed_by_user_id=invited_by_user_id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


def _get_kind(test_db: Session, knowledge_base_id: int) -> Kind:
    kb = (
        test_db.query(Kind)
        .filter(Kind.id == knowledge_base_id, Kind.kind == "KnowledgeBase")
        .first()
    )
    assert kb is not None
    return kb


def _add_kb_member(
    test_db: Session,
    knowledge_base_id: int,
    user: User,
    role: ResourceRole,
    invited_by_user_id: int,
    status: str = MemberStatus.APPROVED.value,
) -> ResourceMember:
    member = ResourceMember(
        resource_type="KnowledgeBase",
        resource_id=knowledge_base_id,
        entity_type="user",
        entity_id=str(user.id),
        role=role.value,
        status=status,
        invited_by_user_id=invited_by_user_id,
        share_link_id=0,
        reviewed_by_user_id=invited_by_user_id,
        copied_resource_id=0,
    )
    test_db.add(member)
    test_db.commit()
    test_db.refresh(member)
    return member


@pytest.mark.unit
def test_developer_can_create_group_knowledge_base(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    developer = _create_user(test_db, "developer")
    namespace = _create_namespace(test_db, owner, "group-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        developer.id,
        KnowledgeBaseCreate(name="dev-kb", namespace=namespace.name),
    )

    kb = _get_kind(test_db, knowledge_base_id)
    assert kb.user_id == developer.id
    assert kb.namespace == namespace.name


@pytest.mark.unit
def test_developer_can_create_organization_knowledge_base(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    developer = _create_user(test_db, "developer")
    namespace = _create_namespace(test_db, owner, "company-space", level="organization")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        developer.id,
        KnowledgeBaseCreate(name="company-kb", namespace=namespace.name),
    )

    kb = _get_kind(test_db, knowledge_base_id)
    assert kb.user_id == developer.id
    assert kb.namespace == namespace.name


@pytest.mark.unit
def test_all_scope_does_not_duplicate_organization_knowledge_base(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "org-owner")
    developer = _create_user(test_db, "org-developer")
    namespace = _create_namespace(test_db, owner, "company-space", level="organization")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="company-kb", namespace=namespace.name),
    )

    knowledge_bases = KnowledgeService.list_knowledge_bases(
        test_db,
        developer.id,
        ResourceScope.ALL,
    )

    matching_ids = [kb.id for kb in knowledge_bases if kb.id == knowledge_base_id]
    assert matching_ids == [knowledge_base_id]


@pytest.mark.unit
def test_explicitly_shared_organization_kb_stays_in_organization_grouping(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "org-share-owner")
    recipient = _create_user(test_db, "org-share-recipient")
    namespace = _create_namespace(
        test_db, owner, "org-shared-space", level="organization"
    )
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="org-shared-kb", namespace=namespace.name),
    )
    _add_kb_member(
        test_db,
        knowledge_base_id,
        recipient,
        ResourceRole.Developer,
        owner.id,
    )

    grouped = KnowledgeService.get_all_knowledge_bases_grouped(test_db, recipient.id)

    assert knowledge_base_id not in {kb.id for kb in grouped.personal.shared_with_me}
    org_kb = next(
        kb for kb in grouped.organization.knowledge_bases if kb.id == knowledge_base_id
    )
    assert org_kb.group_type == "organization"
    assert org_kb.my_role == ResourceRole.Developer.value


@pytest.mark.unit
def test_grouped_organization_kbs_resolve_role_per_namespace(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "org-role-owner")
    recipient = _create_user(test_db, "org-role-recipient")
    first_namespace = _create_namespace(
        test_db, owner, "org-role-space-a", level="organization"
    )
    second_namespace = _create_namespace(
        test_db, owner, "org-role-space-b", level="organization"
    )
    _add_member(test_db, first_namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, second_namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, first_namespace, recipient, GroupRole.Developer, owner.id)
    _add_member(test_db, second_namespace, recipient, GroupRole.Maintainer, owner.id)

    first_kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="org-role-kb-a", namespace=first_namespace.name),
    )
    second_kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="org-role-kb-b", namespace=second_namespace.name),
    )

    grouped = KnowledgeService.get_all_knowledge_bases_grouped(test_db, recipient.id)
    org_kbs = {kb.id: kb for kb in grouped.organization.knowledge_bases}

    assert org_kbs[first_kb_id].my_role == ResourceRole.Developer.value
    assert org_kbs[second_kb_id].my_role == ResourceRole.Maintainer.value


@pytest.mark.unit
def test_grouped_organization_kbs_do_not_also_appear_in_groups(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "org-groups-owner")
    member = _create_user(test_db, "org-groups-member")
    namespace = _create_namespace(
        test_db, owner, "org-groups-space", level="organization"
    )
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, member, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="org-groups-kb", namespace=namespace.name),
    )

    grouped = KnowledgeService.get_all_knowledge_bases_grouped(test_db, member.id)

    assert knowledge_base_id in {kb.id for kb in grouped.organization.knowledge_bases}
    assert knowledge_base_id not in {
        kb.id for group in grouped.groups for kb in group.knowledge_bases
    }


@pytest.mark.unit
def test_personal_grouped_excludes_shared_organization_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "personal-org-owner")
    recipient = _create_user(test_db, "personal-org-recipient")
    namespace = _create_namespace(
        test_db, owner, "personal-org-space", level="organization"
    )
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="personal-org-kb", namespace=namespace.name),
    )
    _add_kb_member(
        test_db,
        knowledge_base_id,
        recipient,
        ResourceRole.Developer,
        owner.id,
    )

    grouped = KnowledgeService.get_personal_knowledge_bases_grouped(
        test_db, recipient.id
    )

    assert knowledge_base_id not in {kb.id for kb in grouped["shared_with_me"]}


@pytest.mark.unit
def test_developer_cannot_update_someone_elses_namespace_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    developer = _create_user(test_db, "developer")
    namespace = _create_namespace(test_db, owner, "shared-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="owner-kb", namespace=namespace.name),
    )

    with pytest.raises(ValueError, match="permission"):
        KnowledgeService.update_knowledge_base(
            test_db,
            knowledge_base_id,
            developer.id,
            KnowledgeBaseUpdate(description="developer cannot edit this"),
        )


@pytest.mark.unit
def test_maintainer_can_delete_someone_elses_namespace_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    maintainer = _create_user(test_db, "maintainer")
    namespace = _create_namespace(test_db, owner, "team-delete-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, maintainer, GroupRole.Maintainer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="owner-kb", namespace=namespace.name),
    )

    assert KnowledgeService.delete_knowledge_base(
        test_db, knowledge_base_id, maintainer.id
    )


@pytest.mark.unit
def test_developer_can_add_document_to_owned_namespace_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "owner")
    developer = _create_user(test_db, "developer")
    namespace = _create_namespace(test_db, owner, "docs-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        developer.id,
        KnowledgeBaseCreate(name="owned-kb", namespace=namespace.name),
    )

    document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        developer.id,
        KnowledgeDocumentCreate(
            name="release-notes",
            file_extension="md",
            file_size=12,
            source_type=DocumentSourceType.TEXT,
        ),
    )

    assert document.kind_id == knowledge_base_id
    assert document.user_id == developer.id


@pytest.mark.unit
def test_developer_can_add_document_to_someone_elses_namespace_kb(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-upload-other")
    developer = _create_user(test_db, "developer-upload-other")
    namespace = _create_namespace(test_db, owner, "docs-shared-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-kb", namespace=namespace.name),
    )

    document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        developer.id,
        KnowledgeDocumentCreate(
            name="developer-upload",
            file_extension="md",
            file_size=24,
            source_type=DocumentSourceType.TEXT,
        ),
    )

    assert document.kind_id == knowledge_base_id
    assert document.user_id == developer.id


@pytest.mark.unit
def test_developer_cannot_delete_someone_elses_namespace_document(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-delete-other-doc")
    developer = _create_user(test_db, "developer-delete-other-doc")
    namespace = _create_namespace(test_db, owner, "docs-delete-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-kb", namespace=namespace.name),
    )
    owner_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        owner.id,
        KnowledgeDocumentCreate(
            name="owner-doc",
            file_extension="md",
            file_size=32,
            source_type=DocumentSourceType.TEXT,
        ),
    )

    with pytest.raises(ValueError, match="permission"):
        KnowledgeService.delete_document(test_db, owner_document.id, developer.id)


@pytest.mark.unit
def test_developer_can_delete_own_namespace_document_in_shared_kb(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-delete-own-doc")
    developer = _create_user(test_db, "developer-delete-own-doc")
    namespace = _create_namespace(test_db, owner, "docs-delete-own-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-kb", namespace=namespace.name),
    )
    developer_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        developer.id,
        KnowledgeDocumentCreate(
            name="developer-doc",
            file_extension="md",
            file_size=28,
            source_type=DocumentSourceType.TEXT,
        ),
    )

    result = KnowledgeService.delete_document(
        test_db, developer_document.id, developer.id
    )

    assert result.success is True
    assert result.kb_id == knowledge_base_id


@pytest.mark.unit
def test_explicit_kb_maintainer_can_manage_group_kb_without_namespace_membership(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner")
    collaborator = _create_user(test_db, "kb-maintainer")
    namespace = _create_namespace(test_db, owner, "kb-shared-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-kb", namespace=namespace.name),
    )
    _add_kb_member(
        test_db,
        knowledge_base_id,
        collaborator,
        ResourceRole.Maintainer,
        owner.id,
    )

    assert KnowledgeService.can_manage_knowledge_base(
        test_db, knowledge_base_id, collaborator.id
    )

    updated = KnowledgeService.update_knowledge_base(
        test_db,
        knowledge_base_id,
        collaborator.id,
        KnowledgeBaseUpdate(description="updated by explicit maintainer"),
    )
    assert updated is not None
    assert updated.json["spec"]["description"] == "updated by explicit maintainer"

    document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        collaborator.id,
        KnowledgeDocumentCreate(
            name="kb-maintainer-doc",
            file_extension="md",
            file_size=16,
            source_type=DocumentSourceType.TEXT,
        ),
    )
    assert document.kind_id == knowledge_base_id
    assert document.user_id == collaborator.id


@pytest.mark.unit
def test_explicit_kb_developer_cannot_manage_group_kb_owned_by_others(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner")
    collaborator = _create_user(test_db, "kb-developer")
    namespace = _create_namespace(test_db, owner, "kb-dev-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-kb", namespace=namespace.name),
    )
    _add_kb_member(
        test_db,
        knowledge_base_id,
        collaborator,
        ResourceRole.Developer,
        owner.id,
    )

    assert not KnowledgeService.can_manage_knowledge_base(
        test_db, knowledge_base_id, collaborator.id
    )

    with pytest.raises(ValueError, match="permission"):
        KnowledgeService.update_knowledge_base(
            test_db,
            knowledge_base_id,
            collaborator.id,
            KnowledgeBaseUpdate(description="developer should not edit kb settings"),
        )


@pytest.mark.unit
def test_explicit_kb_developer_can_add_document_to_shared_kb(test_db: Session) -> None:
    owner = _create_user(test_db, "owner-kb-dev-upload")
    collaborator = _create_user(test_db, "kb-developer-upload")
    namespace = _create_namespace(test_db, owner, "kb-dev-upload-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-kb", namespace=namespace.name),
    )
    _add_kb_member(
        test_db,
        knowledge_base_id,
        collaborator,
        ResourceRole.Developer,
        owner.id,
    )

    document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        collaborator.id,
        KnowledgeDocumentCreate(
            name="kb-dev-doc",
            file_extension="md",
            file_size=18,
            source_type=DocumentSourceType.TEXT,
        ),
    )

    assert document.kind_id == knowledge_base_id
    assert document.user_id == collaborator.id


@pytest.mark.unit
def test_explicit_kb_developer_can_delete_own_document_but_not_others(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-kb-dev-doc-delete")
    collaborator = _create_user(test_db, "kb-developer-doc-delete")
    namespace = _create_namespace(test_db, owner, "kb-dev-doc-delete-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-kb", namespace=namespace.name),
    )
    _add_kb_member(
        test_db,
        knowledge_base_id,
        collaborator,
        ResourceRole.Developer,
        owner.id,
    )

    owner_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        owner.id,
        KnowledgeDocumentCreate(
            name="owner-doc",
            file_extension="md",
            file_size=18,
            source_type=DocumentSourceType.TEXT,
        ),
    )
    collaborator_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        collaborator.id,
        KnowledgeDocumentCreate(
            name="collaborator-doc",
            file_extension="md",
            file_size=20,
            source_type=DocumentSourceType.TEXT,
        ),
    )

    with pytest.raises(ValueError, match="permission"):
        KnowledgeService.delete_document(test_db, owner_document.id, collaborator.id)

    result = KnowledgeService.delete_document(
        test_db, collaborator_document.id, collaborator.id
    )
    assert result.success is True


@pytest.mark.unit
def test_admin_can_manage_organization_knowledge_base_without_namespace_membership(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-org-admin")
    admin = _create_user(test_db, "admin-org-kb", role="admin")
    namespace = _create_namespace(
        test_db, owner, "admin-org-kb-space", level="organization"
    )
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="admin-managed-org-kb", namespace=namespace.name),
    )
    owner_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        owner.id,
        KnowledgeDocumentCreate(
            name="owner-doc-for-org-admin",
            file_extension="md",
            file_size=21,
            source_type=DocumentSourceType.TEXT,
        ),
    )

    assert KnowledgeService.can_manage_knowledge_base(
        test_db, knowledge_base_id, admin.id
    )
    assert KnowledgeService.can_manage_knowledge_base_documents(
        test_db, knowledge_base_id, admin.id
    )
    assert KnowledgeService.can_manage_knowledge_document(
        test_db, knowledge_base_id, admin.id, owner_document.user_id
    )

    updated = KnowledgeService.update_knowledge_base(
        test_db,
        knowledge_base_id,
        admin.id,
        KnowledgeBaseUpdate(description="updated by admin"),
    )
    assert updated is not None
    assert updated.json["spec"]["description"] == "updated by admin"

    admin_document = KnowledgeService.create_document(
        test_db,
        knowledge_base_id,
        admin.id,
        KnowledgeDocumentCreate(
            name="admin-uploaded-doc",
            file_extension="md",
            file_size=23,
            source_type=DocumentSourceType.TEXT,
        ),
    )
    assert admin_document.user_id == admin.id

    delete_result = KnowledgeService.delete_document(
        test_db, owner_document.id, admin.id
    )
    assert delete_result.success is True


@pytest.mark.unit
def test_org_admin_share_permission_matches_manage_permission(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "org-share-owner-admin")
    admin = _create_user(test_db, "org-share-admin", role="admin")
    namespace = _create_namespace(
        test_db, owner, "org-share-admin-space", level="organization"
    )
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="org-share-admin-kb", namespace=namespace.name),
    )

    assert knowledge_share_service.can_manage_permissions(
        test_db, knowledge_base_id, admin.id
    )

    my_permission = knowledge_share_service.get_my_permission(
        test_db, knowledge_base_id, admin.id
    )

    assert my_permission.has_access is True
    assert my_permission.is_creator is False
    assert my_permission.role == ResourceRole.Owner


@pytest.mark.unit
def test_admin_cannot_manage_regular_group_knowledge_base_without_membership(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-group-admin")
    admin = _create_user(test_db, "admin-group-kb", role="admin")
    namespace = _create_namespace(test_db, owner, "admin-kb-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="admin-managed-kb", namespace=namespace.name),
    )

    assert not KnowledgeService.can_manage_knowledge_base(
        test_db, knowledge_base_id, admin.id
    )
    assert not KnowledgeService.can_manage_knowledge_base_documents(
        test_db, knowledge_base_id, admin.id
    )
    assert not KnowledgeService.can_manage_knowledge_document(
        test_db, knowledge_base_id, admin.id, owner.id
    )

    assert (
        KnowledgeService.update_knowledge_base(
            test_db,
            knowledge_base_id,
            admin.id,
            KnowledgeBaseUpdate(description="updated by admin"),
        )
        is None
    )


@pytest.mark.unit
def test_namespace_maintainer_can_review_group_kb_pending_requests(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-pending-review")
    maintainer = _create_user(test_db, "maintainer-pending-review")
    requester = _create_user(test_db, "requester-pending-review")
    namespace = _create_namespace(test_db, owner, "pending-review-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, namespace, maintainer, GroupRole.Maintainer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="pending-review-kb", namespace=namespace.name),
    )
    _add_kb_member(
        test_db,
        knowledge_base_id,
        requester,
        ResourceRole.Reporter,
        owner.id,
        status=MemberStatus.PENDING.value,
    )

    assert knowledge_share_service.check_permission(
        test_db, knowledge_base_id, maintainer.id, ResourceRole.Maintainer
    )

    pending_requests = knowledge_share_service.get_pending_requests(
        test_db, knowledge_base_id, maintainer.id
    )
    assert pending_requests.total == 1
    assert pending_requests.requests[0].user_id == requester.id


@pytest.mark.unit
def test_owner_can_migrate_personal_knowledge_base_to_group(
    test_db: Session,
) -> None:
    owner = _create_user(test_db, "owner-kb-migrate")
    namespace = _create_namespace(test_db, owner, "migrate-target-space")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="migrate-me", namespace="default"),
    )

    result = KnowledgeService.migrate_knowledge_base_to_group(
        test_db,
        knowledge_base_id,
        owner.id,
        namespace.name,
    )

    migrated_kb = _get_kind(test_db, knowledge_base_id)
    assert result["success"] is True
    assert result["new_namespace"] == namespace.name
    assert migrated_kb.namespace == namespace.name


@pytest.mark.unit
def test_namespace_display_name_syncs_after_rename(test_db: Session) -> None:
    """KB permission tab should show the latest namespace name, not stale snapshot."""
    from app.schemas.share import MemberRole

    owner = _create_user(test_db, "ns-rename-owner")
    namespace = _create_namespace(test_db, owner, "ns-rename-group")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    # Use a personal KB (namespace=default) so adding namespace permission
    # does not trigger the "own group" protection.
    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="ns-rename-kb", namespace="default"),
    )

    # Add namespace permission with an old snapshot
    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(namespace.id),
        entity_display_name="OldSnapshotName",
    )

    # Rename the namespace
    namespace.display_name = "NewRenamedName"
    test_db.commit()

    # get_members should return the live name, not the snapshot
    members = knowledge_share_service.get_members(test_db, knowledge_base_id, owner.id)
    namespace_members = [m for m in members.members if m.entity_type == "namespace"]
    assert len(namespace_members) == 1
    assert namespace_members[0].display_name == "NewRenamedName"


@pytest.mark.unit
def test_namespace_snapshot_is_suppressed(test_db: Session) -> None:
    """add_member should ignore entity_display_name for namespace entries."""
    from app.schemas.share import MemberRole

    owner = _create_user(test_db, "ns-snapshot-owner")
    namespace = _create_namespace(test_db, owner, "ns-snapshot-group")
    _add_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    # Use a personal KB (namespace=default) so adding namespace permission
    # does not trigger the "own group" protection.
    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="ns-snapshot-kb", namespace="default"),
    )

    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(namespace.id),
        entity_display_name="ShouldBeIgnored",
    )

    member = (
        test_db.query(ResourceMember)
        .filter(
            ResourceMember.resource_type == "KnowledgeBase",
            ResourceMember.resource_id == knowledge_base_id,
            ResourceMember.entity_type == "namespace",
            ResourceMember.entity_id == str(namespace.id),
        )
        .first()
    )
    assert member is not None
    assert member.entity_display_name == ""


@pytest.mark.unit
def test_kb_shown_in_all_target_groups_via_namespace_entity(
    test_db: Session,
) -> None:
    """KB shared to multiple groups via namespace entity should appear in all target groups."""
    owner = _create_user(test_db, "multi-group-owner")
    group_a = _create_namespace(test_db, owner, "group-a")
    group_b = _create_namespace(test_db, owner, "group-b")
    member = _create_user(test_db, "multi-group-member")

    _add_member(test_db, group_a, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, group_b, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, group_a, member, GroupRole.Developer, owner.id)
    _add_member(test_db, group_b, member, GroupRole.Developer, owner.id)

    # Create a personal KB and share it to both groups via namespace entity
    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="shared-to-both", namespace="default"),
    )

    from app.schemas.share import MemberRole

    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(group_a.id),
    )
    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(group_b.id),
    )

    grouped = KnowledgeService.get_all_knowledge_bases_grouped(test_db, member.id)

    group_names_with_kb = {
        g.group_name
        for g in grouped.groups
        if any(kb.id == knowledge_base_id for kb in g.knowledge_bases)
    }
    assert "group-a" in group_names_with_kb
    assert "group-b" in group_names_with_kb


@pytest.mark.unit
def test_get_user_kb_permission_merges_multiple_entity_roles(
    test_db: Session,
) -> None:
    """get_user_kb_permission should return the highest role across all entity sources."""
    owner = _create_user(test_db, "merge-owner")
    group_a = _create_namespace(test_db, owner, "merge-group-a")
    member = _create_user(test_db, "merge-member")

    _add_member(test_db, group_a, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, group_a, member, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="merge-kb", namespace="default"),
    )

    from app.schemas.share import MemberRole

    # Share with Reporter role via namespace entity
    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(group_a.id),
    )
    # Also share with Maintainer role via direct user entity
    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=member.id,
        role=MemberRole.Maintainer,
    )

    has_access, role, is_creator = knowledge_share_service.get_user_kb_permission(
        test_db, knowledge_base_id, member.id
    )

    assert has_access is True
    assert role == ResourceRole.Maintainer.value
    assert is_creator is False


@pytest.mark.unit
def test_permission_sources_consistent_with_user_kb_permission(
    test_db: Session,
) -> None:
    """get_my_permission_sources and get_user_kb_permission should return the same effective_role."""
    owner = _create_user(test_db, "consistent-owner")
    group_a = _create_namespace(test_db, owner, "consistent-group-a")
    member = _create_user(test_db, "consistent-member")

    _add_member(test_db, group_a, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, group_a, member, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="consistent-kb", namespace="default"),
    )

    from app.schemas.share import MemberRole

    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(group_a.id),
    )

    _, role_from_permission, _ = knowledge_share_service.get_user_kb_permission(
        test_db, knowledge_base_id, member.id
    )
    sources = knowledge_share_service.get_my_permission_sources(
        test_db, knowledge_base_id, member.id
    )

    assert role_from_permission == sources.effective_role


@pytest.mark.unit
def test_get_resource_checks_all_entity_records(
    test_db: Session,
) -> None:
    """_get_resource should check all entity records, not just the first one."""
    owner = _create_user(test_db, "resource-owner")
    group_a = _create_namespace(test_db, owner, "resource-group-a")
    group_b = _create_namespace(test_db, owner, "resource-group-b")
    member = _create_user(test_db, "resource-member")

    _add_member(test_db, group_a, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, group_b, owner, GroupRole.Owner, owner.id)
    _add_member(test_db, group_b, member, GroupRole.Developer, owner.id)

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="resource-kb", namespace="default"),
    )

    from app.schemas.share import MemberRole

    # Member is NOT in group_a, but IS in group_b
    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(group_a.id),
    )
    knowledge_share_service.add_member(
        test_db,
        resource_id=knowledge_base_id,
        current_user_id=owner.id,
        target_user_id=0,
        role=MemberRole.Reporter,
        entity_type="namespace",
        entity_id=str(group_b.id),
    )

    # _get_resource should find the group_b match even if group_a was queried first
    kb = knowledge_share_service._get_resource(test_db, knowledge_base_id, member.id)
    assert kb is not None
    assert kb.id == knowledge_base_id


@pytest.mark.unit
def test_delete_knowledge_base_removes_orphaned_folders(test_db: Session) -> None:
    """Deleting a knowledge base must also delete all its folders to prevent orphaned records."""
    owner = _create_user(test_db, "owner-kb-folder-cleanup")

    knowledge_base_id = KnowledgeService.create_knowledge_base(
        test_db,
        owner.id,
        KnowledgeBaseCreate(name="kb-with-folders", namespace="default"),
    )

    # Create a root-level folder and a nested child folder inside the KB.
    root_folder = KnowledgeFolderService.create_folder(
        test_db,
        knowledge_base_id,
        owner.id,
        KnowledgeFolderCreate(name="root-folder", parent_id=0),
    )
    KnowledgeFolderService.create_folder(
        test_db,
        knowledge_base_id,
        owner.id,
        KnowledgeFolderCreate(name="child-folder", parent_id=root_folder.id),
    )

    # Verify folders exist before deletion.
    folder_count_before = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == knowledge_base_id)
        .count()
    )
    assert folder_count_before == 2

    # Delete the knowledge base (no documents, so deletion is allowed).
    deleted = KnowledgeService.delete_knowledge_base(
        test_db, knowledge_base_id, owner.id
    )
    assert deleted is True

    # All folders belonging to the deleted KB must be gone.
    folder_count_after = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == knowledge_base_id)
        .count()
    )
    assert (
        folder_count_after == 0
    ), f"Expected 0 folders after KB deletion, but found {folder_count_after} orphaned folder(s)"

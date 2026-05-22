# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for document transfer between knowledge bases.

Tests the transfer_documents_to_kb method which moves documents
and folders from one knowledge base to another, including:
- Cross-KB transfer (personal to team, team to personal, etc.)
- Index cleanup in source KB
- Index scheduling in target KB
- Folder hierarchy recreation
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.exceptions import StructuredValidationException
from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument, KnowledgeFolder
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.models.user import User
from app.schemas.knowledge import (
    DocumentSourceType,
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
    KnowledgeFolderCreate,
    TransferDocumentsResponse,
)
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.knowledge_transfer import KnowledgeTransferService

# Rewritten preserving original tests plus targeted review-coverage additions.


def _create_user(test_db: Session, username: str, role: str = "user") -> User:
    """Create a test user."""
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
    """Create a test namespace."""
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


def _add_namespace_member(
    test_db: Session,
    namespace: Namespace,
    user: User,
    role: GroupRole,
    invited_by_user_id: int,
) -> ResourceMember:
    """Add a user to a namespace."""
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


def _create_kb(
    test_db: Session, user_id: int, name: str, namespace: str = "default"
) -> int:
    """Create a test knowledge base and return its ID."""
    return KnowledgeService.create_knowledge_base(
        test_db,
        user_id,
        KnowledgeBaseCreate(name=name, namespace=namespace),
    )


def _create_document(
    test_db: Session,
    kb_id: int,
    user_id: int,
    name: str,
    folder_id: int = 0,
) -> KnowledgeDocument:
    """Create a test document."""
    return KnowledgeService.create_document(
        test_db,
        kb_id,
        user_id,
        KnowledgeDocumentCreate(
            name=name,
            file_extension="md",
            file_size=100,
            source_type=DocumentSourceType.TEXT,
            folder_id=folder_id,
        ),
    )


def _create_folder(
    test_db: Session,
    kb_id: int,
    user_id: int,
    name: str,
    parent_id: int = 0,
) -> KnowledgeFolder:
    """Create a test folder."""
    from app.services.knowledge.folder_service import KnowledgeFolderService

    return KnowledgeFolderService.create_folder(
        test_db,
        kb_id,
        user_id,
        KnowledgeFolderCreate(name=name, parent_id=parent_id),
    )


@pytest.mark.unit
def test_validate_transfer_document_names_rejects_duplicates(test_db: Session) -> None:
    """Duplicate document names are exposed as structured validation errors."""
    owner = _create_user(test_db, "owner-duplicate-transfer")
    source_kb_id = _create_kb(test_db, owner.id, "source-duplicate-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-duplicate-kb")
    source_doc = _create_document(test_db, source_kb_id, owner.id, "same-name.md")
    _create_document(test_db, target_kb_id, owner.id, "same-name.md")

    with pytest.raises(StructuredValidationException) as exc_info:
        KnowledgeTransferService.validate_transfer_document_names(
            db=test_db,
            all_doc_ids={source_doc.id},
            target_kb_id=target_kb_id,
            source_kb_id=source_kb_id,
        )

    assert exc_info.value.error_code == "DUPLICATE_DOCUMENT_NAMES"
    assert exc_info.value.payload == {"names": ["same-name.md"]}


@pytest.mark.unit
def test_transfer_namespace_level_classification(test_db: Session) -> None:
    """Namespace level classification matches transfer rule scopes."""
    owner = _create_user(test_db, "owner-transfer-scope")
    _create_namespace(test_db, owner, "team-scope", level="group")
    _create_namespace(test_db, owner, "org-scope", level="organization")

    assert (
        KnowledgeTransferService._get_transfer_namespace_level(test_db, "default")
        == "personal"
    )
    assert (
        KnowledgeTransferService._get_transfer_namespace_level(test_db, "team-scope")
        == "group"
    )
    assert (
        KnowledgeTransferService._get_transfer_namespace_level(test_db, "org-scope")
        == "organization"
    )


@pytest.mark.unit
def test_validate_transfer_namespace_allows_org_to_org(test_db: Session) -> None:
    """Organization documents can move between organization knowledge bases."""
    owner = _create_user(test_db, "owner-org-transfer")
    org_ns = _create_namespace(test_db, owner, "org-transfer", level="organization")
    _add_namespace_member(test_db, org_ns, owner, GroupRole.Owner, owner.id)
    source_kb_id = _create_kb(test_db, owner.id, "source-org-kb", namespace=org_ns.name)
    target_kb_id = _create_kb(test_db, owner.id, "target-org-kb", namespace=org_ns.name)
    source_kb = test_db.query(Kind).filter(Kind.id == source_kb_id).first()
    target_kb = test_db.query(Kind).filter(Kind.id == target_kb_id).first()

    KnowledgeTransferService.validate_transfer_namespace(test_db, source_kb, target_kb)


@pytest.mark.unit
def test_validate_transfer_namespace_rejects_org_to_personal(test_db: Session) -> None:
    """Organization documents cannot move into personal knowledge bases."""
    owner = _create_user(test_db, "owner-org-personal-reject")
    org_ns = _create_namespace(
        test_db, owner, "org-transfer-reject", level="organization"
    )
    _add_namespace_member(test_db, org_ns, owner, GroupRole.Owner, owner.id)
    source_kb_id = _create_kb(
        test_db, owner.id, "source-org-reject-kb", namespace=org_ns.name
    )
    target_kb_id = _create_kb(test_db, owner.id, "target-personal-reject-kb")
    source_kb = test_db.query(Kind).filter(Kind.id == source_kb_id).first()
    target_kb = test_db.query(Kind).filter(Kind.id == target_kb_id).first()

    with pytest.raises(ValueError, match="Invalid target"):
        KnowledgeTransferService.validate_transfer_namespace(
            test_db, source_kb, target_kb
        )


@pytest.mark.unit
def test_transfer_documents_between_personal_kbs(test_db: Session) -> None:
    """Test transferring documents between personal knowledge bases."""
    owner = _create_user(test_db, "owner-transfer-personal")
    source_kb_id = _create_kb(test_db, owner.id, "source-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-kb")
    doc1 = _create_document(test_db, source_kb_id, owner.id, "doc1.md")
    doc2 = _create_document(test_db, source_kb_id, owner.id, "doc2.md")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2
    assert (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == source_kb_id)
        .count()
        == 0
    )
    for doc in transferred_docs:
        assert doc.is_active is False
        assert doc.index_status == DocumentIndexStatus.NOT_INDEXED


@pytest.mark.unit
def test_transfer_documents_from_personal_to_team_kb(test_db: Session) -> None:
    """Test transferring documents from personal KB to team KB."""
    owner = _create_user(test_db, "owner-transfer-to-team")
    namespace = _create_namespace(test_db, owner, "team-transfer-space")
    _add_namespace_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    personal_kb_id = _create_kb(test_db, owner.id, "personal-kb", namespace="default")
    team_kb_id = _create_kb(test_db, owner.id, "team-kb", namespace=namespace.name)
    doc1 = _create_document(test_db, personal_kb_id, owner.id, "team-doc1.md")
    doc2 = _create_document(test_db, personal_kb_id, owner.id, "team-doc2.md")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=personal_kb_id,
        target_kb_id=team_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == team_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2
    assert all(doc.is_active is False for doc in transferred_docs)


@pytest.mark.unit
def test_transfer_documents_from_team_to_personal_kb(test_db: Session) -> None:
    """Test transferring documents from team KB to personal KB."""
    owner = _create_user(test_db, "owner-transfer-from-team")
    namespace = _create_namespace(test_db, owner, "team-source-space")
    _add_namespace_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    team_kb_id = _create_kb(
        test_db, owner.id, "team-source-kb", namespace=namespace.name
    )
    personal_kb_id = _create_kb(
        test_db, owner.id, "personal-target-kb", namespace="default"
    )
    doc1 = _create_document(test_db, team_kb_id, owner.id, "personal-doc1.md")
    doc2 = _create_document(test_db, team_kb_id, owner.id, "personal-doc2.md")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=team_kb_id,
        target_kb_id=personal_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    assert (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == personal_kb_id)
        .count()
        == 2
    )


@pytest.mark.unit
def test_transfer_documents_between_team_kbs(test_db: Session) -> None:
    """Test transferring documents between team knowledge bases."""
    owner = _create_user(test_db, "owner-transfer-team-team")
    namespace1 = _create_namespace(test_db, owner, "team-source-ns")
    namespace2 = _create_namespace(test_db, owner, "team-target-ns")
    _add_namespace_member(test_db, namespace1, owner, GroupRole.Owner, owner.id)
    _add_namespace_member(test_db, namespace2, owner, GroupRole.Owner, owner.id)
    source_kb_id = _create_kb(
        test_db, owner.id, "team-source-kb", namespace=namespace1.name
    )
    target_kb_id = _create_kb(
        test_db, owner.id, "team-target-kb", namespace=namespace2.name
    )
    doc1 = _create_document(test_db, source_kb_id, owner.id, "team-doc1.md")
    doc2 = _create_document(test_db, source_kb_id, owner.id, "team-doc2.md")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    assert (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .count()
        == 2
    )


@pytest.mark.unit
def test_transfer_folders_with_documents(test_db: Session) -> None:
    """Test transferring folders with documents recreates folder hierarchy."""
    owner = _create_user(test_db, "owner-transfer-folders")
    source_kb_id = _create_kb(test_db, owner.id, "source-folder-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-folder-kb")
    parent_folder = _create_folder(test_db, source_kb_id, owner.id, "parent-folder")
    child_folder = _create_folder(
        test_db, source_kb_id, owner.id, "child-folder", parent_id=parent_folder.id
    )
    doc_in_root = _create_document(test_db, source_kb_id, owner.id, "doc-in-root.md")
    _create_document(
        test_db, source_kb_id, owner.id, "doc-in-parent.md", folder_id=parent_folder.id
    )
    _create_document(
        test_db, source_kb_id, owner.id, "doc-in-child.md", folder_id=child_folder.id
    )

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_in_root.id],
        folder_ids=[parent_folder.id],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 3
    assert result.transferred_folder_count == 2
    target_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    target_parent = next(f for f in target_folders if f.name == "parent-folder")
    target_child = next(f for f in target_folders if f.name == "child-folder")
    assert target_child.parent_id == target_parent.id
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 3


@pytest.mark.unit
def test_transfer_documents_without_permission_fails(test_db: Session) -> None:
    """Test that transfer fails if user lacks permission on target KB."""
    owner = _create_user(test_db, "owner-transfer-perm")
    other_user = _create_user(test_db, "other-transfer-perm")
    source_kb_id = _create_kb(test_db, owner.id, "source-perm-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-perm-kb")
    doc = _create_document(test_db, source_kb_id, owner.id, "perm-doc.md")

    with pytest.raises(ValueError, match="access denied"):
        KnowledgeService.transfer_documents_to_kb(
            db=test_db,
            source_kb_id=source_kb_id,
            target_kb_id=target_kb_id,
            document_ids=[doc.id],
            folder_ids=[],
            user_id=other_user.id,
        )


@pytest.mark.unit
def test_transfer_to_same_kb_fails(test_db: Session) -> None:
    """Test that transfer to the same KB fails."""
    owner = _create_user(test_db, "owner-same-kb")
    kb_id = _create_kb(test_db, owner.id, "same-kb")
    doc = _create_document(test_db, kb_id, owner.id, "same-doc.md")

    with pytest.raises(ValueError, match="must be different"):
        KnowledgeService.transfer_documents_to_kb(
            db=test_db,
            source_kb_id=kb_id,
            target_kb_id=kb_id,
            document_ids=[doc.id],
            folder_ids=[],
            user_id=owner.id,
        )


@pytest.mark.unit
def test_transfer_empty_selection_returns_success(test_db: Session) -> None:
    """Test that transfer with no documents/folders returns success."""
    owner = _create_user(test_db, "owner-empty-transfer")
    source_kb_id = _create_kb(test_db, owner.id, "source-empty-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-empty-kb")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 0
    assert result.transferred_folder_count == 0
    assert "No documents" in result.message


@pytest.mark.unit
def test_transfer_documents_updates_document_counts(test_db: Session) -> None:
    """Test that transfer updates document counts in both KBs."""
    owner = _create_user(test_db, "owner-count-update")
    source_kb_id = _create_kb(test_db, owner.id, "source-count-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-count-kb")
    doc1 = _create_document(test_db, source_kb_id, owner.id, "count-doc1.md")
    doc2 = _create_document(test_db, source_kb_id, owner.id, "count-doc2.md")

    KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert KnowledgeService.get_document_count(test_db, source_kb_id) == 0
    assert KnowledgeService.get_document_count(test_db, target_kb_id) == 2


@pytest.mark.unit
@patch("app.services.knowledge.knowledge_transfer._get_delete_gateway")
@patch(
    "app.services.knowledge.orchestrator.KnowledgeOrchestrator._schedule_indexing_celery"
)
def test_transfer_triggers_indexing_in_target_kb(
    mock_schedule_indexing: MagicMock,
    mock_get_delete_gateway: MagicMock,
    test_db: Session,
) -> None:
    """Test that transfer triggers indexing in target KB when retrieval config exists."""
    owner = _create_user(test_db, "owner-index-trigger")
    source_kb_id = _create_kb(test_db, owner.id, "source-index-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-index-kb")
    target_kb = test_db.query(Kind).filter(Kind.id == target_kb_id).first()
    target_kb.json["spec"]["retrievalConfig"] = {
        "retriever_name": "test-retriever",
        "retrieval_mode": "vector",
    }
    from sqlalchemy.orm.attributes import flag_modified

    flag_modified(target_kb, "json")
    test_db.commit()
    doc = _create_document(test_db, source_kb_id, owner.id, "index-doc.md")
    mock_get_delete_gateway.return_value = MagicMock()

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    mock_schedule_indexing.assert_called_once()
    assert mock_schedule_indexing.call_args.kwargs.get("document").id == doc.id


@pytest.mark.unit
def test_developer_can_transfer_documents_in_namespace_kb(test_db: Session) -> None:
    """Test that a developer can transfer documents in a namespace KB they have access to."""
    owner = _create_user(test_db, "owner-dev-transfer")
    developer = _create_user(test_db, "developer-transfer")
    namespace = _create_namespace(test_db, owner, "dev-transfer-space")
    _add_namespace_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_namespace_member(test_db, namespace, developer, GroupRole.Developer, owner.id)
    source_kb_id = _create_kb(
        test_db, owner.id, "dev-source-kb", namespace=namespace.name
    )
    target_kb_id = _create_kb(
        test_db, owner.id, "dev-target-kb", namespace=namespace.name
    )
    doc = _create_document(test_db, source_kb_id, developer.id, "dev-doc.md")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc.id],
        folder_ids=[],
        user_id=developer.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 1


@pytest.mark.unit
def test_cleanup_empty_folders_ignores_deleted_candidates(test_db: Session) -> None:
    """Cleanup handles candidates deleted before cleanup without errors."""
    owner = _create_user(test_db, "owner-cleanup-missing-folder")
    kb_id = _create_kb(test_db, owner.id, "cleanup-missing-kb")
    folder = _create_folder(test_db, kb_id, owner.id, "missing-folder")
    folder_id = folder.id
    test_db.delete(
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder_id).one()
    )
    test_db.commit()

    deleted_count = KnowledgeTransferService.cleanup_empty_folders(
        db=test_db,
        source_kb_id=kb_id,
        transferred_folder_ids={folder_id},
    )

    assert deleted_count == 0


@pytest.mark.unit
def test_transfer_all_documents_from_folder_deletes_empty_source_folder(
    test_db: Session,
) -> None:
    """Test that transferring all documents from a folder deletes the source folder."""
    owner = _create_user(test_db, "owner-cleanup-empty-folder")
    source_kb_id = _create_kb(test_db, owner.id, "source-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-cleanup-kb")
    folder = _create_folder(test_db, source_kb_id, owner.id, "my-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id, doc_b.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.deleted_folder_count == 1
    assert (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
        is None
    )


@pytest.mark.unit
def test_transfer_partial_documents_from_folder_preserves_source_folder(
    test_db: Session,
) -> None:
    """Test that transferring only some documents does not delete source folder."""
    owner = _create_user(test_db, "owner-cleanup-partial")
    source_kb_id = _create_kb(test_db, owner.id, "source-partial-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-partial-cleanup-kb")
    folder = _create_folder(test_db, source_kb_id, owner.id, "partial-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.deleted_folder_count == 0
    assert (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
        is not None
    )
    remaining_doc = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_b.id)
        .first()
    )
    assert remaining_doc.kind_id == source_kb_id
    assert remaining_doc.folder_id == folder.id


@pytest.mark.unit
def test_transfer_entire_nested_folder_hierarchy_deletes_all_empty_source_folders(
    test_db: Session,
) -> None:
    """Test cascading deletion of empty source folders after transfer."""
    owner = _create_user(test_db, "owner-cleanup-nested")
    source_kb_id = _create_kb(test_db, owner.id, "source-nested-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-nested-cleanup-kb")
    root_folder = _create_folder(test_db, source_kb_id, owner.id, "root-folder")
    level1_folder = _create_folder(
        test_db, source_kb_id, owner.id, "level1-folder", parent_id=root_folder.id
    )
    level2_folder = _create_folder(
        test_db, source_kb_id, owner.id, "level2-folder", parent_id=level1_folder.id
    )
    doc = _create_document(
        test_db, source_kb_id, owner.id, "deep-doc.md", folder_id=level2_folder.id
    )

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.deleted_folder_count == 3
    assert (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == source_kb_id)
        .count()
        == 0
    )


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.unit
def test_transfer_endpoint_uses_extracted_module(
    test_client: TestClient,
    test_token: str,
):
    """Transfer route is served by the extracted endpoint module."""
    transfer_response = TransferDocumentsResponse(
        success=True,
        message="Transferred",
        source_kb_id=10,
        target_kb_id=20,
        transferred_document_count=1,
        transferred_folder_count=0,
        deleted_folder_count=0,
    )

    with (
        patch(
            "app.api.endpoints.knowledge_transfer.KnowledgeService.transfer_documents_to_kb",
            return_value=transfer_response,
        ) as mock_transfer,
        patch(
            "app.api.endpoints.knowledge_transfer.capture_trace_context",
            return_value={"traceparent": "test"},
        ),
        patch("app.api.endpoints.knowledge_transfer._update_kb_summary_after_deletion"),
    ):
        response = test_client.post(
            "/api/knowledge-bases/10/transfer-documents",
            json={
                "target_kb_id": 20,
                "document_ids": [1],
                "folder_ids": [],
            },
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json()["transferred_document_count"] == 1
    mock_transfer.assert_called_once()
    assert mock_transfer.call_args.kwargs["source_kb_id"] == 10
    assert mock_transfer.call_args.kwargs["target_kb_id"] == 20


@pytest.mark.unit
def test_transfer_documents_from_personal_to_organization_kb(test_db: Session) -> None:
    """Test transferring documents from personal KB to organization KB."""
    owner = _create_user(test_db, "owner-personal-to-org")
    org_ns = _create_namespace(
        test_db, owner, "org-personal-target", level="organization"
    )
    _add_namespace_member(test_db, org_ns, owner, GroupRole.Owner, owner.id)
    personal_kb_id = _create_kb(
        test_db, owner.id, "personal-to-org-kb", namespace="default"
    )
    org_kb_id = _create_kb(test_db, owner.id, "org-target-kb", namespace=org_ns.name)
    doc1 = _create_document(test_db, personal_kb_id, owner.id, "org-doc1.md")
    doc2 = _create_document(test_db, personal_kb_id, owner.id, "org-doc2.md")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=personal_kb_id,
        target_kb_id=org_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == org_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2
    assert all(doc.is_active is False for doc in transferred_docs)


@pytest.mark.unit
def test_transfer_documents_from_team_to_organization_kb(test_db: Session) -> None:
    """Test transferring documents from team KB to organization KB."""
    owner = _create_user(test_db, "owner-team-to-org")
    team_ns = _create_namespace(test_db, owner, "team-to-org-source", level="group")
    org_ns = _create_namespace(test_db, owner, "org-team-target", level="organization")
    _add_namespace_member(test_db, team_ns, owner, GroupRole.Owner, owner.id)
    _add_namespace_member(test_db, org_ns, owner, GroupRole.Owner, owner.id)
    team_kb_id = _create_kb(test_db, owner.id, "team-to-org-kb", namespace=team_ns.name)
    org_kb_id = _create_kb(
        test_db, owner.id, "org-team-target-kb", namespace=org_ns.name
    )
    doc1 = _create_document(test_db, team_kb_id, owner.id, "team-org-doc1.md")
    doc2 = _create_document(test_db, team_kb_id, owner.id, "team-org-doc2.md")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=team_kb_id,
        target_kb_id=org_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    assert (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == org_kb_id)
        .count()
        == 2
    )


@pytest.mark.unit
def test_validate_transfer_namespace_rejects_org_to_team(test_db: Session) -> None:
    """Organization documents cannot move into team knowledge bases."""
    owner = _create_user(test_db, "owner-org-to-team-reject")
    org_ns = _create_namespace(
        test_db, owner, "org-to-team-reject", level="organization"
    )
    team_ns = _create_namespace(test_db, owner, "team-org-reject-target", level="group")
    _add_namespace_member(test_db, org_ns, owner, GroupRole.Owner, owner.id)
    _add_namespace_member(test_db, team_ns, owner, GroupRole.Owner, owner.id)
    source_kb_id = _create_kb(
        test_db, owner.id, "org-source-reject-kb", namespace=org_ns.name
    )
    target_kb_id = _create_kb(
        test_db, owner.id, "team-target-reject-kb", namespace=team_ns.name
    )
    source_kb = test_db.query(Kind).filter(Kind.id == source_kb_id).first()
    target_kb = test_db.query(Kind).filter(Kind.id == target_kb_id).first()

    with pytest.raises(ValueError, match="Invalid target"):
        KnowledgeTransferService.validate_transfer_namespace(
            test_db, source_kb, target_kb
        )


@pytest.mark.unit
def test_validate_transfer_namespace_rejects_org_to_group(test_db: Session) -> None:
    """Organization documents cannot move into group-level knowledge bases."""
    owner = _create_user(test_db, "owner-org-to-group-reject")
    org_ns = _create_namespace(test_db, owner, "org-group-reject", level="organization")
    group_ns = _create_namespace(
        test_db, owner, "group-org-reject-target", level="group"
    )
    _add_namespace_member(test_db, org_ns, owner, GroupRole.Owner, owner.id)
    _add_namespace_member(test_db, group_ns, owner, GroupRole.Owner, owner.id)
    source_kb_id = _create_kb(
        test_db, owner.id, "org-group-source-kb", namespace=org_ns.name
    )
    target_kb_id = _create_kb(
        test_db, owner.id, "group-target-kb", namespace=group_ns.name
    )
    source_kb = test_db.query(Kind).filter(Kind.id == source_kb_id).first()
    target_kb = test_db.query(Kind).filter(Kind.id == target_kb_id).first()

    with pytest.raises(ValueError, match="Invalid target"):
        KnowledgeTransferService.validate_transfer_namespace(
            test_db, source_kb, target_kb
        )


@pytest.mark.unit
def test_transfer_documents_mutate_uses_row_lock(test_db: Session) -> None:
    """transfer_documents_mutate acquires row-level locks via with_for_update()."""
    owner = _create_user(test_db, "owner-row-lock")
    source_kb_id = _create_kb(test_db, owner.id, "source-row-lock-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-row-lock-kb")
    doc = _create_document(test_db, source_kb_id, owner.id, "lock-doc.md")

    # Patch the query chain to verify with_for_update is called
    with patch.object(
        test_db.query(KnowledgeDocument).__class__,
        "with_for_update",
        autospec=True,
    ) as mock_for_update:
        # Set up the chain: with_for_update returns a mock whose .all() returns docs
        mock_query = test_db.query(KnowledgeDocument)
        mock_for_update.return_value = mock_query

        docs, count = KnowledgeTransferService.transfer_documents_mutate(
            db=test_db,
            all_doc_ids={doc.id},
            old_to_new_folder={},
            target_kb_id=target_kb_id,
            source_kb_id=source_kb_id,
        )

        mock_for_update.assert_called_once()

    assert count == 1
    assert docs[0].kind_id == target_kb_id


@pytest.mark.unit
def test_validate_transfer_document_names_allows_no_duplicates(
    test_db: Session,
) -> None:
    """Transfer validation passes when no duplicate names exist in target KB."""
    owner = _create_user(test_db, "owner-no-duplicate-transfer")
    source_kb_id = _create_kb(test_db, owner.id, "source-no-dup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-no-dup-kb")
    source_doc = _create_document(test_db, source_kb_id, owner.id, "unique-name.md")
    _create_document(test_db, target_kb_id, owner.id, "different-name.md")

    # Should not raise any exception
    KnowledgeTransferService.validate_transfer_document_names(
        db=test_db,
        all_doc_ids={source_doc.id},
        target_kb_id=target_kb_id,
        source_kb_id=source_kb_id,
    )


@pytest.mark.unit
def test_validate_transfer_document_names_multiple_duplicates(test_db: Session) -> None:
    """Multiple duplicate names are all reported in the structured error."""
    owner = _create_user(test_db, "owner-multi-dup-transfer")
    source_kb_id = _create_kb(test_db, owner.id, "source-multi-dup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-multi-dup-kb")
    doc_a = _create_document(test_db, source_kb_id, owner.id, "dup-a.md")
    doc_b = _create_document(test_db, source_kb_id, owner.id, "dup-b.md")
    _create_document(test_db, target_kb_id, owner.id, "dup-a.md")
    _create_document(test_db, target_kb_id, owner.id, "dup-b.md")

    with pytest.raises(StructuredValidationException) as exc_info:
        KnowledgeTransferService.validate_transfer_document_names(
            db=test_db,
            all_doc_ids={doc_a.id, doc_b.id},
            target_kb_id=target_kb_id,
            source_kb_id=source_kb_id,
        )

    assert exc_info.value.error_code == "DUPLICATE_DOCUMENT_NAMES"
    assert sorted(exc_info.value.payload["names"]) == ["dup-a.md", "dup-b.md"]


@pytest.mark.unit
def test_validate_transfer_document_names_empty_doc_ids(test_db: Session) -> None:
    """Transfer validation passes when no documents are being transferred."""
    owner = _create_user(test_db, "owner-empty-doc-ids")
    source_kb_id = _create_kb(test_db, owner.id, "source-empty-ids-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-empty-ids-kb")

    # Should not raise any exception
    KnowledgeTransferService.validate_transfer_document_names(
        db=test_db,
        all_doc_ids=set(),
        target_kb_id=target_kb_id,
        source_kb_id=source_kb_id,
    )

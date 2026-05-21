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
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument, KnowledgeFolder
from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
from app.models.user import User
from app.schemas.knowledge import (
    DocumentSourceType,
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
    KnowledgeFolderCreate,
    ResourceScope,
)
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import KnowledgeService


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
    test_db: Session,
    user_id: int,
    name: str,
    namespace: str = "default",
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
def test_transfer_documents_between_personal_kbs(test_db: Session) -> None:
    """Test transferring documents between personal knowledge bases."""
    owner = _create_user(test_db, "owner-transfer-personal")

    # Create two personal KBs
    source_kb_id = _create_kb(test_db, owner.id, "source-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-kb")

    # Create documents in source KB
    doc1 = _create_document(test_db, source_kb_id, owner.id, "doc1.md")
    doc2 = _create_document(test_db, source_kb_id, owner.id, "doc2.md")

    # Transfer documents
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
    assert result.transferred_folder_count == 0
    assert result.source_kb_id == source_kb_id
    assert result.target_kb_id == target_kb_id

    # Verify documents are in target KB
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2

    # Verify documents are removed from source KB
    source_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == source_kb_id)
        .all()
    )
    assert len(source_docs) == 0

    # Verify documents are inactive (will be set to True after successful reindexing)
    # and have NOT_INDEXED status
    for doc in transferred_docs:
        assert doc.is_active is False
        assert doc.index_status == DocumentIndexStatus.NOT_INDEXED


@pytest.mark.unit
def test_transfer_documents_from_personal_to_team_kb(test_db: Session) -> None:
    """Test transferring documents from personal KB to team KB."""
    owner = _create_user(test_db, "owner-transfer-to-team")
    namespace = _create_namespace(test_db, owner, "team-transfer-space")
    _add_namespace_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    # Create personal KB and team KB
    personal_kb_id = _create_kb(test_db, owner.id, "personal-kb", namespace="default")
    team_kb_id = _create_kb(test_db, owner.id, "team-kb", namespace=namespace.name)

    # Create documents in personal KB
    doc1 = _create_document(test_db, personal_kb_id, owner.id, "team-doc1.md")
    doc2 = _create_document(test_db, personal_kb_id, owner.id, "team-doc2.md")

    # Transfer documents to team KB
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

    # Verify documents are in team KB
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == team_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2

    # Verify documents are inactive (will be set to True after successful reindexing)
    for doc in transferred_docs:
        assert doc.is_active is False


@pytest.mark.unit
def test_transfer_documents_from_team_to_personal_kb(test_db: Session) -> None:
    """Test transferring documents from team KB to personal KB."""
    owner = _create_user(test_db, "owner-transfer-from-team")
    namespace = _create_namespace(test_db, owner, "team-source-space")
    _add_namespace_member(test_db, namespace, owner, GroupRole.Owner, owner.id)

    # Create team KB and personal KB
    team_kb_id = _create_kb(
        test_db, owner.id, "team-source-kb", namespace=namespace.name
    )
    personal_kb_id = _create_kb(
        test_db, owner.id, "personal-target-kb", namespace="default"
    )

    # Create documents in team KB
    doc1 = _create_document(test_db, team_kb_id, owner.id, "personal-doc1.md")
    doc2 = _create_document(test_db, team_kb_id, owner.id, "personal-doc2.md")

    # Transfer documents to personal KB
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

    # Verify documents are in personal KB
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == personal_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2


@pytest.mark.unit
def test_transfer_documents_between_team_kbs(test_db: Session) -> None:
    """Test transferring documents between team knowledge bases."""
    owner = _create_user(test_db, "owner-transfer-team-team")
    namespace1 = _create_namespace(test_db, owner, "team-source-ns")
    namespace2 = _create_namespace(test_db, owner, "team-target-ns")
    _add_namespace_member(test_db, namespace1, owner, GroupRole.Owner, owner.id)
    _add_namespace_member(test_db, namespace2, owner, GroupRole.Owner, owner.id)

    # Create two team KBs
    source_kb_id = _create_kb(
        test_db, owner.id, "team-source-kb", namespace=namespace1.name
    )
    target_kb_id = _create_kb(
        test_db, owner.id, "team-target-kb", namespace=namespace2.name
    )

    # Create documents in source team KB
    doc1 = _create_document(test_db, source_kb_id, owner.id, "team-doc1.md")
    doc2 = _create_document(test_db, source_kb_id, owner.id, "team-doc2.md")

    # Transfer documents between team KBs
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

    # Verify documents are in target team KB
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2


@pytest.mark.unit
def test_transfer_folders_with_documents(test_db: Session) -> None:
    """Test transferring folders with documents recreates folder hierarchy."""
    owner = _create_user(test_db, "owner-transfer-folders")

    # Create two KBs
    source_kb_id = _create_kb(test_db, owner.id, "source-folder-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-folder-kb")

    # Create folder hierarchy in source KB
    parent_folder = _create_folder(test_db, source_kb_id, owner.id, "parent-folder")
    child_folder = _create_folder(
        test_db, source_kb_id, owner.id, "child-folder", parent_id=parent_folder.id
    )

    # Create documents in folders
    doc_in_parent = _create_document(
        test_db, source_kb_id, owner.id, "doc-in-parent.md", folder_id=parent_folder.id
    )
    doc_in_child = _create_document(
        test_db, source_kb_id, owner.id, "doc-in-child.md", folder_id=child_folder.id
    )
    doc_in_root = _create_document(test_db, source_kb_id, owner.id, "doc-in-root.md")

    # Transfer parent folder (should include child folder and all documents)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_in_root.id],  # Also transfer a root document
        folder_ids=[parent_folder.id],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 3  # All 3 documents
    assert result.transferred_folder_count == 2  # Parent + child folder

    # Verify folder hierarchy is recreated in target KB
    target_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders) == 2

    # Find parent and child folders in target KB
    target_parent = next((f for f in target_folders if f.name == "parent-folder"), None)
    target_child = next((f for f in target_folders if f.name == "child-folder"), None)
    assert target_parent is not None
    assert target_child is not None
    assert target_child.parent_id == target_parent.id  # Hierarchy preserved

    # Verify documents are in correct folders in target KB
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 3

    # Check document folder assignments
    doc_in_parent_transferred = next(
        (d for d in transferred_docs if d.name == "doc-in-parent.md"), None
    )
    doc_in_child_transferred = next(
        (d for d in transferred_docs if d.name == "doc-in-child.md"), None
    )
    doc_in_root_transferred = next(
        (d for d in transferred_docs if d.name == "doc-in-root.md"), None
    )

    assert doc_in_parent_transferred.folder_id == target_parent.id
    assert doc_in_child_transferred.folder_id == target_child.id
    assert doc_in_root_transferred.folder_id == 0  # Root document


@pytest.mark.unit
def test_transfer_documents_without_permission_fails(test_db: Session) -> None:
    """Test that transfer fails if user lacks permission on target KB."""
    owner = _create_user(test_db, "owner-transfer-perm")
    other_user = _create_user(test_db, "other-transfer-perm")

    # Create KBs owned by owner (personal KBs, namespace='default')
    source_kb_id = _create_kb(test_db, owner.id, "source-perm-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-perm-kb")

    # Create document as owner
    doc = _create_document(test_db, source_kb_id, owner.id, "perm-doc.md")

    # Try to transfer as other_user (no permission)
    # The error message is "Knowledge base not found or access denied" since
    # other_user has no access to the personal KB
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

    # Create documents
    doc1 = _create_document(test_db, source_kb_id, owner.id, "count-doc1.md")
    doc2 = _create_document(test_db, source_kb_id, owner.id, "count-doc2.md")

    # Get initial counts
    source_count_before = KnowledgeService.get_document_count(test_db, source_kb_id)
    target_count_before = KnowledgeService.get_document_count(test_db, target_kb_id)
    assert source_count_before == 2
    assert target_count_before == 0

    # Transfer documents
    KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc1.id, doc2.id],
        folder_ids=[],
        user_id=owner.id,
    )

    # Verify counts are updated
    source_count_after = KnowledgeService.get_document_count(test_db, source_kb_id)
    target_count_after = KnowledgeService.get_document_count(test_db, target_kb_id)
    assert source_count_after == 0
    assert target_count_after == 2


@pytest.mark.unit
@patch("app.services.knowledge.knowledge_service._get_delete_gateway")
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

    # Add retrieval_config to target KB to enable indexing
    target_kb = test_db.query(Kind).filter(Kind.id == target_kb_id).first()
    target_kb_json = target_kb.json
    target_kb_json["spec"]["retrievalConfig"] = {
        "retriever_name": "test-retriever",
        "retrieval_mode": "vector",
    }
    target_kb.json = target_kb_json
    from sqlalchemy.orm.attributes import flag_modified

    flag_modified(target_kb, "json")
    test_db.commit()

    # Create document
    doc = _create_document(test_db, source_kb_id, owner.id, "index-doc.md")

    # Mock the delete gateway
    mock_gateway = MagicMock()
    mock_get_delete_gateway.return_value = mock_gateway

    # Transfer document
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True

    # Verify indexing was scheduled for the target KB and transferred document
    mock_schedule_indexing.assert_called_once()
    call_args = mock_schedule_indexing.call_args
    assert call_args.kwargs.get("knowledge_base") is not None
    assert call_args.kwargs.get("document") is not None
    assert call_args.kwargs.get("document").id == doc.id


@pytest.mark.unit
def test_developer_can_transfer_documents_in_namespace_kb(test_db: Session) -> None:
    """Test that a developer can transfer documents in a namespace KB they have access to."""
    owner = _create_user(test_db, "owner-dev-transfer")
    developer = _create_user(test_db, "developer-transfer")
    namespace = _create_namespace(test_db, owner, "dev-transfer-space")
    _add_namespace_member(test_db, namespace, owner, GroupRole.Owner, owner.id)
    _add_namespace_member(test_db, namespace, developer, GroupRole.Developer, owner.id)

    # Create KBs in the namespace
    source_kb_id = _create_kb(
        test_db, owner.id, "dev-source-kb", namespace=namespace.name
    )
    target_kb_id = _create_kb(
        test_db, owner.id, "dev-target-kb", namespace=namespace.name
    )

    # Developer creates documents
    doc = _create_document(test_db, source_kb_id, developer.id, "dev-doc.md")

    # Developer transfers their own document
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
def test_transfer_partial_documents_preserves_folder_hierarchy(
    test_db: Session,
) -> None:
    """Test that transferring only some documents from a folder recreates
    the folder hierarchy in the target KB without moving unselected documents.

    This is the core bug-fix scenario: when a user selects individual files
    (not folders) for transfer, only those files should be moved, but the
    folder structure they belong to should still be recreated in the target KB.
    """
    owner = _create_user(test_db, "owner-partial-folder-transfer")

    # Create two KBs
    source_kb_id = _create_kb(test_db, owner.id, "source-partial-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-partial-kb")

    # Create folder hierarchy in source KB: parent > child
    parent_folder = _create_folder(test_db, source_kb_id, owner.id, "parent-folder")
    child_folder = _create_folder(
        test_db, source_kb_id, owner.id, "child-folder", parent_id=parent_folder.id
    )

    # Create documents: some in parent folder, some in child folder, some at root
    doc_in_parent_a = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-parent-a.md",
        folder_id=parent_folder.id,
    )
    doc_in_parent_b = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-parent-b.md",
        folder_id=parent_folder.id,
    )
    doc_in_child_a = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-child-a.md",
        folder_id=child_folder.id,
    )
    doc_in_child_b = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-child-b.md",
        folder_id=child_folder.id,
    )
    doc_in_root = _create_document(test_db, source_kb_id, owner.id, "doc-root.md")

    # Transfer only doc-parent-a and doc-child-a (NOT the full folder)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_in_parent_a.id, doc_in_child_a.id],
        folder_ids=[],  # No folders explicitly selected
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    # Folders should be recreated even though folder_ids is empty
    assert result.transferred_folder_count == 2

    # Verify folder hierarchy is recreated in target KB
    target_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders) == 2

    target_parent = next((f for f in target_folders if f.name == "parent-folder"), None)
    target_child = next((f for f in target_folders if f.name == "child-folder"), None)
    assert target_parent is not None
    assert target_child is not None
    assert target_child.parent_id == target_parent.id  # Hierarchy preserved

    # Verify transferred documents are in correct folders in target KB
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2

    doc_parent_a_transferred = next(
        (d for d in transferred_docs if d.name == "doc-parent-a.md"), None
    )
    doc_child_a_transferred = next(
        (d for d in transferred_docs if d.name == "doc-child-a.md"), None
    )
    assert doc_parent_a_transferred is not None
    assert doc_child_a_transferred is not None
    assert doc_parent_a_transferred.folder_id == target_parent.id
    assert doc_child_a_transferred.folder_id == target_child.id

    # Verify unselected documents remain in source KB with their folder intact
    remaining_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == source_kb_id)
        .all()
    )
    assert len(remaining_docs) == 3  # doc-parent-b, doc-child-b, doc-root

    remaining_names = {d.name for d in remaining_docs}
    assert "doc-parent-b.md" in remaining_names
    assert "doc-child-b.md" in remaining_names
    assert "doc-root.md" in remaining_names

    # Verify remaining documents still have their original folder_id
    doc_parent_b = next(d for d in remaining_docs if d.name == "doc-parent-b.md")
    doc_child_b = next(d for d in remaining_docs if d.name == "doc-child-b.md")
    doc_root = next(d for d in remaining_docs if d.name == "doc-root.md")
    assert doc_parent_b.folder_id == parent_folder.id
    assert doc_child_b.folder_id == child_folder.id
    assert doc_root.folder_id == 0

    # Verify source folders still exist (not deleted)
    source_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == source_kb_id)
        .all()
    )
    assert len(source_folders) == 2


@pytest.mark.unit
def test_transfer_single_document_from_folder_preserves_folder(
    test_db: Session,
) -> None:
    """Test that transferring a single document from a folder recreates
    the folder in the target KB and does not move sibling documents."""
    owner = _create_user(test_db, "owner-single-doc-folder")

    source_kb_id = _create_kb(test_db, owner.id, "source-single-doc-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-single-doc-kb")

    # Create a folder with two documents
    folder = _create_folder(test_db, source_kb_id, owner.id, "my-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    # Transfer only doc_a
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 1
    assert result.transferred_folder_count == 1

    # Verify folder is recreated in target KB
    target_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders) == 1
    assert target_folders[0].name == "my-folder"

    # Verify doc_a is in the target folder
    transferred_doc = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_a.id)
        .first()
    )
    assert transferred_doc.kind_id == target_kb_id
    assert transferred_doc.folder_id == target_folders[0].id

    # Verify doc_b remains in source KB with original folder
    remaining_doc = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_b.id)
        .first()
    )
    assert remaining_doc.kind_id == source_kb_id
    assert remaining_doc.folder_id == folder.id

    # Verify source folder still exists
    source_folder = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
    )
    assert source_folder is not None


@pytest.mark.unit
def test_transfer_documents_with_nested_folder_ancestors(
    test_db: Session,
) -> None:
    """Test that transferring a document from a deeply nested folder
    recreates the entire ancestor chain in the target KB."""
    owner = _create_user(test_db, "owner-nested-ancestor")

    source_kb_id = _create_kb(test_db, owner.id, "source-nested-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-nested-kb")

    # Create deeply nested folder hierarchy: root > level1 > level2
    root_folder = _create_folder(test_db, source_kb_id, owner.id, "root-folder")
    level1_folder = _create_folder(
        test_db, source_kb_id, owner.id, "level1-folder", parent_id=root_folder.id
    )
    level2_folder = _create_folder(
        test_db,
        source_kb_id,
        owner.id,
        "level2-folder",
        parent_id=level1_folder.id,
    )

    # Create a document in the deepest folder
    doc = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "deep-doc.md",
        folder_id=level2_folder.id,
    )

    # Transfer only the document (no folder_ids)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 1
    assert result.transferred_folder_count == 3  # All 3 ancestor folders

    # Verify full hierarchy is recreated in target KB
    target_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders) == 3

    target_root = next((f for f in target_folders if f.name == "root-folder"), None)
    target_level1 = next((f for f in target_folders if f.name == "level1-folder"), None)
    target_level2 = next((f for f in target_folders if f.name == "level2-folder"), None)
    assert target_root is not None
    assert target_level1 is not None
    assert target_level2 is not None

    # Verify hierarchy: root -> level1 -> level2
    assert target_level1.parent_id == target_root.id
    assert target_level2.parent_id == target_level1.id

    # Verify document is in the deepest folder
    transferred_doc = (
        test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc.id).first()
    )
    assert transferred_doc.kind_id == target_kb_id
    assert transferred_doc.folder_id == target_level2.id


@pytest.mark.unit
def test_transfer_same_folder_documents_in_separate_operations_no_duplicate_folders(
    test_db: Session,
) -> None:
    """Test that transferring documents from the same source folder to the
    same target KB in two separate operations does NOT create duplicate
    same-named folders in the target KB.

    This is the bug-fix scenario: previously, each transfer operation would
    unconditionally create a new folder in the target KB, resulting in
    duplicate same-named folders when documents from the same source folder
    were transferred in separate operations.
    """
    owner = _create_user(test_db, "owner-separate-transfer")

    source_kb_id = _create_kb(test_db, owner.id, "source-sep-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-sep-kb")

    # Create a folder with two documents in source KB
    folder = _create_folder(test_db, source_kb_id, owner.id, "shared-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    # First transfer: move doc_a to target KB
    result1 = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id],
        folder_ids=[],
        user_id=owner.id,
    )
    assert result1.success is True
    assert result1.transferred_document_count == 1
    assert result1.transferred_folder_count == 1

    # Verify one folder exists in target KB after first transfer
    target_folders_after_first = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders_after_first) == 1
    first_folder_id = target_folders_after_first[0].id

    # Second transfer: move doc_b to the same target KB
    result2 = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_b.id],
        folder_ids=[],
        user_id=owner.id,
    )
    assert result2.success is True
    assert result2.transferred_document_count == 1
    # No new folder should be created — the existing one is reused
    assert result2.transferred_folder_count == 0

    # Verify still only ONE folder in target KB (no duplicate)
    target_folders_after_second = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders_after_second) == 1
    assert target_folders_after_second[0].id == first_folder_id

    # Verify both documents are in the same folder in target KB
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2
    for doc in transferred_docs:
        assert doc.folder_id == first_folder_id


@pytest.mark.unit
def test_transfer_nested_folder_documents_in_separate_operations_no_duplicates(
    test_db: Session,
) -> None:
    """Test that transferring documents from nested folders in separate
    operations reuses existing target folders at all hierarchy levels."""
    owner = _create_user(test_db, "owner-nested-sep-transfer")

    source_kb_id = _create_kb(test_db, owner.id, "source-nested-sep-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-nested-sep-kb")

    # Create nested folder hierarchy: parent > child
    parent_folder = _create_folder(test_db, source_kb_id, owner.id, "parent-folder")
    child_folder = _create_folder(
        test_db, source_kb_id, owner.id, "child-folder", parent_id=parent_folder.id
    )

    # Create documents in both folders
    doc_in_parent = _create_document(
        test_db, source_kb_id, owner.id, "doc-parent.md", folder_id=parent_folder.id
    )
    doc_in_child = _create_document(
        test_db, source_kb_id, owner.id, "doc-child.md", folder_id=child_folder.id
    )

    # First transfer: move doc_in_child (deepest) — recreates both parent and child
    result1 = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_in_child.id],
        folder_ids=[],
        user_id=owner.id,
    )
    assert result1.success is True
    assert result1.transferred_folder_count == 2  # parent + child

    # Record the target folder IDs after first transfer
    target_folders_after_first = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders_after_first) == 2
    target_parent = next(
        f for f in target_folders_after_first if f.name == "parent-folder"
    )
    target_child = next(
        f for f in target_folders_after_first if f.name == "child-folder"
    )

    # Second transfer: move doc_in_parent — should reuse existing parent folder
    result2 = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_in_parent.id],
        folder_ids=[],
        user_id=owner.id,
    )
    assert result2.success is True
    assert result2.transferred_folder_count == 0  # No new folders created

    # Verify still only 2 folders in target KB (no duplicates)
    target_folders_after_second = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == target_kb_id)
        .all()
    )
    assert len(target_folders_after_second) == 2

    # Verify both documents are in correct folders
    transferred_docs = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == target_kb_id)
        .all()
    )
    assert len(transferred_docs) == 2

    doc_parent_transferred = next(
        d for d in transferred_docs if d.name == "doc-parent.md"
    )
    doc_child_transferred = next(
        d for d in transferred_docs if d.name == "doc-child.md"
    )
    assert doc_parent_transferred.folder_id == target_parent.id
    assert doc_child_transferred.folder_id == target_child.id


# ============== Empty Folder Cleanup Tests ==============


@pytest.mark.unit
def test_transfer_all_documents_from_folder_deletes_empty_source_folder(
    test_db: Session,
) -> None:
    """Test that transferring ALL documents from a folder deletes the
    now-empty source folder from the source KB."""
    owner = _create_user(test_db, "owner-cleanup-empty-folder")

    source_kb_id = _create_kb(test_db, owner.id, "source-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-cleanup-kb")

    # Create a folder with two documents
    folder = _create_folder(test_db, source_kb_id, owner.id, "my-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    # Transfer ALL documents from the folder
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id, doc_b.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    assert result.deleted_folder_count == 1  # Source folder should be deleted

    # Verify source folder no longer exists
    source_folder = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
    )
    assert source_folder is None

    # Verify no folders remain in source KB
    source_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == source_kb_id)
        .all()
    )
    assert len(source_folders) == 0


@pytest.mark.unit
def test_transfer_partial_documents_from_folder_preserves_source_folder(
    test_db: Session,
) -> None:
    """Test that transferring only SOME documents from a folder does NOT
    delete the source folder (it still has remaining documents)."""
    owner = _create_user(test_db, "owner-cleanup-partial")

    source_kb_id = _create_kb(test_db, owner.id, "source-partial-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-partial-cleanup-kb")

    # Create a folder with two documents
    folder = _create_folder(test_db, source_kb_id, owner.id, "partial-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    # Transfer only doc_a (partial transfer)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 1
    assert result.deleted_folder_count == 0  # Folder still has doc_b

    # Verify source folder still exists
    source_folder = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
    )
    assert source_folder is not None

    # Verify doc_b remains in source KB
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
    """Test that transferring all documents from a nested folder hierarchy
    deletes ALL empty source folders (bottom-up cascading deletion)."""
    owner = _create_user(test_db, "owner-cleanup-nested")

    source_kb_id = _create_kb(test_db, owner.id, "source-nested-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-nested-cleanup-kb")

    # Create nested folder hierarchy: root > level1 > level2
    root_folder = _create_folder(test_db, source_kb_id, owner.id, "root-folder")
    level1_folder = _create_folder(
        test_db, source_kb_id, owner.id, "level1-folder", parent_id=root_folder.id
    )
    level2_folder = _create_folder(
        test_db,
        source_kb_id,
        owner.id,
        "level2-folder",
        parent_id=level1_folder.id,
    )

    # Create one document in the deepest folder
    doc = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "deep-doc.md",
        folder_id=level2_folder.id,
    )

    # Transfer the document (no folder_ids, just the document)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 1
    # All 3 source folders should be deleted (cascading bottom-up)
    assert result.deleted_folder_count == 3

    # Verify no folders remain in source KB
    source_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == source_kb_id)
        .all()
    )
    assert len(source_folders) == 0


@pytest.mark.unit
def test_transfer_folder_with_all_documents_deletes_source_folder(
    test_db: Session,
) -> None:
    """Test that transferring a folder via folder_ids (which includes all
    documents) deletes the source folder."""
    owner = _create_user(test_db, "owner-cleanup-folder-transfer")

    source_kb_id = _create_kb(test_db, owner.id, "source-folder-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-folder-cleanup-kb")

    # Create a folder with documents
    folder = _create_folder(test_db, source_kb_id, owner.id, "transfer-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    # Transfer via folder_ids (transfers entire folder subtree)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[],
        folder_ids=[folder.id],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    assert result.deleted_folder_count == 1  # Source folder deleted

    # Verify source folder no longer exists
    source_folder = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
    )
    assert source_folder is None


@pytest.mark.unit
def test_transfer_nested_folder_via_folder_ids_cascading_cleanup(
    test_db: Session,
) -> None:
    """Test that transferring a parent folder via folder_ids deletes all
    empty source folders (parent + children) in cascading fashion."""
    owner = _create_user(test_db, "owner-cleanup-cascading")

    source_kb_id = _create_kb(test_db, owner.id, "source-cascading-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-cascading-kb")

    # Create nested folder hierarchy: parent > child
    parent_folder = _create_folder(test_db, source_kb_id, owner.id, "parent-folder")
    child_folder = _create_folder(
        test_db, source_kb_id, owner.id, "child-folder", parent_id=parent_folder.id
    )

    # Create documents in both folders
    doc_in_parent = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-parent.md",
        folder_id=parent_folder.id,
    )
    doc_in_child = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-child.md",
        folder_id=child_folder.id,
    )

    # Transfer the parent folder (includes child folder and all documents)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[],
        folder_ids=[parent_folder.id],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    assert result.transferred_folder_count == 2  # Parent + child recreated
    assert result.deleted_folder_count == 2  # Both source folders deleted

    # Verify no folders remain in source KB
    source_folders = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.kind_id == source_kb_id)
        .all()
    )
    assert len(source_folders) == 0


@pytest.mark.unit
def test_transfer_partial_nested_preserves_non_empty_parent(
    test_db: Session,
) -> None:
    """Test that when only some documents are transferred from a nested
    hierarchy, the parent folder is preserved if it still has documents."""
    owner = _create_user(test_db, "owner-cleanup-partial-nested")

    source_kb_id = _create_kb(test_db, owner.id, "source-partial-nested-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-partial-nested-kb")

    # Create nested folder hierarchy: parent > child
    parent_folder = _create_folder(test_db, source_kb_id, owner.id, "parent-folder")
    child_folder = _create_folder(
        test_db, source_kb_id, owner.id, "child-folder", parent_id=parent_folder.id
    )

    # Create documents: one in parent, one in child
    doc_in_parent = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-parent.md",
        folder_id=parent_folder.id,
    )
    doc_in_child = _create_document(
        test_db,
        source_kb_id,
        owner.id,
        "doc-child.md",
        folder_id=child_folder.id,
    )

    # Transfer only the child document
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_in_child.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 1
    # Child folder becomes empty and is deleted, but parent still has doc_in_parent
    assert result.deleted_folder_count == 1

    # Verify child folder is deleted but parent folder still exists
    source_child = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.id == child_folder.id)
        .first()
    )
    assert source_child is None

    source_parent = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.id == parent_folder.id)
        .first()
    )
    assert source_parent is not None

    # Verify doc_in_parent remains in source KB
    remaining_doc = (
        test_db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.id == doc_in_parent.id)
        .first()
    )
    assert remaining_doc.kind_id == source_kb_id
    assert remaining_doc.folder_id == parent_folder.id


@pytest.mark.unit
def test_transfer_root_documents_no_folder_cleanup(
    test_db: Session,
) -> None:
    """Test that transferring root-level documents (no folder) has
    deleted_folder_count=0 since there are no folders to clean up."""
    owner = _create_user(test_db, "owner-cleanup-root-docs")

    source_kb_id = _create_kb(test_db, owner.id, "source-root-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-root-cleanup-kb")

    # Create root-level documents (no folder)
    doc1 = _create_document(test_db, source_kb_id, owner.id, "root-doc1.md")
    doc2 = _create_document(test_db, source_kb_id, owner.id, "root-doc2.md")

    # Transfer root documents
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
    assert result.deleted_folder_count == 0  # No folders involved


@pytest.mark.unit
def test_transfer_empty_selection_deleted_folder_count_is_zero(
    test_db: Session,
) -> None:
    """Test that transferring nothing returns deleted_folder_count=0."""
    owner = _create_user(test_db, "owner-cleanup-empty-selection")

    source_kb_id = _create_kb(test_db, owner.id, "source-empty-cleanup-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-empty-cleanup-kb")

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.deleted_folder_count == 0


@pytest.mark.unit
def test_transfer_sibling_folders_one_empty_one_not(
    test_db: Session,
) -> None:
    """Test that when two sibling folders are involved in a transfer and
    only one becomes empty, only the empty one is deleted."""
    owner = _create_user(test_db, "owner-cleanup-sibling")

    source_kb_id = _create_kb(test_db, owner.id, "source-sibling-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-sibling-kb")

    # Create two sibling folders under the same parent
    parent_folder = _create_folder(test_db, source_kb_id, owner.id, "parent-folder")
    child_a = _create_folder(
        test_db, source_kb_id, owner.id, "child-a", parent_id=parent_folder.id
    )
    child_b = _create_folder(
        test_db, source_kb_id, owner.id, "child-b", parent_id=parent_folder.id
    )

    # child_a has 1 doc, child_b has 2 docs
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=child_a.id
    )
    doc_b1 = _create_document(
        test_db, source_kb_id, owner.id, "doc-b1.md", folder_id=child_b.id
    )
    doc_b2 = _create_document(
        test_db, source_kb_id, owner.id, "doc-b2.md", folder_id=child_b.id
    )

    # Transfer only doc_a and doc_b1 (child_a becomes empty, child_b still has doc_b2)
    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id, doc_b1.id],
        folder_ids=[],
        user_id=owner.id,
    )

    assert result.success is True
    assert result.transferred_document_count == 2
    # Only child_a is deleted (empty); child_b and parent still have content
    assert result.deleted_folder_count == 1

    # Verify child_a is deleted
    source_child_a = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == child_a.id).first()
    )
    assert source_child_a is None

    # Verify child_b still exists (has doc_b2)
    source_child_b = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == child_b.id).first()
    )
    assert source_child_b is not None

    # Verify parent folder still exists (has child_b)
    source_parent = (
        test_db.query(KnowledgeFolder)
        .filter(KnowledgeFolder.id == parent_folder.id)
        .first()
    )
    assert source_parent is not None


@pytest.mark.unit
def test_separate_transfers_eventually_delete_all_empty_folders(
    test_db: Session,
) -> None:
    """Test that transferring documents from the same folder in two
    separate operations deletes the source folder after the second
    transfer makes it empty."""
    owner = _create_user(test_db, "owner-cleanup-two-step")

    source_kb_id = _create_kb(test_db, owner.id, "source-two-step-kb")
    target_kb_id = _create_kb(test_db, owner.id, "target-two-step-kb")

    # Create a folder with two documents
    folder = _create_folder(test_db, source_kb_id, owner.id, "two-step-folder")
    doc_a = _create_document(
        test_db, source_kb_id, owner.id, "doc-a.md", folder_id=folder.id
    )
    doc_b = _create_document(
        test_db, source_kb_id, owner.id, "doc-b.md", folder_id=folder.id
    )

    # First transfer: move doc_a (partial — folder still has doc_b)
    result1 = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_a.id],
        folder_ids=[],
        user_id=owner.id,
    )
    assert result1.success is True
    assert result1.deleted_folder_count == 0  # Folder still has doc_b

    # Verify source folder still exists after first transfer
    source_folder = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
    )
    assert source_folder is not None

    # Second transfer: move doc_b (folder now becomes empty)
    result2 = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_kb_id,
        target_kb_id=target_kb_id,
        document_ids=[doc_b.id],
        folder_ids=[],
        user_id=owner.id,
    )
    assert result2.success is True
    assert result2.deleted_folder_count == 1  # Folder now empty

    # Verify source folder is deleted after second transfer
    source_folder_after = (
        test_db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder.id).first()
    )
    assert source_folder_after is None

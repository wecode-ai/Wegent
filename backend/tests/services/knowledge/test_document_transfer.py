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

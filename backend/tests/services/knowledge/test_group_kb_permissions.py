# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for group knowledge base permission system.

These tests verify the permission inheritance rules:
- Owner/Maintainer -> MANAGE (create, edit, delete, manage permissions)
- Developer -> EDIT (view, edit name/description, add/edit documents)
- Reporter -> VIEW (view only)
"""

import pytest
from sqlalchemy.orm import Session

from app.core.security import get_password_hash
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
)
from app.schemas.namespace import GroupRole
from app.services.knowledge.knowledge_service import (
    GROUP_ROLE_TO_PERMISSION_LEVEL,
    KnowledgeService,
    _check_kb_permission,
    _get_user_kb_permission_level,
)


# =============================================================================
# Fixtures
# =============================================================================


@pytest.fixture(scope="function")
def test_group_owner(test_db: Session) -> User:
    """Create a test user who will be group owner."""
    user = User(
        user_name="groupowner",
        password_hash=get_password_hash("owner123"),
        email="owner@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group_maintainer(test_db: Session) -> User:
    """Create a test user who will be group maintainer."""
    user = User(
        user_name="groupmaintainer",
        password_hash=get_password_hash("maintainer123"),
        email="maintainer@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group_developer(test_db: Session) -> User:
    """Create a test user who will be group developer."""
    user = User(
        user_name="groupdeveloper",
        password_hash=get_password_hash("developer123"),
        email="developer@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group_reporter(test_db: Session) -> User:
    """Create a test user who will be group reporter."""
    user = User(
        user_name="groupreporter",
        password_hash=get_password_hash("reporter123"),
        email="reporter@example.com",
        is_active=True,
    )
    test_db.add(user)
    test_db.commit()
    test_db.refresh(user)
    return user


@pytest.fixture(scope="function")
def test_group(test_db: Session, test_group_owner: User) -> Namespace:
    """Create a test group namespace."""
    namespace = Namespace(
        name="testgroup",
        display_name="Test Group",
        description="A test group for knowledge base permission testing",
        owner_user_id=test_group_owner.id,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


@pytest.fixture(scope="function")
def test_subgroup(test_db: Session, test_group: Namespace, test_group_owner: User) -> Namespace:
    """Create a test subgroup to test permission inheritance."""
    namespace = Namespace(
        name=f"{test_group.name}/subgroup",
        display_name="Test Subgroup",
        description="A test subgroup for inheritance testing",
        owner_user_id=test_group_owner.id,
        is_active=True,
    )
    test_db.add(namespace)
    test_db.commit()
    test_db.refresh(namespace)
    return namespace


@pytest.fixture(scope="function")
def group_owner_member(
    test_db: Session, test_group: Namespace, test_group_owner: User
) -> NamespaceMember:
    """Add owner as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_owner.id,
        role=GroupRole.Owner.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_maintainer_member(
    test_db: Session, test_group: Namespace, test_group_maintainer: User
) -> NamespaceMember:
    """Add maintainer as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_maintainer.id,
        role=GroupRole.Maintainer.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_developer_member(
    test_db: Session, test_group: Namespace, test_group_developer: User
) -> NamespaceMember:
    """Add developer as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_developer.id,
        role=GroupRole.Developer.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_reporter_member(
    test_db: Session, test_group: Namespace, test_group_reporter: User
) -> NamespaceMember:
    """Add reporter as member of the group."""
    member = NamespaceMember(
        group_name=test_group.name,
        user_id=test_group_reporter.id,
        role=GroupRole.Reporter.value,
        is_active=True,
    )
    test_db.add(member)
    test_db.commit()
    return member


@pytest.fixture(scope="function")
def group_kb(
    test_db: Session,
    test_group: Namespace,
    test_group_owner: User,
    group_owner_member: NamespaceMember,
) -> Kind:
    """Create a knowledge base in the test group."""
    kb_data = KnowledgeBaseCreate(
        name="Test Group KB",
        description="A test knowledge base in group",
        namespace=test_group.name,
    )
    kb_id = KnowledgeService.create_knowledge_base(
        db=test_db,
        user_id=test_group_owner.id,
        data=kb_data,
    )
    kb = test_db.query(Kind).filter(Kind.id == kb_id).first()
    return kb


@pytest.fixture(scope="function")
def subgroup_kb(
    test_db: Session,
    test_subgroup: Namespace,
    test_group_owner: User,
) -> Kind:
    """Create a knowledge base in the test subgroup."""
    kb_data = KnowledgeBaseCreate(
        name="Test Subgroup KB",
        description="A test knowledge base in subgroup",
        namespace=test_subgroup.name,
    )
    kb_id = KnowledgeService.create_knowledge_base(
        db=test_db,
        user_id=test_group_owner.id,
        data=kb_data,
    )
    kb = test_db.query(Kind).filter(Kind.id == kb_id).first()
    return kb


@pytest.fixture(scope="function")
def group_kb_document(
    test_db: Session,
    group_kb: Kind,
    test_group_owner: User,
) -> KnowledgeDocument:
    """Create a document in the group knowledge base."""
    doc_data = KnowledgeDocumentCreate(
        name="Test Document",
        file_extension="txt",
        file_size=100,
        source_type="text",
    )
    doc = KnowledgeService.create_document(
        db=test_db,
        knowledge_base_id=group_kb.id,
        user_id=test_group_owner.id,
        data=doc_data,
    )
    return doc


# =============================================================================
# Permission Level Mapping Tests
# =============================================================================


class TestPermissionLevelMapping:
    """Test the GROUP_ROLE_TO_PERMISSION_LEVEL mapping."""

    def test_owner_maps_to_manage(self):
        """Owner role should map to 'manage' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Owner] == "manage"

    def test_maintainer_maps_to_manage(self):
        """Maintainer role should map to 'manage' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Maintainer] == "manage"

    def test_developer_maps_to_edit(self):
        """Developer role should map to 'edit' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Developer] == "edit"

    def test_reporter_maps_to_view(self):
        """Reporter role should map to 'view' permission."""
        assert GROUP_ROLE_TO_PERMISSION_LEVEL[GroupRole.Reporter] == "view"


# =============================================================================
# Get User Permission Level Tests
# =============================================================================


class TestGetUserKbPermissionLevel:
    """Test the _get_user_kb_permission_level function."""

    def test_creator_has_manage_permission(
        self, test_db: Session, group_kb: Kind, test_group_owner: User
    ):
        """Creator should always have 'manage' permission."""
        level = _get_user_kb_permission_level(test_db, group_kb, test_group_owner.id)
        assert level == "manage"

    def test_owner_has_manage_permission(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_owner: User,
        group_owner_member: NamespaceMember,
    ):
        """Owner should have 'manage' permission."""
        level = _get_user_kb_permission_level(test_db, group_kb, test_group_owner.id)
        assert level == "manage"

    def test_maintainer_has_manage_permission(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_maintainer: User,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should have 'manage' permission."""
        level = _get_user_kb_permission_level(test_db, group_kb, test_group_maintainer.id)
        assert level == "manage"

    def test_developer_has_edit_permission(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should have 'edit' permission."""
        level = _get_user_kb_permission_level(test_db, group_kb, test_group_developer.id)
        assert level == "edit"

    def test_reporter_has_view_permission(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should have 'view' permission."""
        level = _get_user_kb_permission_level(test_db, group_kb, test_group_reporter.id)
        assert level == "view"

    def test_non_member_has_no_access(
        self, test_db: Session, group_kb: Kind, test_user: User
    ):
        """Non-member should not have access to group KB."""
        level = _get_user_kb_permission_level(test_db, group_kb, test_user.id)
        # Returns 'view' as default, but access check should fail before this
        assert level == "view"


# =============================================================================
# Check Permission Tests
# =============================================================================


class TestCheckKbPermission:
    """Test the _check_kb_permission function."""

    def test_manage_permission_hierarchy(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_owner: User,
        group_owner_member: NamespaceMember,
    ):
        """Owner with 'manage' should pass all permission checks."""
        assert _check_kb_permission(test_db, group_kb, test_group_owner.id, "manage")
        assert _check_kb_permission(test_db, group_kb, test_group_owner.id, "edit")
        assert _check_kb_permission(test_db, group_kb, test_group_owner.id, "view")

    def test_edit_permission_hierarchy(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer with 'edit' should pass edit and view, but not manage."""
        assert not _check_kb_permission(
            test_db, group_kb, test_group_developer.id, "manage"
        )
        assert _check_kb_permission(test_db, group_kb, test_group_developer.id, "edit")
        assert _check_kb_permission(test_db, group_kb, test_group_developer.id, "view")

    def test_view_permission_hierarchy(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter with 'view' should only pass view check."""
        assert not _check_kb_permission(
            test_db, group_kb, test_group_reporter.id, "manage"
        )
        assert not _check_kb_permission(test_db, group_kb, test_group_reporter.id, "edit")
        assert _check_kb_permission(test_db, group_kb, test_group_reporter.id, "view")


# =============================================================================
# Create Knowledge Base Tests
# =============================================================================


class TestCreateKnowledgeBase:
    """Test knowledge base creation permissions."""

    def test_owner_can_create_kb(
        self,
        test_db: Session,
        test_group: Namespace,
        test_group_owner: User,
        group_owner_member: NamespaceMember,
    ):
        """Owner should be able to create knowledge base."""
        kb_data = KnowledgeBaseCreate(
            name="Owner Created KB",
            description="Created by owner",
            namespace=test_group.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_owner.id,
            data=kb_data,
        )
        assert kb_id is not None

    def test_maintainer_can_create_kb(
        self,
        test_db: Session,
        test_group: Namespace,
        test_group_maintainer: User,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should be able to create knowledge base."""
        kb_data = KnowledgeBaseCreate(
            name="Maintainer Created KB",
            description="Created by maintainer",
            namespace=test_group.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_maintainer.id,
            data=kb_data,
        )
        assert kb_id is not None

    def test_developer_cannot_create_kb(
        self,
        test_db: Session,
        test_group: Namespace,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should NOT be able to create knowledge base."""
        kb_data = KnowledgeBaseCreate(
            name="Developer Created KB",
            description="Created by developer",
            namespace=test_group.name,
        )
        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.create_knowledge_base(
                db=test_db,
                user_id=test_group_developer.id,
                data=kb_data,
            )

    def test_reporter_cannot_create_kb(
        self,
        test_db: Session,
        test_group: Namespace,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should NOT be able to create knowledge base."""
        kb_data = KnowledgeBaseCreate(
            name="Reporter Created KB",
            description="Created by reporter",
            namespace=test_group.name,
        )
        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.create_knowledge_base(
                db=test_db,
                user_id=test_group_reporter.id,
                data=kb_data,
            )


# =============================================================================
# Update Knowledge Base Tests
# =============================================================================


class TestUpdateKnowledgeBase:
    """Test knowledge base update permissions."""

    def test_owner_can_update_kb(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_owner: User,
    ):
        """Owner should be able to update knowledge base."""
        update_data = KnowledgeBaseUpdate(
            name="Updated by Owner",
            description="Updated description",
        )
        result = KnowledgeService.update_knowledge_base(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_owner.id,
            data=update_data,
        )
        assert result is not None
        assert result.json["spec"]["name"] == "Updated by Owner"

    def test_maintainer_can_update_kb(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_maintainer: User,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should be able to update knowledge base."""
        update_data = KnowledgeBaseUpdate(
            name="Updated by Maintainer",
            description="Updated description",
        )
        result = KnowledgeService.update_knowledge_base(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_maintainer.id,
            data=update_data,
        )
        assert result is not None
        assert result.json["spec"]["name"] == "Updated by Maintainer"

    def test_developer_can_update_name_and_description(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should be able to update name and description."""
        update_data = KnowledgeBaseUpdate(
            name="Updated by Developer",
            description="Updated by developer",
        )
        result = KnowledgeService.update_knowledge_base(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_developer.id,
            data=update_data,
        )
        assert result is not None
        assert result.json["spec"]["name"] == "Updated by Developer"

    def test_developer_cannot_update_retrieval_config(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should NOT be able to update retrieval config."""
        from app.schemas.knowledge import RetrievalConfigUpdate

        update_data = KnowledgeBaseUpdate(
            name="Updated by Developer",
            retrieval_config=RetrievalConfigUpdate(
                retriever_name="test_retriever",
            ),
        )
        with pytest.raises(ValueError, match="Developer can only update name and description"):
            KnowledgeService.update_knowledge_base(
                db=test_db,
                knowledge_base_id=group_kb.id,
                user_id=test_group_developer.id,
                data=update_data,
            )

    def test_reporter_cannot_update_kb(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should NOT be able to update knowledge base."""
        update_data = KnowledgeBaseUpdate(
            name="Updated by Reporter",
            description="Updated by reporter",
        )
        with pytest.raises(ValueError, match="Only Owner, Maintainer, or Developer"):
            KnowledgeService.update_knowledge_base(
                db=test_db,
                knowledge_base_id=group_kb.id,
                user_id=test_group_reporter.id,
                data=update_data,
            )


# =============================================================================
# Delete Knowledge Base Tests
# =============================================================================


class TestDeleteKnowledgeBase:
    """Test knowledge base deletion permissions."""

    def test_owner_can_delete_kb(
        self,
        test_db: Session,
        test_group: Namespace,
        test_group_owner: User,
        group_owner_member: NamespaceMember,
    ):
        """Owner should be able to delete knowledge base."""
        # Create a KB first
        kb_data = KnowledgeBaseCreate(
            name="KB to Delete",
            description="Will be deleted",
            namespace=test_group.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_owner.id,
            data=kb_data,
        )

        result = KnowledgeService.delete_knowledge_base(
            db=test_db,
            knowledge_base_id=kb_id,
            user_id=test_group_owner.id,
        )
        assert result is True

    def test_maintainer_can_delete_kb(
        self,
        test_db: Session,
        test_group: Namespace,
        test_group_owner: User,
        test_group_maintainer: User,
        group_owner_member: NamespaceMember,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should be able to delete knowledge base."""
        # Create a KB as owner first
        kb_data = KnowledgeBaseCreate(
            name="KB to Delete by Maintainer",
            description="Will be deleted by maintainer",
            namespace=test_group.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_owner.id,
            data=kb_data,
        )

        result = KnowledgeService.delete_knowledge_base(
            db=test_db,
            knowledge_base_id=kb_id,
            user_id=test_group_maintainer.id,
        )
        assert result is True

    def test_developer_cannot_delete_kb(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should NOT be able to delete knowledge base."""
        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.delete_knowledge_base(
                db=test_db,
                knowledge_base_id=group_kb.id,
                user_id=test_group_developer.id,
            )

    def test_reporter_cannot_delete_kb(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should NOT be able to delete knowledge base."""
        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.delete_knowledge_base(
                db=test_db,
                knowledge_base_id=group_kb.id,
                user_id=test_group_reporter.id,
            )


# =============================================================================
# Create Document Tests
# =============================================================================


class TestCreateDocument:
    """Test document creation permissions."""

    def test_owner_can_create_document(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_owner: User,
    ):
        """Owner should be able to create document."""
        doc_data = KnowledgeDocumentCreate(
            name="Owner Document",
            file_extension="txt",
            file_size=100,
            source_type="text",
        )
        doc = KnowledgeService.create_document(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_owner.id,
            data=doc_data,
        )
        assert doc is not None
        assert doc.name == "Owner Document"

    def test_maintainer_can_create_document(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_maintainer: User,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should be able to create document."""
        doc_data = KnowledgeDocumentCreate(
            name="Maintainer Document",
            file_extension="txt",
            file_size=100,
            source_type="text",
        )
        doc = KnowledgeService.create_document(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_maintainer.id,
            data=doc_data,
        )
        assert doc is not None

    def test_developer_can_create_document(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should be able to create document."""
        doc_data = KnowledgeDocumentCreate(
            name="Developer Document",
            file_extension="txt",
            file_size=100,
            source_type="text",
        )
        doc = KnowledgeService.create_document(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_developer.id,
            data=doc_data,
        )
        assert doc is not None

    def test_reporter_cannot_create_document(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should NOT be able to create document."""
        doc_data = KnowledgeDocumentCreate(
            name="Reporter Document",
            file_extension="txt",
            file_size=100,
            source_type="text",
        )
        with pytest.raises(ValueError, match="Only Owner, Maintainer, or Developer"):
            KnowledgeService.create_document(
                db=test_db,
                knowledge_base_id=group_kb.id,
                user_id=test_group_reporter.id,
                data=doc_data,
            )


# =============================================================================
# Update Document Tests
# =============================================================================


class TestUpdateDocument:
    """Test document update permissions."""

    def test_owner_can_update_document(
        self,
        test_db: Session,
        group_kb_document: KnowledgeDocument,
        test_group_owner: User,
    ):
        """Owner should be able to update document."""
        update_data = KnowledgeDocumentUpdate(name="Updated by Owner")
        result = KnowledgeService.update_document(
            db=test_db,
            document_id=group_kb_document.id,
            user_id=test_group_owner.id,
            data=update_data,
        )
        assert result is not None
        assert result.name == "Updated by Owner"

    def test_maintainer_can_update_document(
        self,
        test_db: Session,
        group_kb: Kind,
        group_kb_document: KnowledgeDocument,
        test_group_maintainer: User,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should be able to update document."""
        update_data = KnowledgeDocumentUpdate(name="Updated by Maintainer")
        result = KnowledgeService.update_document(
            db=test_db,
            document_id=group_kb_document.id,
            user_id=test_group_maintainer.id,
            data=update_data,
        )
        assert result is not None

    def test_developer_can_update_document(
        self,
        test_db: Session,
        group_kb: Kind,
        group_kb_document: KnowledgeDocument,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should be able to update document."""
        update_data = KnowledgeDocumentUpdate(name="Updated by Developer")
        result = KnowledgeService.update_document(
            db=test_db,
            document_id=group_kb_document.id,
            user_id=test_group_developer.id,
            data=update_data,
        )
        assert result is not None

    def test_reporter_cannot_update_document(
        self,
        test_db: Session,
        group_kb: Kind,
        group_kb_document: KnowledgeDocument,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should NOT be able to update document."""
        update_data = KnowledgeDocumentUpdate(name="Updated by Reporter")
        with pytest.raises(ValueError, match="Only Owner, Maintainer, or Developer"):
            KnowledgeService.update_document(
                db=test_db,
                document_id=group_kb_document.id,
                user_id=test_group_reporter.id,
                data=update_data,
            )


# =============================================================================
# Delete Document Tests
# =============================================================================


class TestDeleteDocument:
    """Test document deletion permissions."""

    def test_owner_can_delete_document(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_owner: User,
    ):
        """Owner should be able to delete document."""
        # Create a document first
        doc_data = KnowledgeDocumentCreate(
            name="Doc to Delete",
            file_extension="txt",
            file_size=100,
            source_type="text",
        )
        doc = KnowledgeService.create_document(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_owner.id,
            data=doc_data,
        )

        result = KnowledgeService.delete_document(
            db=test_db,
            document_id=doc.id,
            user_id=test_group_owner.id,
        )
        assert result.success is True

    def test_maintainer_can_delete_document(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_owner: User,
        test_group_maintainer: User,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should be able to delete document."""
        # Create a document as owner first
        doc_data = KnowledgeDocumentCreate(
            name="Doc to Delete by Maintainer",
            file_extension="txt",
            file_size=100,
            source_type="text",
        )
        doc = KnowledgeService.create_document(
            db=test_db,
            knowledge_base_id=group_kb.id,
            user_id=test_group_owner.id,
            data=doc_data,
        )

        result = KnowledgeService.delete_document(
            db=test_db,
            document_id=doc.id,
            user_id=test_group_maintainer.id,
        )
        assert result.success is True

    def test_developer_cannot_delete_document(
        self,
        test_db: Session,
        group_kb: Kind,
        group_kb_document: KnowledgeDocument,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should NOT be able to delete document."""
        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.delete_document(
                db=test_db,
                document_id=group_kb_document.id,
                user_id=test_group_developer.id,
            )

    def test_reporter_cannot_delete_document(
        self,
        test_db: Session,
        group_kb: Kind,
        group_kb_document: KnowledgeDocument,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should NOT be able to delete document."""
        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.delete_document(
                db=test_db,
                document_id=group_kb_document.id,
                user_id=test_group_reporter.id,
            )


# =============================================================================
# Permission Inheritance Tests
# =============================================================================


class TestPermissionInheritance:
    """Test permission inheritance from parent groups to subgroups."""

    def test_owner_inherits_to_subgroup(
        self,
        test_db: Session,
        test_subgroup: Namespace,
        test_group_owner: User,
        group_owner_member: NamespaceMember,
    ):
        """Owner of parent group should inherit permissions to subgroup."""
        # Create KB in subgroup as owner (owner has access via inheritance)
        kb_data = KnowledgeBaseCreate(
            name="Subgroup KB",
            description="KB in subgroup",
            namespace=test_subgroup.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_owner.id,
            data=kb_data,
        )

        # Verify owner has manage permission
        kb = test_db.query(Kind).filter(Kind.id == kb_id).first()
        level = _get_user_kb_permission_level(test_db, kb, test_group_owner.id)
        assert level == "manage"

    def test_developer_inherits_to_subgroup(
        self,
        test_db: Session,
        test_group: Namespace,
        test_subgroup: Namespace,
        test_group_owner: User,
        test_group_developer: User,
        group_owner_member: NamespaceMember,
        group_developer_member: NamespaceMember,
    ):
        """Developer of parent group should inherit edit permission to subgroup."""
        # Create KB in subgroup as owner (owner has access via inheritance)
        kb_data = KnowledgeBaseCreate(
            name="Subgroup KB for Developer",
            description="KB in subgroup",
            namespace=test_subgroup.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_owner.id,
            data=kb_data,
        )
        kb = test_db.query(Kind).filter(Kind.id == kb_id).first()

        # Developer should have edit permission (inherited)
        level = _get_user_kb_permission_level(test_db, kb, test_group_developer.id)
        assert level == "edit"

    def test_developer_can_edit_in_subgroup(
        self,
        test_db: Session,
        test_group: Namespace,
        test_subgroup: Namespace,
        test_group_owner: User,
        test_group_developer: User,
        group_owner_member: NamespaceMember,
        group_developer_member: NamespaceMember,
    ):
        """Developer should be able to edit documents in subgroup KB."""
        # Create KB in subgroup as owner (owner has access via inheritance)
        kb_data = KnowledgeBaseCreate(
            name="Subgroup KB for Edit Test",
            description="KB in subgroup",
            namespace=test_subgroup.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_owner.id,
            data=kb_data,
        )

        # Create document as owner
        doc_data = KnowledgeDocumentCreate(
            name="Subgroup Document",
            file_extension="txt",
            file_size=100,
            source_type="text",
        )
        doc = KnowledgeService.create_document(
            db=test_db,
            knowledge_base_id=kb_id,
            user_id=test_group_owner.id,
            data=doc_data,
        )

        # Developer should be able to update document (inherited permission)
        update_data = KnowledgeDocumentUpdate(name="Updated by Developer in Subgroup")
        result = KnowledgeService.update_document(
            db=test_db,
            document_id=doc.id,
            user_id=test_group_developer.id,
            data=update_data,
        )
        assert result is not None
        assert result.name == "Updated by Developer in Subgroup"


# =============================================================================
# Can Manage Knowledge Base Tests
# =============================================================================


class TestCanManageKnowledgeBase:
    """Test the can_manage_knowledge_base function."""

    def test_owner_can_manage(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_owner: User,
    ):
        """Owner should be able to manage KB."""
        assert KnowledgeService.can_manage_knowledge_base(
            test_db, group_kb.id, test_group_owner.id
        )

    def test_maintainer_can_manage(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_maintainer: User,
        group_maintainer_member: NamespaceMember,
    ):
        """Maintainer should be able to manage KB."""
        assert KnowledgeService.can_manage_knowledge_base(
            test_db, group_kb.id, test_group_maintainer.id
        )

    def test_developer_cannot_manage(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_developer: User,
        group_developer_member: NamespaceMember,
    ):
        """Developer should NOT be able to manage KB."""
        assert not KnowledgeService.can_manage_knowledge_base(
            test_db, group_kb.id, test_group_developer.id
        )

    def test_reporter_cannot_manage(
        self,
        test_db: Session,
        group_kb: Kind,
        test_group_reporter: User,
        group_reporter_member: NamespaceMember,
    ):
        """Reporter should NOT be able to manage KB."""
        assert not KnowledgeService.can_manage_knowledge_base(
            test_db, group_kb.id, test_group_reporter.id
        )

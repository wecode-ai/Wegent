# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for knowledge base and document CRUD operations with permission checks.
"""

import pytest
from sqlalchemy.orm import Session

from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
    RetrievalConfigUpdate,
)
from app.services.knowledge.knowledge_service import (
    KnowledgeService,
    _check_kb_permission,
    _get_user_kb_permission_level,
)

# Fixtures are now defined in conftest.py and automatically discovered by pytest


class TestCreateKnowledgeBase:
    """Test knowledge base creation permissions."""

    def test_owner_can_create_kb(
        self,
        test_db: Session,
        test_group,
        test_group_owner,
        _group_owner_member,
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
        test_group,
        test_group_maintainer,
        _group_maintainer_member,
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
        test_group,
        test_group_developer,
        _group_developer_member,
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
        test_group,
        test_group_reporter,
        _group_reporter_member,
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


class TestUpdateKnowledgeBase:
    """Test knowledge base update permissions."""

    def test_owner_can_update_kb(
        self,
        test_db: Session,
        group_kb,
        test_group_owner,
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
        group_kb,
        test_group_maintainer,
        _group_maintainer_member,
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
        group_kb,
        test_group_developer,
        _group_developer_member,
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
        group_kb,
        test_group_developer,
        _group_developer_member,
    ):
        """Developer should NOT be able to update retrieval config."""
        update_data = KnowledgeBaseUpdate(
            name="Updated by Developer",
            retrieval_config=RetrievalConfigUpdate(
                retriever_name="test_retriever",
            ),
        )
        with pytest.raises(
            ValueError, match="Developer can only update name and description"
        ):
            KnowledgeService.update_knowledge_base(
                db=test_db,
                knowledge_base_id=group_kb.id,
                user_id=test_group_developer.id,
                data=update_data,
            )

    def test_reporter_cannot_update_kb(
        self,
        test_db: Session,
        group_kb,
        test_group_reporter,
        _group_reporter_member,
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


class TestDeleteKnowledgeBase:
    """Test knowledge base deletion permissions."""

    def test_owner_can_delete_kb(
        self,
        test_db: Session,
        test_group,
        test_group_owner,
        test_group_maintainer,
        _group_owner_member,
        _group_maintainer_member,
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
        test_group,
        test_group_owner,
        test_group_maintainer,
        _group_owner_member,
        _group_maintainer_member,
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
        group_kb,
        test_group_developer,
        _group_developer_member,
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
        group_kb,
        test_group_reporter,
        _group_reporter_member,
    ):
        """Reporter should NOT be able to delete knowledge base."""
        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.delete_knowledge_base(
                db=test_db,
                knowledge_base_id=group_kb.id,
                user_id=test_group_reporter.id,
            )


class TestCreateDocument:
    """Test document creation permissions."""

    def test_owner_can_create_document(
        self,
        test_db: Session,
        group_kb,
        test_group_owner,
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
        group_kb,
        test_group_maintainer,
        _group_maintainer_member,
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
        group_kb,
        test_group_developer,
        _group_developer_member,
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
        group_kb,
        test_group_reporter,
        _group_reporter_member,
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


class TestUpdateDocument:
    """Test document update permissions."""

    def test_owner_can_update_document(
        self,
        test_db: Session,
        group_kb_document,
        test_group_owner,
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
        group_kb_document,
        test_group_maintainer,
        _group_maintainer_member,
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
        group_kb_document,
        test_group_developer,
        _group_developer_member,
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
        group_kb_document,
        test_group_reporter,
        _group_reporter_member,
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


class TestDeleteDocument:
    """Test document deletion permissions."""

    def test_owner_can_delete_document(
        self,
        test_db: Session,
        group_kb,
        test_group_owner,
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
        group_kb,
        test_group_owner,
        test_group_maintainer,
        _group_owner_member,
        _group_maintainer_member,
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
        group_kb,
        test_group_owner,
        test_group_developer,
        _group_developer_member,
    ):
        """Developer should NOT be able to delete document."""
        # Create a document as owner first
        doc_data = KnowledgeDocumentCreate(
            name="Doc to Delete by Developer",
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

        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.delete_document(
                db=test_db,
                document_id=doc.id,
                user_id=test_group_developer.id,
            )

    def test_reporter_cannot_delete_document(
        self,
        test_db: Session,
        group_kb,
        test_group_owner,
        test_group_reporter,
        _group_reporter_member,
    ):
        """Reporter should NOT be able to delete document."""
        # Create a document as owner first
        doc_data = KnowledgeDocumentCreate(
            name="Doc to Delete by Reporter",
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

        with pytest.raises(ValueError, match="Only Owner or Maintainer"):
            KnowledgeService.delete_document(
                db=test_db,
                document_id=doc.id,
                user_id=test_group_reporter.id,
            )

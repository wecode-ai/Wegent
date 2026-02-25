# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for permission inheritance from parent groups to subgroups.
"""

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
)
from app.services.knowledge.knowledge_service import (
    KnowledgeService,
    _get_user_kb_permission_level,
)

# Fixtures are now defined in conftest.py and automatically discovered by pytest


class TestPermissionInheritance:
    """Test permission inheritance from parent groups to subgroups."""

    def test_owner_inherits_to_subgroup(
        self,
        test_db: Session,
        test_subgroup,
        test_group_owner,
        _group_owner_member,
    ):
        """Owner of parent group should inherit permissions to subgroup via group role (not creator shortcut)."""
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

        # Verify owner has manage permission via creator shortcut
        kb = test_db.query(Kind).filter(Kind.id == kb_id).first()
        level = _get_user_kb_permission_level(test_db, kb, test_group_owner.id)
        assert level == "manage"

    def test_noncreator_owner_inherits_to_subgroup(
        self,
        test_db: Session,
        test_subgroup,
        test_group_owner,
        test_group_maintainer2,
        _group_owner_member,
        _group_maintainer2_member,
    ):
        """Owner of parent group should inherit manage permission to subgroup KB created by another user."""
        # Create KB in subgroup as a different user (not group owner)
        # The maintainer2 is a Maintainer in parent group, so can create in subgroup
        kb_data = KnowledgeBaseCreate(
            name="Subgroup KB For Inheritance Test",
            description="KB in subgroup created by Maintainer in parent group",
            namespace=test_subgroup.name,
        )
        kb_id = KnowledgeService.create_knowledge_base(
            db=test_db,
            user_id=test_group_maintainer2.id,
            data=kb_data,
        )

        # Get KB
        kb = test_db.query(Kind).filter(Kind.id == kb_id).first()

        # Verify KB was created by maintainer2, not by group_owner
        assert kb.user_id == test_group_maintainer2.id
        assert kb.user_id != test_group_owner.id

        # Verify group_owner has manage permission via inheritance (not creator shortcut)
        level = _get_user_kb_permission_level(test_db, kb, test_group_owner.id)
        assert level == "manage"

    def test_developer_inherits_to_subgroup(
        self,
        test_db: Session,
        test_subgroup,
        test_group_owner,
        test_group_developer,
        _group_owner_member,
        _group_developer_member,
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
        test_subgroup,
        test_group_owner,
        test_group_developer,
        _group_owner_member,
        _group_developer_member,
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

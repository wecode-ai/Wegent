# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge folder service for multi-level document organization.

Provides CRUD operations for folder management within knowledge bases,
including tree building, cascade deletion, and document-to-folder assignment.
"""

import logging
from collections import defaultdict
from typing import Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.schemas.knowledge import (
    KnowledgeFolderCreate,
    KnowledgeFolderResponse,
    KnowledgeFolderUpdate,
)
from app.services.knowledge.knowledge_service import KnowledgeService

logger = logging.getLogger(__name__)


class KnowledgeFolderService:
    """Service for managing knowledge base folder hierarchy."""

    @staticmethod
    def _check_kb_access(db: Session, knowledge_base_id: int, user_id: int) -> Kind:
        """Verify user has read access to the knowledge base.

        Raises ValueError if access is denied or KB not found.
        """
        kb, has_access = KnowledgeService.get_knowledge_base(
            db, knowledge_base_id, user_id
        )
        if not kb or not has_access:
            raise ValueError("Knowledge base not found or access denied")
        return kb

    @staticmethod
    def _check_kb_write_access(
        db: Session, knowledge_base_id: int, user_id: int
    ) -> Kind:
        """Verify user has write access to the knowledge base.

        Raises ValueError if access is denied or KB not found.
        """
        kb = KnowledgeFolderService._check_kb_access(db, knowledge_base_id, user_id)
        if not KnowledgeService.can_manage_knowledge_base_documents(
            db, knowledge_base_id, user_id
        ):
            raise ValueError("You do not have permission to modify this knowledge base")
        return kb

    @staticmethod
    def create_folder(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        data: KnowledgeFolderCreate,
    ) -> KnowledgeFolderResponse:
        """Create a new folder in a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Target knowledge base ID
            user_id: Requesting user ID (for access check only)
            data: Folder creation data

        Returns:
            Created folder as response schema

        Raises:
            ValueError: If parent folder doesn't exist or access is denied
        """
        KnowledgeFolderService._check_kb_write_access(db, knowledge_base_id, user_id)

        # Validate parent exists and belongs to the same KB
        if data.parent_id > 0:
            parent = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.id == data.parent_id,
                    KnowledgeFolder.kind_id == knowledge_base_id,
                )
                .first()
            )
            if not parent:
                raise ValueError(
                    f"Parent folder {data.parent_id} not found in this knowledge base"
                )

        folder = KnowledgeFolder(
            kind_id=knowledge_base_id,
            parent_id=data.parent_id,
            name=data.name.strip(),
        )
        db.add(folder)
        db.commit()
        db.refresh(folder)

        return KnowledgeFolderResponse(
            id=folder.id,
            kind_id=folder.kind_id,
            parent_id=folder.parent_id,
            name=folder.name,
            children=[],
            document_count=0,
            created_at=folder.created_at,
            updated_at=folder.updated_at,
        )

    @staticmethod
    def get_folder_tree(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> List[KnowledgeFolderResponse]:
        """Get the full folder tree for a knowledge base.

        Uses two bulk queries (folders + document counts) to avoid N+1.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            List of root-level folder nodes with nested children
        """
        KnowledgeFolderService._check_kb_access(db, knowledge_base_id, user_id)

        # Bulk load all folders in this KB
        all_folders = (
            db.query(KnowledgeFolder)
            .filter(KnowledgeFolder.kind_id == knowledge_base_id)
            .order_by(KnowledgeFolder.name)
            .all()
        )

        # Bulk load document counts per folder
        doc_counts: Dict[int, int] = defaultdict(int)
        counts = (
            db.query(
                KnowledgeDocument.folder_id,
                func.count(KnowledgeDocument.id),
            )
            .filter(KnowledgeDocument.kind_id == knowledge_base_id)
            .group_by(KnowledgeDocument.folder_id)
            .all()
        )
        for folder_id, count in counts:
            doc_counts[folder_id] = count

        # Build folder lookup and children map
        folder_map: Dict[int, KnowledgeFolderResponse] = {}
        children_map: Dict[int, List[KnowledgeFolderResponse]] = defaultdict(list)

        for f in all_folders:
            node = KnowledgeFolderResponse(
                id=f.id,
                kind_id=f.kind_id,
                parent_id=f.parent_id,
                name=f.name,
                children=[],
                document_count=doc_counts.get(f.id, 0),
                created_at=f.created_at,
                updated_at=f.updated_at,
            )
            folder_map[f.id] = node
            children_map[f.parent_id].append(node)

        # Recursively build the tree
        def attach_children(pid: int) -> List[KnowledgeFolderResponse]:
            result = []
            for child in children_map.get(pid, []):
                child.children = attach_children(child.id)
                result.append(child)
            return result

        return attach_children(0)

    @staticmethod
    def get_folder(
        db: Session,
        folder_id: int,
        user_id: int,
    ) -> KnowledgeFolder:
        """Get a single folder by ID with access check.

        Raises ValueError if folder not found or access denied.
        """
        folder = (
            db.query(KnowledgeFolder).filter(KnowledgeFolder.id == folder_id).first()
        )
        if not folder:
            raise ValueError("Folder not found")

        # Access check via KB ownership
        KnowledgeFolderService._check_kb_access(db, folder.kind_id, user_id)
        return folder

    @staticmethod
    def update_folder(
        db: Session,
        folder_id: int,
        user_id: int,
        data: KnowledgeFolderUpdate,
    ) -> KnowledgeFolderResponse:
        """Update a folder (rename and/or move).

        Args:
            db: Database session
            folder_id: Target folder ID
            user_id: Requesting user ID
            data: Update data

        Returns:
            Updated folder as response

        Raises:
            ValueError: If folder not found, circular move, or access denied
        """
        folder = KnowledgeFolderService.get_folder(db, folder_id, user_id)

        if data.name is not None:
            folder.name = data.name.strip()

        if data.parent_id is not None:
            new_parent_id = data.parent_id
            # Prevent circular reference: cannot set parent to self or descendant
            if new_parent_id > 0:
                # Validate target parent exists
                if new_parent_id == folder_id:
                    raise ValueError("Cannot move a folder into itself")
                new_parent = KnowledgeFolderService.get_folder(
                    db, new_parent_id, user_id
                )
                if new_parent.kind_id != folder.kind_id:
                    raise ValueError(
                        "Target parent folder does not belong to the same knowledge base"
                    )
                # Collect all descendant IDs to prevent circular moves
                descendant_ids = KnowledgeFolderService._collect_descendant_ids(
                    db, folder.id, folder.kind_id
                )
                if new_parent_id in descendant_ids:
                    raise ValueError("Cannot move a folder into one of its descendants")
            folder.parent_id = new_parent_id

        db.commit()
        db.refresh(folder)

        return KnowledgeFolderResponse(
            id=folder.id,
            kind_id=folder.kind_id,
            parent_id=folder.parent_id,
            name=folder.name,
            children=[],
            document_count=KnowledgeFolderService._count_folder_docs(db, folder.id),
            created_at=folder.created_at,
            updated_at=folder.updated_at,
        )

    @staticmethod
    def delete_folder(
        db: Session,
        folder_id: int,
        user_id: int,
    ) -> dict:
        """Delete a folder and all its contents recursively.

        Deletes all descendant folders and moves all documents in the deleted
        folders to root level (folder_id=0).

        Args:
            db: Database session
            folder_id: Folder to delete
            user_id: Requesting user ID

        Returns:
            Dict with deleted_folder_count and moved_document_count

        Raises:
            ValueError: If folder not found or access denied
        """
        folder = KnowledgeFolderService.get_folder(db, folder_id, user_id)

        # Collect all descendant folder IDs (including self)
        descendant_ids = KnowledgeFolderService._collect_descendant_ids(
            db, folder_id, folder.kind_id
        )
        descendant_ids.add(folder_id)

        # Move documents in the deleted folders back to root level
        moved_count = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == folder.kind_id,
                KnowledgeDocument.folder_id.in_(descendant_ids),
            )
            .update({"folder_id": 0}, synchronize_session=False)
        )

        # Delete all descendant folders (children first via ordered delete)
        # Delete deeper folders first to avoid FK issues
        all_descendant_folders = (
            db.query(KnowledgeFolder)
            .filter(KnowledgeFolder.id.in_(descendant_ids))
            .order_by(KnowledgeFolder.parent_id.desc())
            .all()
        )
        for f in all_descendant_folders:
            db.delete(f)

        db.commit()

        logger.info(
            "Deleted folder %d and %d descendants, moved %d documents to root",
            folder_id,
            len(descendant_ids) - 1,
            moved_count,
        )

        return {
            "deleted_folder_count": len(all_descendant_folders),
            "moved_document_count": moved_count,
        }

    @staticmethod
    def move_document(
        db: Session,
        document_id: int,
        folder_id: int,
        user_id: int,
    ) -> KnowledgeDocument:
        """Move a document to a different folder.

        Args:
            db: Database session
            document_id: Document to move
            folder_id: Target folder ID (0 = root)
            user_id: Requesting user ID

        Returns:
            Updated KnowledgeDocument

        Raises:
            ValueError: If document not found, target folder invalid, or access denied
        """
        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            raise ValueError("Document not found or access denied")

        # Validate target folder if not root
        if folder_id > 0:
            target_folder = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.id == folder_id,
                    KnowledgeFolder.kind_id == doc.kind_id,
                )
                .first()
            )
            if not target_folder:
                raise ValueError("Target folder not found in this knowledge base")

        doc.folder_id = folder_id
        db.commit()
        db.refresh(doc)
        return doc

    @staticmethod
    def _collect_descendant_ids(db: Session, folder_id: int, kind_id: int) -> set:
        """Collect all descendant folder IDs for a given folder.

        Uses iterative BFS scoped to a single knowledge base to avoid
        recursion limits and cross-KB traversal.
        """
        descendant_ids: set = set()
        queue = [folder_id]

        while queue:
            current = queue.pop(0)
            children = (
                db.query(KnowledgeFolder.id)
                .filter(
                    KnowledgeFolder.parent_id == current,
                    KnowledgeFolder.kind_id == kind_id,
                )
                .all()
            )
            for (child_id,) in children:
                if child_id not in descendant_ids:
                    descendant_ids.add(child_id)
                    queue.append(child_id)

        return descendant_ids

    @staticmethod
    def _count_folder_docs(db: Session, folder_id: int) -> int:
        """Count documents directly in a folder."""
        return (
            db.query(func.count(KnowledgeDocument.id))
            .filter(KnowledgeDocument.folder_id == folder_id)
            .scalar()
        ) or 0

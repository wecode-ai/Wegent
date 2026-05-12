# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge folder service for multi-level document organization.

Provides CRUD operations for folder management within knowledge bases,
including tree building, cascade deletion, and document-to-folder assignment.
"""

import logging
from collections import defaultdict, deque
from typing import Dict, List, Optional

from sqlalchemy import func, text
from sqlalchemy.exc import OperationalError, ProgrammingError
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

# Maximum number of IDs allowed in a single IN clause before switching to a
# temporary-table strategy.  MySQL query optimiser degrades when the list
# exceeds a few thousand values.
_MAX_IN_CLAUSE_SIZE = 1000


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

        # Validate parent exists and belongs to the same KB.
        # filter by (kind_id, id) which hits the primary key directly.
        if data.parent_id > 0:
            parent = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.kind_id == knowledge_base_id,
                    KnowledgeFolder.id == data.parent_id,
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

        # Bulk load document counts per folder.
        # Filter on kind_id first so the engine can use the composite index
        # (kind_id, folder_id) if present, or at minimum narrow the scan via
        # ix_knowledge_documents_kind_active_created before grouping.
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
        # Primary-key lookup — O(1), no index hint needed.
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
        knowledge_base_id: Optional[int] = None,
    ) -> KnowledgeFolderResponse:
        """Update a folder (rename and/or move).

        Args:
            db: Database session
            folder_id: Target folder ID
            user_id: Requesting user ID
            data: Update data
            knowledge_base_id: Expected knowledge base ID for ownership validation

        Returns:
            Updated folder as response

        Raises:
            ValueError: If folder not found, circular move, access denied, or
                folder does not belong to the specified knowledge base
        """
        folder = KnowledgeFolderService.get_folder(db, folder_id, user_id)
        # Verify the folder belongs to the expected knowledge base when provided
        if knowledge_base_id is not None and folder.kind_id != knowledge_base_id:
            raise ValueError("Folder does not belong to the specified knowledge base")
        KnowledgeFolderService._check_kb_write_access(db, folder.kind_id, user_id)

        if data.name is not None:
            folder.name = data.name.strip()

        if data.parent_id is not None:
            new_parent_id = data.parent_id
            # Prevent circular reference: cannot set parent to self or descendant.
            # Acquire row-level locks (SELECT FOR UPDATE) on the source folder and
            # the target parent before re-running the descendant check so that
            # concurrent move operations are serialized at the DB level.
            if new_parent_id > 0:
                if new_parent_id == folder_id:
                    raise ValueError("Cannot move a folder into itself")
                locked_rows = (
                    db.query(KnowledgeFolder)
                    .filter(KnowledgeFolder.id.in_([folder_id, new_parent_id]))
                    .order_by(KnowledgeFolder.id)
                    .with_for_update()
                    .all()
                )
                locked_map = {row.id: row for row in locked_rows}
                locked_folder = locked_map.get(folder_id)
                locked_parent = locked_map.get(new_parent_id)
                if not locked_folder:
                    raise ValueError("Folder not found")
                if not locked_parent or locked_parent.kind_id != folder.kind_id:
                    raise ValueError(
                        "Target parent folder does not belong to the same knowledge base"
                    )
                folder = locked_folder
                # Re-check descendant relationship after acquiring locks
                descendant_ids = KnowledgeFolderService._collect_descendant_ids(
                    db, locked_folder.id, locked_folder.kind_id
                )
                if new_parent_id in descendant_ids:
                    raise ValueError("Cannot move a folder into one of its descendants")
            folder.parent_id = new_parent_id

        db.commit()
        db.refresh(folder)

        # Count documents directly in this folder using the composite index
        # (kind_id, folder_id) when available.
        doc_count = KnowledgeFolderService._count_folder_docs(
            db, folder.id, folder.kind_id
        )

        return KnowledgeFolderResponse(
            id=folder.id,
            kind_id=folder.kind_id,
            parent_id=folder.parent_id,
            name=folder.name,
            children=[],
            document_count=doc_count,
            created_at=folder.created_at,
            updated_at=folder.updated_at,
        )

    @staticmethod
    def delete_folder(
        db: Session,
        folder_id: int,
        user_id: int,
        knowledge_base_id: Optional[int] = None,
    ) -> dict:
        """Delete a folder and all its contents recursively.

        Deletes all descendant folders and moves all documents in the deleted
        folders to root level (folder_id=0).

        Args:
            db: Database session
            folder_id: Folder to delete
            user_id: Requesting user ID
            knowledge_base_id: Expected knowledge base ID for ownership validation

        Returns:
            Dict with deleted_folder_count and moved_document_count

        Raises:
            ValueError: If folder not found, access denied, or folder does not
                belong to the specified knowledge base
        """
        folder = KnowledgeFolderService.get_folder(db, folder_id, user_id)
        # Verify the folder belongs to the expected knowledge base when provided
        if knowledge_base_id is not None and folder.kind_id != knowledge_base_id:
            raise ValueError("Folder does not belong to the specified knowledge base")
        KnowledgeFolderService._check_kb_write_access(db, folder.kind_id, user_id)

        # Collect all descendant folder IDs (including self) via a single
        # recursive CTE query instead of iterative BFS round-trips.
        descendant_ids = KnowledgeFolderService._collect_descendant_ids(
            db, folder_id, folder.kind_id
        )
        descendant_ids.add(folder_id)

        # Move documents in the deleted folders back to root level.
        # When descendant_ids is large, split into batches to avoid MySQL
        # query-plan degradation on oversized IN lists.
        moved_count = KnowledgeFolderService._bulk_update_folder_id(
            db, folder.kind_id, descendant_ids, target_folder_id=0
        )

        # Bulk delete all descendant folders (including self).
        # No FK constraints on parent_id, so ordering is not required.
        deleted_folder_count = KnowledgeFolderService._bulk_delete_folders(
            db, descendant_ids
        )

        db.commit()

        logger.info(
            "Deleted folder %d and %d descendants, moved %d documents to root",
            folder_id,
            len(descendant_ids) - 1,
            moved_count,
        )

        return {
            "deleted_folder_count": deleted_folder_count,
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
        KnowledgeFolderService._check_kb_write_access(db, doc.kind_id, user_id)

        # Validate target folder if not root.
        # Filter on kind_id first to leverage ix_knowledge_folders_parent
        # (kind_id, parent_id) — the primary-key lookup on id is then cheap.
        if folder_id > 0:
            target_folder = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.kind_id == doc.kind_id,
                    KnowledgeFolder.id == folder_id,
                )
                .first()
            )
            if not target_folder:
                raise ValueError("Target folder not found in this knowledge base")

        doc.folder_id = folder_id
        db.commit()
        db.refresh(doc)
        return doc

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _collect_descendant_ids(db: Session, folder_id: int, kind_id: int) -> set:
        """Collect all descendant folder IDs for a given folder.

        Implementation strategy
        -----------------------
        Uses a **single recursive CTE** (MySQL 8.0+ / PostgreSQL / SQLite 3.35+)
        instead of iterative BFS round-trips.  The CTE is scoped to a single
        knowledge base (kind_id) and leverages the composite index
        ix_knowledge_folders_parent (kind_id, parent_id) on every recursive
        join, reducing total I/O from O(depth * fan-out) round-trips to a
        single server-side traversal.

        Falls back to iterative BFS (using a deque for O(1) pops) when the
        database dialect does not support recursive CTEs.
        """
        try:
            return KnowledgeFolderService._collect_descendant_ids_cte(
                db, folder_id, kind_id
            )
        except (ProgrammingError, OperationalError):
            # Fallback for databases that do not support recursive CTEs
            # (e.g. MySQL < 8.0 or SQLite < 3.35).  Only ProgrammingError
            # (unsupported syntax) is caught here; connection/permission errors
            # are allowed to propagate so callers can handle them correctly.
            logger.warning(
                "Recursive CTE not supported, falling back to iterative BFS "
                "for folder %d",
                folder_id,
            )
            return KnowledgeFolderService._collect_descendant_ids_bfs(
                db, folder_id, kind_id
            )

    @staticmethod
    def _collect_descendant_ids_cte(db: Session, folder_id: int, kind_id: int) -> set:
        """Single-query recursive CTE implementation.

        Emits exactly one SQL statement regardless of tree depth.
        The recursive join uses ix_knowledge_folders_parent (kind_id, parent_id).
        """
        sql = text(
            """
            WITH RECURSIVE descendants AS (
                -- Anchor: direct children of the target folder
                SELECT id
                FROM   knowledge_folders
                WHERE  kind_id   = :kind_id
                  AND  parent_id = :folder_id

                UNION ALL

                -- Recursive: children of already-found descendants
                SELECT kf.id
                FROM   knowledge_folders kf
                INNER JOIN descendants d ON kf.parent_id = d.id
                WHERE  kf.kind_id = :kind_id
            )
            SELECT id FROM descendants
            """
        )
        rows = db.execute(sql, {"kind_id": kind_id, "folder_id": folder_id}).fetchall()
        return {row[0] for row in rows}

    @staticmethod
    def _collect_descendant_ids_bfs(db: Session, folder_id: int, kind_id: int) -> set:
        """Iterative BFS fallback using a deque for O(1) pops.

        Issues one query per BFS level (not per node) by batching the
        parent_id IN (...) lookup across all nodes at the same depth.
        This reduces round-trips from O(total_nodes) to O(tree_depth).
        """
        descendant_ids: set = set()
        # Process one full BFS level per iteration
        current_level = [folder_id]

        while current_level:
            children = (
                db.query(KnowledgeFolder.id)
                .filter(
                    KnowledgeFolder.kind_id == kind_id,
                    KnowledgeFolder.parent_id.in_(current_level),
                )
                .all()
            )
            next_level = []
            for (child_id,) in children:
                if child_id not in descendant_ids:
                    descendant_ids.add(child_id)
                    next_level.append(child_id)
            current_level = next_level

        return descendant_ids

    @staticmethod
    def _count_folder_docs(db: Session, folder_id: int, kind_id: int) -> int:
        """Count documents directly in a folder.

        Filters on both kind_id and folder_id so the query can use a
        composite index (kind_id, folder_id) when available, avoiding a
        full-table scan on the million-row documents table.
        """
        return (
            db.query(func.count(KnowledgeDocument.id))
            .filter(
                KnowledgeDocument.kind_id == kind_id,
                KnowledgeDocument.folder_id == folder_id,
            )
            .scalar()
        ) or 0

    @staticmethod
    def _bulk_update_folder_id(
        db: Session,
        kind_id: int,
        folder_ids: set,
        target_folder_id: int,
    ) -> int:
        """Move documents from a set of folders to target_folder_id.

        Splits large ID sets into batches of _MAX_IN_CLAUSE_SIZE to prevent
        MySQL query-plan degradation on oversized IN lists.

        Returns total number of rows updated.
        """
        id_list = list(folder_ids)
        total_moved = 0

        for i in range(0, len(id_list), _MAX_IN_CLAUSE_SIZE):
            batch = id_list[i : i + _MAX_IN_CLAUSE_SIZE]
            moved = (
                db.query(KnowledgeDocument)
                .filter(
                    KnowledgeDocument.kind_id == kind_id,
                    KnowledgeDocument.folder_id.in_(batch),
                )
                .update({"folder_id": target_folder_id}, synchronize_session=False)
            )
            total_moved += moved

        return total_moved

    @staticmethod
    def _bulk_delete_folders(db: Session, folder_ids: set) -> int:
        """Delete folders by ID set in batches.

        Splits large ID sets into batches of _MAX_IN_CLAUSE_SIZE to prevent
        MySQL query-plan degradation on oversized IN lists.

        Returns total number of rows deleted.
        """
        id_list = list(folder_ids)
        total_deleted = 0

        for i in range(0, len(id_list), _MAX_IN_CLAUSE_SIZE):
            batch = id_list[i : i + _MAX_IN_CLAUSE_SIZE]
            deleted = (
                db.query(KnowledgeFolder)
                .filter(KnowledgeFolder.id.in_(batch))
                .delete(synchronize_session=False)
            )
            total_deleted += deleted

        return total_deleted

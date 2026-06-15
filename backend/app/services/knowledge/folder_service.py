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

from sqlalchemy import func, text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.schemas.base_role import BaseRole
from app.schemas.knowledge import (
    BatchOperationResult,
    KnowledgeFolderCreate,
    KnowledgeFolderResponse,
    KnowledgeFolderUpdate,
)
from app.services.knowledge.folder_policy import (
    assert_document_can_be_placed_in_folder,
    get_folder_depth,
    get_subtree_max_relative_depth,
    validate_document_target_folder_depth,
    validate_folder_move_depth,
    validate_new_folder_depth,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.permission_policy import (
    can_manage_accessible_knowledge_document,
)

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
        validate_new_folder_depth(db, knowledge_base_id, data.parent_id)

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
                locked_subtree_rows = (
                    db.query(KnowledgeFolder)
                    .filter(
                        KnowledgeFolder.kind_id == locked_folder.kind_id,
                        KnowledgeFolder.id.in_(descendant_ids),
                    )
                    .all()
                )
                folder_map = {
                    row.id: row
                    for row in [locked_folder, locked_parent, *locked_subtree_rows]
                }
                target_parent_depth = get_folder_depth(
                    db,
                    locked_folder.kind_id,
                    new_parent_id,
                    folder_map=folder_map,
                )
                subtree_max_depth = get_subtree_max_relative_depth(
                    folder_map, locked_folder.id
                )
                validate_folder_move_depth(
                    target_parent_depth=target_parent_depth,
                    subtree_max_relative_depth=subtree_max_depth,
                )
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
            target_folder = assert_document_can_be_placed_in_folder(
                db, doc.kind_id, folder_id
            )
            folder_id = target_folder.id

        doc.folder_id = folder_id
        db.commit()
        db.refresh(doc)
        return doc

    @staticmethod
    def batch_move_documents(
        db: Session,
        document_ids: list[int],
        folder_id: int,
        user_id: int,
    ) -> BatchOperationResult:
        """Batch move multiple documents to a target folder.

        Loads documents, knowledge-base permissions, and target folder data in
        bulk, then updates movable documents with one statement per knowledge
        base. Permission and validation errors are still reported per document.

        Args:
            db: Database session
            document_ids: List of document IDs to move
            folder_id: Target folder ID (0 = root)
            user_id: Requesting user ID

        Returns:
            BatchOperationResult with success/failure counts
        """
        if not document_ids:
            return BatchOperationResult(
                success_count=0,
                failed_count=0,
                failed_ids=[],
                message="Successfully moved 0 documents, 0 failed",
            )

        requested_ids = list(dict.fromkeys(document_ids))
        docs = KnowledgeFolderService._bulk_load_documents(db, requested_ids)
        docs_by_id = {doc.id: doc for doc in docs}
        failed_id_set = set(requested_ids) - set(docs_by_id)

        kb_ids = {doc.kind_id for doc in docs}
        kb_permissions = KnowledgeFolderService._bulk_resolve_document_permissions(
            db, kb_ids, user_id
        )
        folder_validation = KnowledgeFolderService._bulk_validate_target_folder(
            db, kb_ids, folder_id
        )

        movable_ids_by_kb: dict[int, list[int]] = defaultdict(list)
        for doc in docs:
            permission = kb_permissions.get(doc.kind_id)
            if permission is None:
                failed_id_set.add(doc.id)
                continue
            has_access, role, is_creator = permission
            if not can_manage_accessible_knowledge_document(
                has_access=has_access,
                role=role,
                is_creator=is_creator,
                user_id=user_id,
                document_owner_id=doc.user_id,
            ):
                failed_id_set.add(doc.id)
                continue
            validated_folder_id = folder_validation.get(doc.kind_id)
            if validated_folder_id is None:
                failed_id_set.add(doc.id)
                continue
            movable_ids_by_kb[doc.kind_id].append(doc.id)

        success_count = KnowledgeFolderService._bulk_move_documents_by_kb(
            db, movable_ids_by_kb, folder_id
        )
        db.commit()

        failed_ids = [doc_id for doc_id in requested_ids if doc_id in failed_id_set]
        return BatchOperationResult(
            success_count=success_count,
            failed_count=len(failed_ids),
            failed_ids=failed_ids,
            message=(
                f"Successfully moved {success_count} documents, "
                f"{len(failed_ids)} failed"
            ),
        )

    @staticmethod
    def resolve_document_ids_for_scope(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        folder_ids: list[int] | None = None,
        document_ids: list[int] | None = None,
        include_subfolders: bool = True,
    ) -> list[int]:
        """Resolve folder/document scope into document IDs for retrieval.

        ``folder_ids=[0]`` means root-level documents only.  Folder ``0`` is
        not a real tree node and is never expanded to the whole knowledge base.
        """
        KnowledgeFolderService._check_kb_access(db, knowledge_base_id, user_id)

        if folder_ids == []:
            raise ValueError("folder_ids must not be empty")
        if document_ids == []:
            raise ValueError("document_ids must not be empty")

        resolved_ids: list[int] = []
        seen_document_ids: set[int] = set()

        if document_ids:
            unique_document_ids = list(dict.fromkeys(document_ids))
            documents = KnowledgeFolderService._bulk_load_documents(
                db, unique_document_ids
            )
            documents_by_id = {doc.id: doc for doc in documents}
            for document_id in unique_document_ids:
                document = documents_by_id.get(document_id)
                if document is None or document.kind_id != knowledge_base_id:
                    raise ValueError(
                        f"Document {document_id} not found in this knowledge base"
                    )
                if document.id not in seen_document_ids:
                    seen_document_ids.add(document.id)
                    resolved_ids.append(document.id)

        if folder_ids:
            folder_id_set = set(folder_ids)
            positive_folder_ids = [
                folder_id for folder_id in folder_ids if folder_id > 0
            ]
            if positive_folder_ids:
                folders = (
                    db.query(KnowledgeFolder)
                    .filter(
                        KnowledgeFolder.kind_id == knowledge_base_id,
                        KnowledgeFolder.id.in_(positive_folder_ids),
                    )
                    .all()
                )
                found_folder_ids = {folder.id for folder in folders}
                for folder_id in positive_folder_ids:
                    if folder_id not in found_folder_ids:
                        raise ValueError(
                            f"Folder {folder_id} not found in this knowledge base"
                        )
                    if include_subfolders:
                        folder_id_set.update(
                            KnowledgeFolderService._collect_descendant_ids(
                                db, folder_id, knowledge_base_id
                            )
                        )

            folder_documents = (
                db.query(KnowledgeDocument.id)
                .filter(
                    KnowledgeDocument.kind_id == knowledge_base_id,
                    KnowledgeDocument.folder_id.in_(folder_id_set),
                )
                .order_by(KnowledgeDocument.id)
                .all()
            )
            for (document_id,) in folder_documents:
                if document_id not in seen_document_ids:
                    seen_document_ids.add(document_id)
                    resolved_ids.append(document_id)

        return resolved_ids

    @staticmethod
    def _bulk_load_documents(
        db: Session, document_ids: list[int]
    ) -> list[KnowledgeDocument]:
        """Load requested documents in batches to avoid per-document queries."""
        documents: list[KnowledgeDocument] = []
        for i in range(0, len(document_ids), _MAX_IN_CLAUSE_SIZE):
            batch = document_ids[i : i + _MAX_IN_CLAUSE_SIZE]
            documents.extend(
                db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id.in_(batch))
                .all()
            )
        return documents

    @staticmethod
    def _bulk_resolve_document_permissions(
        db: Session,
        knowledge_base_ids: set[int],
        user_id: int,
    ) -> dict[int, tuple[bool, BaseRole | None, bool]]:
        """Resolve user permissions for all touched knowledge bases once."""
        return {
            kb_id: KnowledgeService._get_user_kb_permission(db, kb_id, user_id)
            for kb_id in knowledge_base_ids
        }

    @staticmethod
    def _bulk_validate_target_folder(
        db: Session,
        knowledge_base_ids: set[int],
        folder_id: int,
    ) -> dict[int, int | None]:
        """Validate the common target folder for every touched knowledge base."""
        if folder_id <= 0:
            return {kb_id: 0 for kb_id in knowledge_base_ids}

        target_folders = (
            db.query(KnowledgeFolder)
            .filter(
                KnowledgeFolder.id == folder_id,
                KnowledgeFolder.kind_id.in_(knowledge_base_ids),
            )
            .all()
        )
        folders_by_kb = {folder.kind_id: folder for folder in target_folders}
        folder_validation: dict[int, int | None] = {}
        for kb_id in knowledge_base_ids:
            folder = folders_by_kb.get(kb_id)
            if folder is None:
                folder_validation[kb_id] = None
                continue
            validate_document_target_folder_depth(db, kb_id, folder.id)
            folder_validation[kb_id] = folder.id
        return folder_validation

    @staticmethod
    def _bulk_move_documents_by_kb(
        db: Session,
        document_ids_by_kb: dict[int, list[int]],
        target_folder_id: int,
    ) -> int:
        """Update movable documents in batches grouped by knowledge base."""
        total_moved = 0
        for kb_id, ids in document_ids_by_kb.items():
            for i in range(0, len(ids), _MAX_IN_CLAUSE_SIZE):
                batch = ids[i : i + _MAX_IN_CLAUSE_SIZE]
                total_moved += (
                    db.query(KnowledgeDocument)
                    .filter(
                        KnowledgeDocument.kind_id == kb_id,
                        KnowledgeDocument.id.in_(batch),
                    )
                    .update(
                        {"folder_id": target_folder_id},
                        synchronize_session=False,
                    )
                )
        return total_moved

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
                FROM knowledge_folders
                WHERE kind_id = :kind_id
                  AND parent_id = :folder_id

                UNION ALL

                -- Recursive: children of already-found descendants
                SELECT kf.id
                FROM knowledge_folders kf
                         INNER JOIN descendants d ON kf.parent_id = d.id
                WHERE kf.kind_id = :kind_id)
            SELECT id
            FROM descendants
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

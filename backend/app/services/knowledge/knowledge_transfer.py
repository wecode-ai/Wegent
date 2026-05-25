# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base migration and document transfer service."""

import logging

from fastapi import status
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.exceptions import CustomHTTPException, StructuredValidationException
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument, KnowledgeFolder
from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.knowledge import TransferDocumentsResponse
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.group_permission import get_effective_role_in_group
from app.services.knowledge.knowledge_service import (
    KnowledgeService,
    _get_delete_gateway,
    _run_async_in_new_loop,
)

# ============== Error Codes for i18n ==============

# Migration error codes
KB_NOT_FOUND = "KB_NOT_FOUND"
KB_NOT_PERSONAL = "KB_NOT_PERSONAL"
KB_NOT_CREATOR = "KB_NOT_CREATOR"
KB_NO_GROUP_ACCESS = "KB_NO_GROUP_ACCESS"
KB_INSUFFICIENT_PERMISSION = "KB_INSUFFICIENT_PERMISSION"
KB_DUPLICATE_NAME_IN_GROUP = "KB_DUPLICATE_NAME_IN_GROUP"
KB_MIGRATE_CONFLICT = "KB_MIGRATE_CONFLICT"

# Transfer error codes
SOURCE_TARGET_SAME = "SOURCE_TARGET_SAME"
SOURCE_KB_NOT_FOUND = "SOURCE_KB_NOT_FOUND"
TARGET_KB_NOT_FOUND = "TARGET_KB_NOT_FOUND"
INVALID_TRANSFER_NAMESPACE = "INVALID_TRANSFER_NAMESPACE"
FOLDERS_NOT_FOUND = "FOLDERS_NOT_FOUND"
DOCS_NOT_FOUND = "DOCS_NOT_FOUND"
NOTEBOOK_DOC_LIMIT_EXCEEDED = "NOTEBOOK_DOC_LIMIT_EXCEEDED"


class KnowledgeTransferService:
    """Service for knowledge base migration and document transfer operations."""

    # ============== Knowledge Base Migration ==============

    @staticmethod
    def migrate_knowledge_base_to_group(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        target_group_name: str,
    ) -> dict:
        """
        Migrate a personal knowledge base to a group.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID to migrate
            user_id: Requesting user ID (must be the creator of the KB)
            target_group_name: Target group name (namespace) to migrate to

        Returns:
            Dict with migration result information

        Raises:
            ValueError: If validation fails or permission denied
        """
        from sqlalchemy.orm.attributes import flag_modified

        # Get the knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )

        if not kb:
            raise CustomHTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Knowledge base not found",
                error_code=KB_NOT_FOUND,
            )

        # Only personal knowledge bases (namespace='default') can be migrated
        if kb.namespace != "default":
            raise CustomHTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only personal knowledge bases can be migrated to groups",
                error_code=KB_NOT_PERSONAL,
            )

        # Only the creator can migrate
        if kb.user_id != user_id:
            raise CustomHTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only the creator can migrate this knowledge base",
                error_code=KB_NOT_CREATOR,
            )

        # Check if user has access to the target group
        target_role = get_effective_role_in_group(db, user_id, target_group_name)
        if target_role is None:
            raise CustomHTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You don't have access to group '{target_group_name}'",
                error_code=KB_NO_GROUP_ACCESS,
            )

        # Check if user has Maintainer+ permission in target group
        if target_role not in {GroupRole.Owner, GroupRole.Maintainer}:
            raise CustomHTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You need Maintainer or Owner permission in the target group to migrate knowledge bases",
                error_code=KB_INSUFFICIENT_PERMISSION,
            )

        # Check for duplicate name in target group
        kb_spec = kb.json.get("spec", {})
        kb_name = kb_spec.get("name", "")

        existing_in_target = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.namespace == target_group_name,
            )
            .all()
        )

        for existing_kb in existing_in_target:
            existing_spec = existing_kb.json.get("spec", {})
            if existing_spec.get("name") == kb_name:
                raise CustomHTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"A knowledge base with name '{kb_name}' already exists in the target group",
                    error_code=KB_DUPLICATE_NAME_IN_GROUP,
                )

        # Store old namespace for response
        old_namespace = kb.namespace

        # Update the namespace
        kb.namespace = target_group_name

        # Update the name in Kind record to reflect new namespace
        # Format: kb-{user_id}-{namespace}-{name}
        new_kb_name = f"kb-{user_id}-{target_group_name}-{kb_name}"
        kb.name = new_kb_name

        # Update the namespace in the JSON spec as well
        kb_json = kb.json
        if "metadata" not in kb_json:
            kb_json["metadata"] = {}
        kb_json["metadata"]["namespace"] = target_group_name
        kb_json["metadata"]["name"] = new_kb_name
        kb.json = kb_json
        flag_modified(kb, "json")

        db.commit()
        db.refresh(kb)

        return {
            "success": True,
            "message": f"Knowledge base '{kb_name}' migrated to group '{target_group_name}' successfully",
            "knowledge_base_id": kb.id,
            "old_namespace": old_namespace,
            "new_namespace": target_group_name,
        }

    # ============== Document Transfer Between Knowledge Bases ==============

    @staticmethod
    def validate_kb_access_and_fetch(
        db: Session,
        source_kb_id: int,
        target_kb_id: int,
        user_id: int,
    ) -> tuple[Kind, Kind]:
        """Validate KB write access and fetch source/target KB records."""
        from app.services.knowledge.folder_service import KnowledgeFolderService

        try:
            KnowledgeFolderService._check_kb_write_access(db, source_kb_id, user_id)
            KnowledgeFolderService._check_kb_write_access(db, target_kb_id, user_id)
        except ValueError as e:
            raise CustomHTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=str(e),
                error_code=KB_INSUFFICIENT_PERMISSION,
            ) from e

        if source_kb_id == target_kb_id:
            raise CustomHTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Source and target knowledge bases must be different",
                error_code=SOURCE_TARGET_SAME,
            )

        source_kb = (
            db.query(Kind)
            .filter(Kind.id == source_kb_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if not source_kb:
            raise CustomHTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Source knowledge base not found",
                error_code=SOURCE_KB_NOT_FOUND,
            )

        target_kb = (
            db.query(Kind)
            .filter(Kind.id == target_kb_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if not target_kb:
            raise CustomHTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target knowledge base not found",
                error_code=TARGET_KB_NOT_FOUND,
            )

        KnowledgeTransferService.validate_transfer_namespace(db, source_kb, target_kb)

        return source_kb, target_kb

    @staticmethod
    def _get_transfer_namespace_level(db: Session, namespace: str) -> str:
        """Return normalized namespace level for transfer rules."""
        if namespace == "default":
            return "personal"
        ns = (
            db.query(Namespace)
            .filter(Namespace.name == namespace, Namespace.is_active == True)
            .first()
        )
        if ns and ns.level == GroupLevel.organization.value:
            return "organization"
        return "group"

    @staticmethod
    def validate_transfer_namespace(
        db: Session, source_kb: Kind, target_kb: Kind
    ) -> None:
        """Validate allowed transfer directions between namespace levels."""
        source_level = KnowledgeTransferService._get_transfer_namespace_level(
            db, source_kb.namespace
        )
        target_level = KnowledgeTransferService._get_transfer_namespace_level(
            db, target_kb.namespace
        )
        allowed_targets = {
            "personal": {"personal", "group", "organization"},
            "group": {"personal", "group", "organization"},
            "organization": {"organization"},
        }
        if target_level not in allowed_targets[source_level]:
            raise CustomHTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid target knowledge base namespace for document transfer",
                error_code=INVALID_TRANSFER_NAMESPACE,
            )

    @staticmethod
    def collect_transfer_doc_and_folder_ids(
        db: Session,
        source_kb_id: int,
        document_ids: list[int],
        folder_ids: list[int],
    ) -> tuple[set[int], set[int]]:
        """Collect document IDs and descendant folder IDs for transfer.

        When folder_ids is non-empty, all documents inside those folders
        (including sub-folders) are added to the transfer set.

        When folder_ids is empty but the explicitly requested documents
        belong to folders, the ancestor folder chain of those documents
        is collected so that the folder hierarchy can be recreated in the
        target KB.  Crucially, other documents in those folders are NOT
        added to the transfer set — only the explicitly requested ones
        are moved.
        """
        from app.services.knowledge.folder_service import KnowledgeFolderService

        all_doc_ids = set(document_ids)
        descendant_folder_ids: set[int] = set()

        if folder_ids:
            # User explicitly selected folders: transfer entire subtree
            for folder_id in folder_ids:
                descendants = KnowledgeFolderService._collect_descendant_ids(
                    db=db,
                    folder_id=folder_id,
                    kind_id=source_kb_id,
                )
                descendants.add(folder_id)
                descendant_folder_ids.update(descendants)

            folder_docs = (
                db.query(KnowledgeDocument.id)
                .filter(
                    KnowledgeDocument.kind_id == source_kb_id,
                    KnowledgeDocument.folder_id.in_(descendant_folder_ids),
                )
                .all()
            )
            all_doc_ids.update(doc_id for (doc_id,) in folder_docs)
        else:
            # No folders explicitly selected — only transfer the requested
            # documents, but still collect their ancestor folder chain so
            # the folder hierarchy is recreated in the target KB.
            if all_doc_ids:
                doc_folder_ids = (
                    db.query(KnowledgeDocument.folder_id)
                    .filter(
                        KnowledgeDocument.id.in_(all_doc_ids),
                        KnowledgeDocument.folder_id > 0,
                    )
                    .distinct()
                    .all()
                )
                direct_folder_ids = {fid for (fid,) in doc_folder_ids if fid}

                # Walk up the folder tree to collect all ancestors
                for folder_id in direct_folder_ids:
                    current_id = folder_id
                    while current_id and current_id not in descendant_folder_ids:
                        descendant_folder_ids.add(current_id)
                        folder = (
                            db.query(KnowledgeFolder)
                            .filter(
                                KnowledgeFolder.id == current_id,
                                KnowledgeFolder.kind_id == source_kb_id,
                            )
                            .first()
                        )
                        if folder and folder.parent_id and folder.parent_id > 0:
                            current_id = folder.parent_id
                        else:
                            break

        return all_doc_ids, descendant_folder_ids

    @staticmethod
    def recreate_folders_in_target(
        db: Session,
        descendant_folder_ids: set[int],
        target_kb_id: int,
        source_kb_id: int,
    ) -> tuple[dict[int, int], int]:
        """Recreate transferred folder hierarchy in the target KB."""
        old_to_new_folder: dict[int, int] = {}
        transferred_folder_count = 0

        if not descendant_folder_ids:
            return old_to_new_folder, transferred_folder_count

        source_folders = (
            db.query(KnowledgeFolder)
            .filter(
                KnowledgeFolder.id.in_(descendant_folder_ids),
                KnowledgeFolder.kind_id == source_kb_id,
            )
            .all()
        )

        # Verify all requested folders were found
        found_folder_ids = {f.id for f in source_folders}
        missing_folder_ids = descendant_folder_ids - found_folder_ids
        if missing_folder_ids:
            raise CustomHTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Folders not found in source knowledge base: {sorted(missing_folder_ids)}",
                error_code=FOLDERS_NOT_FOUND,
            )

        sorted_folders = sorted(
            source_folders,
            key=lambda folder: (
                folder.parent_id in descendant_folder_ids,
                folder.parent_id,
            ),
        )

        for source_folder in sorted_folders:
            new_parent_id = 0
            if (
                source_folder.parent_id > 0
                and source_folder.parent_id in old_to_new_folder
            ):
                new_parent_id = old_to_new_folder[source_folder.parent_id]

            # Check if a folder with the same name and parent already exists
            # in the target KB to avoid duplicates when transferring documents
            # from the same source folder in separate operations.
            existing_folder = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.kind_id == target_kb_id,
                    KnowledgeFolder.name == source_folder.name,
                    KnowledgeFolder.parent_id == new_parent_id,
                )
                .first()
            )
            if existing_folder:
                # Reuse the existing folder instead of creating a duplicate
                old_to_new_folder[source_folder.id] = existing_folder.id
                continue

            new_folder = KnowledgeFolder(
                kind_id=target_kb_id,
                parent_id=new_parent_id,
                name=source_folder.name,
            )
            db.add(new_folder)
            db.flush()
            old_to_new_folder[source_folder.id] = new_folder.id
            transferred_folder_count += 1

        return old_to_new_folder, transferred_folder_count

    @staticmethod
    def validate_transfer_document_names(
        db: Session,
        all_doc_ids: set[int],
        target_kb_id: int,
        source_kb_id: int,
    ) -> None:
        """Reject transfers that would create duplicate document names."""
        source_names = [
            name
            for (name,) in db.query(KnowledgeDocument.name)
            .filter(
                KnowledgeDocument.id.in_(all_doc_ids),
                KnowledgeDocument.kind_id == source_kb_id,
            )
            .all()
        ]
        if not source_names:
            return

        duplicate_rows = (
            db.query(KnowledgeDocument.name)
            .filter(
                KnowledgeDocument.kind_id == target_kb_id,
                KnowledgeDocument.name.in_(source_names),
            )
            .distinct()
            .all()
        )
        duplicate_names = sorted(name for (name,) in duplicate_rows)
        if duplicate_names:
            raise StructuredValidationException(
                "DUPLICATE_DOCUMENT_NAMES", {"names": duplicate_names}
            )

    @staticmethod
    def transfer_documents_mutate(
        db: Session,
        all_doc_ids: set[int],
        old_to_new_folder: dict[int, int],
        target_kb_id: int,
        source_kb_id: int,
    ) -> tuple[list[KnowledgeDocument], int]:
        """Move documents to target KB and reset index state."""
        from app.models.knowledge import DocumentIndexStatus

        docs = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.id.in_(all_doc_ids),
                KnowledgeDocument.kind_id == source_kb_id,
            )
            .with_for_update()
            .all()
        )

        # Verify all requested documents were found
        found_doc_ids = {d.id for d in docs}
        missing_doc_ids = all_doc_ids - found_doc_ids
        if missing_doc_ids:
            raise CustomHTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Documents not found in source knowledge base: {sorted(missing_doc_ids)}",
                error_code=DOCS_NOT_FOUND,
            )

        transferred_doc_count = 0
        for doc in docs:
            if doc.folder_id > 0 and doc.folder_id in old_to_new_folder:
                doc.folder_id = old_to_new_folder[doc.folder_id]
            else:
                doc.folder_id = 0

            doc.kind_id = target_kb_id
            doc.index_status = DocumentIndexStatus.NOT_INDEXED
            doc.is_active = False  # Will be set to True after successful reindexing
            transferred_doc_count += 1

        return docs, transferred_doc_count

    @staticmethod
    def cleanup_empty_folders(
        db: Session,
        source_kb_id: int,
        transferred_folder_ids: set[int],
    ) -> int:
        """Delete empty source folders using batched count queries."""

        logger = logging.getLogger(__name__)
        if not transferred_folder_ids:
            logger.debug(
                "Skip empty-folder cleanup for source KB %d: no candidate folders",
                source_kb_id,
            )
            return 0

        folders = (
            db.query(KnowledgeFolder)
            .filter(
                KnowledgeFolder.kind_id == source_kb_id,
                KnowledgeFolder.id.in_(transferred_folder_ids),
            )
            .all()
        )
        folder_by_id = {folder.id: folder for folder in folders}
        missing_candidate_ids = transferred_folder_ids - set(folder_by_id)
        if missing_candidate_ids:
            logger.info(
                "Skipping %d already-deleted folder cleanup candidate(s) for source KB %d",
                len(missing_candidate_ids),
                source_kb_id,
            )
        folder_ids_to_check = set(folder_by_id)
        if not folder_ids_to_check:
            return 0
        current_parent_ids = {
            folder.parent_id
            for folder in folders
            if folder.parent_id and folder.parent_id > 0
        }

        while current_parent_ids:
            parents = (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.kind_id == source_kb_id,
                    KnowledgeFolder.id.in_(current_parent_ids),
                )
                .all()
            )
            current_parent_ids = set()
            for parent in parents:
                if parent.id in folder_ids_to_check:
                    continue
                folder_by_id[parent.id] = parent
                folder_ids_to_check.add(parent.id)
                if parent.parent_id and parent.parent_id > 0:
                    current_parent_ids.add(parent.parent_id)

        doc_counts = dict(
            db.query(
                KnowledgeDocument.folder_id,
                func.count(KnowledgeDocument.id),
            )
            .filter(
                KnowledgeDocument.kind_id == source_kb_id,
                KnowledgeDocument.folder_id.in_(folder_ids_to_check),
            )
            .group_by(KnowledgeDocument.folder_id)
            .all()
        )
        child_counts = dict(
            db.query(
                KnowledgeFolder.parent_id,
                func.count(KnowledgeFolder.id),
            )
            .filter(
                KnowledgeFolder.kind_id == source_kb_id,
                KnowledgeFolder.parent_id.in_(folder_ids_to_check),
            )
            .group_by(KnowledgeFolder.parent_id)
            .all()
        )

        def folder_depth(folder_id: int) -> int:
            depth = 0
            seen = set()
            current = folder_by_id.get(folder_id)
            while current and current.parent_id > 0 and current.parent_id not in seen:
                seen.add(current.parent_id)
                depth += 1
                current = folder_by_id.get(current.parent_id)
            return depth

        deleted_ids: list[int] = []
        for folder in sorted(
            folder_by_id.values(), key=lambda item: folder_depth(item.id), reverse=True
        ):
            if doc_counts.get(folder.id, 0) > 0 or child_counts.get(folder.id, 0) > 0:
                continue
            deleted_ids.append(folder.id)
            if folder.parent_id in child_counts:
                child_counts[folder.parent_id] = max(
                    child_counts[folder.parent_id] - 1, 0
                )

        if not deleted_ids:
            logger.debug(
                "No empty folders found during cleanup for source KB %d",
                source_kb_id,
            )
            return 0

        deleted_count = 0
        for i in range(0, len(deleted_ids), 1000):
            batch = deleted_ids[i : i + 1000]
            deleted_count += (
                db.query(KnowledgeFolder)
                .filter(
                    KnowledgeFolder.kind_id == source_kb_id,
                    KnowledgeFolder.id.in_(batch),
                )
                .delete(synchronize_session=False)
            )
        logger.info(
            "Deleted %d empty source folder(s) for KB %d during document transfer",
            deleted_count,
            source_kb_id,
        )
        return deleted_count

    @staticmethod
    def cleanup_rag_indices(
        db: Session,
        source_kb: Kind,
        docs: list[KnowledgeDocument],
        user_id: int,
    ) -> None:
        """Best-effort cleanup of transferred document RAG indices."""

        from app.services.knowledge.index_runtime import get_kb_index_info_by_record
        from app.services.rag.runtime_resolver import RagRuntimeResolver

        logger = logging.getLogger(__name__)
        rag_gateway = _get_delete_gateway()

        for doc in docs:
            spec = source_kb.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")
            if not retrieval_config or not retrieval_config.get("retriever_name"):
                break

            try:
                kb_info = get_kb_index_info_by_record(
                    db=db,
                    knowledge_base=source_kb,
                    current_user_id=user_id,
                )
                delete_runtime_spec = RagRuntimeResolver().build_delete_runtime_spec(
                    db=db,
                    knowledge_base_id=source_kb.id,
                    document_ref=str(doc.id),
                    index_owner_user_id=kb_info.index_owner_user_id,
                )
                _run_async_in_new_loop(
                    rag_gateway.delete_document_index(delete_runtime_spec, db=db)
                )
            except Exception:
                logger.warning(
                    "Failed to delete RAG index for doc %d during transfer",
                    doc.id,
                    exc_info=True,
                )

    @staticmethod
    def transfer_documents_to_kb(
        db: Session,
        source_kb_id: int,
        target_kb_id: int,
        document_ids: list[int],
        folder_ids: list[int],
        user_id: int,
    ) -> TransferDocumentsResponse:
        """Transfer documents and/or folders from one KB to another.

        Moves documents and entire folder subtrees from a source knowledge
        base to a target knowledge base.  Folder hierarchy is recreated in
        the target KB.  Documents have their index_status reset to
        'not_indexed' and RAG indexes are cleaned up from the source KB.

        Args:
            db: Database session
            source_kb_id: Source knowledge base ID
            target_kb_id: Target knowledge base ID
            document_ids: Explicit document IDs to transfer
            folder_ids: Folder IDs whose entire subtree should be transferred
            user_id: Requesting user ID

        Returns:
            TransferDocumentsResponse with transfer counts

        Raises:
            ValueError: If access validation fails
        """

        logger = logging.getLogger(__name__)

        source_kb, target_kb = KnowledgeTransferService.validate_kb_access_and_fetch(
            db=db,
            source_kb_id=source_kb_id,
            target_kb_id=target_kb_id,
            user_id=user_id,
        )
        all_doc_ids, descendant_folder_ids = (
            KnowledgeTransferService.collect_transfer_doc_and_folder_ids(
                db=db,
                source_kb_id=source_kb_id,
                document_ids=document_ids,
                folder_ids=folder_ids,
            )
        )

        if not all_doc_ids:
            return TransferDocumentsResponse(
                success=True,
                message="No documents to transfer",
                transferred_document_count=0,
                transferred_folder_count=0,
                deleted_folder_count=0,
                source_kb_id=source_kb_id,
                target_kb_id=target_kb_id,
            )

        # Check document limit for notebook mode target knowledge base
        target_kb_spec = target_kb.json.get("spec", {})
        target_kb_type = target_kb_spec.get("kbType", "notebook")
        if target_kb_type == "notebook":
            current_count = KnowledgeService.get_document_count(db, target_kb_id)
            if (
                current_count + len(all_doc_ids)
                > KnowledgeService.NOTEBOOK_MAX_DOCUMENTS
            ):
                raise CustomHTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        f"Cannot transfer to notebook mode knowledge base: "
                        f"transfer would exceed the limit of {KnowledgeService.NOTEBOOK_MAX_DOCUMENTS} documents. "
                        f"Current: {current_count}, transferring: {len(all_doc_ids)}"
                    ),
                    error_code=NOTEBOOK_DOC_LIMIT_EXCEEDED,
                )

        KnowledgeTransferService.validate_transfer_document_names(
            db=db,
            all_doc_ids=all_doc_ids,
            target_kb_id=target_kb_id,
            source_kb_id=source_kb_id,
        )

        logger.info(
            "Transferring %d document(s) and %d folder(s) from KB %d to KB %d",
            len(all_doc_ids),
            len(descendant_folder_ids),
            source_kb_id,
            target_kb_id,
        )

        old_to_new_folder, transferred_folder_count = (
            KnowledgeTransferService.recreate_folders_in_target(
                db=db,
                descendant_folder_ids=descendant_folder_ids,
                target_kb_id=target_kb_id,
                source_kb_id=source_kb_id,
            )
        )
        docs, transferred_doc_count = (
            KnowledgeTransferService.transfer_documents_mutate(
                db=db,
                all_doc_ids=all_doc_ids,
                old_to_new_folder=old_to_new_folder,
                target_kb_id=target_kb_id,
                source_kb_id=source_kb_id,
            )
        )
        # Flush document mutations so that cleanup_empty_folders can see
        # the updated kind_id / folder_id values via SQL COUNT queries.
        db.flush()

        # Clean up empty folders in the source KB after documents are moved out
        deleted_folder_count = KnowledgeTransferService.cleanup_empty_folders(
            db=db,
            source_kb_id=source_kb_id,
            transferred_folder_ids=descendant_folder_ids,
        )

        KnowledgeService._update_document_count_cache(db, source_kb_id)
        KnowledgeService._update_document_count_cache(db, target_kb_id)
        db.commit()

        user = db.query(User).filter(User.id == user_id).first()
        if user and target_kb:
            from app.services.knowledge.orchestrator import KnowledgeOrchestrator

            orchestrator = KnowledgeOrchestrator()
            for doc in docs:
                try:
                    orchestrator._schedule_indexing_celery(
                        db=db,
                        knowledge_base=target_kb,
                        document=doc,
                        user=user,
                        trigger_summary=False,
                    )
                    logger.info(
                        "Scheduled indexing for transferred document %d in target KB %d",
                        doc.id,
                        target_kb_id,
                    )
                except Exception:
                    logger.warning(
                        "Failed to schedule indexing for transferred document %d",
                        doc.id,
                        exc_info=True,
                    )

        KnowledgeTransferService.cleanup_rag_indices(
            db=db,
            source_kb=source_kb,
            docs=docs,
            user_id=user_id,
        )

        return TransferDocumentsResponse(
            success=True,
            message=(
                f"Transferred {transferred_doc_count} document(s) and "
                f"{transferred_folder_count} folder(s)"
            ),
            transferred_document_count=transferred_doc_count,
            transferred_folder_count=transferred_folder_count,
            deleted_folder_count=deleted_folder_count,
            source_kb_id=source_kb_id,
            target_kb_id=target_kb_id,
        )

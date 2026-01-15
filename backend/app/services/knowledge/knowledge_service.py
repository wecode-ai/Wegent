# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base and document service using kinds table.
"""

from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.knowledge import (
    DocumentStatus,
    KnowledgeDocument,
)
from app.models.namespace import Namespace
from app.schemas.kind import KnowledgeBase as KnowledgeBaseCRD
from app.schemas.kind import KnowledgeBaseSpec, ObjectMeta
from app.schemas.knowledge import (
    AccessibleKnowledgeBase,
    AccessibleKnowledgeResponse,
    BatchOperationResult,
    KnowledgeBaseCreate,
    KnowledgeBaseUpdate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
    ResourceScope,
    TeamKnowledgeGroup,
)
from app.schemas.namespace import GroupRole
from app.services.group_permission import (
    check_group_permission,
    get_effective_role_in_group,
    get_user_groups,
)


@dataclass
class DocumentDeleteResult:
    """Result of a document deletion operation.

    Contains information needed to trigger KB summary updates after deletion.
    """

    success: bool
    kb_id: Optional[int] = None


@dataclass
class BatchDeleteResult:
    """Result of a batch document deletion operation.

    Contains the standard batch operation result plus additional info
    for triggering KB summary updates.
    """

    result: BatchOperationResult
    kb_ids: list[int]  # Unique KB IDs from successfully deleted documents


class KnowledgeService:
    """Service for managing knowledge bases and documents using kinds table."""

    # ============== Knowledge Base Operations ==============

    @staticmethod
    def create_knowledge_base(
        db: Session,
        user_id: int,
        data: KnowledgeBaseCreate,
    ) -> int:
        """
        Create a new knowledge base.

        Args:
            db: Database session
            user_id: Creator user ID
            data: Knowledge base creation data

        Returns:
            Created KnowledgeBase ID

        Raises:
            ValueError: If validation fails or permission denied
        """
        from datetime import datetime

        # Check permission for team knowledge base
        if data.namespace != "default":
            role = get_effective_role_in_group(db, user_id, data.namespace)
            if role is None:
                raise ValueError(
                    f"User does not have access to group '{data.namespace}'"
                )
            if not check_group_permission(
                db, user_id, data.namespace, GroupRole.Maintainer
            ):
                raise ValueError(
                    "Only Owner or Maintainer can create knowledge base in this group"
                )

        # Generate unique name for the Kind record
        kb_name = f"kb-{user_id}-{data.namespace}-{data.name}"

        # Check duplicate by Kind.name (unique identifier)
        existing_by_name = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.user_id == user_id,
                Kind.namespace == data.namespace,
                Kind.name == kb_name,
                Kind.is_active == True,
            )
            .first()
        )

        if existing_by_name:
            raise ValueError(f"Knowledge base with name '{data.name}' already exists")

        # Also check by display name in spec to prevent duplicates
        existing_by_display = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.user_id == user_id,
                Kind.namespace == data.namespace,
                Kind.is_active == True,
            )
            .all()
        )

        for kb in existing_by_display:
            kb_spec = kb.json.get("spec", {})
            if kb_spec.get("name") == data.name:
                raise ValueError(
                    f"Knowledge base with name '{data.name}' already exists"
                )

        # Build CRD structure
        spec_kwargs = {
            "name": data.name,
            "description": data.description or "",
            "retrievalConfig": data.retrieval_config,
            "summaryEnabled": data.summary_enabled,
        }
        # Add summaryModelRef if provided
        if data.summary_model_ref:
            spec_kwargs["summaryModelRef"] = data.summary_model_ref

        kb_crd = KnowledgeBaseCRD(
            apiVersion="agent.wecode.io/v1",
            kind="KnowledgeBase",
            metadata=ObjectMeta(
                name=kb_name,
                namespace=data.namespace,
            ),
            spec=KnowledgeBaseSpec(**spec_kwargs),
        )

        # Build resource data
        resource_data = kb_crd.model_dump()
        if "status" not in resource_data or resource_data["status"] is None:
            resource_data["status"] = {"state": "Available"}

        # Create Kind record directly using the passed db session
        db_resource = Kind(
            user_id=user_id,
            kind="KnowledgeBase",
            name=kb_name,
            namespace=data.namespace,
            json=resource_data,
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )

        db.add(db_resource)
        db.flush()  # Flush to get the ID without committing

        return db_resource.id

    @staticmethod
    def get_knowledge_base(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> Optional[Kind]:
        """
        Get a knowledge base by ID with permission check.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            Kind if found and accessible, None otherwise
        """
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            return None

        # Check access permission
        if kb.namespace == "default":
            if kb.user_id != user_id:
                return None
        else:
            role = get_effective_role_in_group(db, user_id, kb.namespace)
            if role is None:
                return None

        return kb

    @staticmethod
    def list_knowledge_bases(
        db: Session,
        user_id: int,
        scope: ResourceScope = ResourceScope.ALL,
        group_name: Optional[str] = None,
    ) -> list[Kind]:
        """
        List knowledge bases based on scope.

        Args:
            db: Database session
            user_id: Requesting user ID
            scope: Resource scope (personal, group, all)
            group_name: Group name (required when scope is GROUP)

        Returns:
            List of accessible knowledge bases
        """
        if scope == ResourceScope.PERSONAL:
            return (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.user_id == user_id,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

        elif scope == ResourceScope.GROUP:
            if not group_name:
                raise ValueError("group_name is required when scope is GROUP")

            # Check user has access to this group
            role = get_effective_role_in_group(db, user_id, group_name)
            if role is None:
                return []

            return (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.namespace == group_name,
                    Kind.is_active == True,
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

        else:  # ALL
            # Get personal knowledge bases
            personal = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.user_id == user_id,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .all()
            )

            # Get team knowledge bases from accessible groups
            accessible_groups = get_user_groups(db, user_id)
            team = (
                (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "KnowledgeBase",
                        Kind.namespace.in_(accessible_groups),
                        Kind.is_active == True,
                    )
                    .all()
                )
                if accessible_groups
                else []
            )

            return personal + team

    @staticmethod
    def update_knowledge_base(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        data: KnowledgeBaseUpdate,
    ) -> Optional[Kind]:
        """
        Update a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID
            data: Update data

        Returns:
            Updated Kind if successful, None otherwise

        Raises:
            ValueError: If validation fails or permission denied
        """
        kb = KnowledgeService.get_knowledge_base(db, knowledge_base_id, user_id)
        if not kb:
            return None

        # Check permission for team knowledge base
        if kb.namespace != "default":
            if not check_group_permission(
                db, user_id, kb.namespace, GroupRole.Maintainer
            ):
                raise ValueError(
                    "Only Owner or Maintainer can update knowledge base in this group"
                )

        # Get current spec
        kb_json = kb.json
        spec = kb_json.get("spec", {})

        # Check duplicate name if name is being changed
        if data.name and data.name != spec.get("name"):
            existing = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.user_id == kb.user_id,
                    Kind.namespace == kb.namespace,
                    Kind.is_active == True,
                    Kind.id != knowledge_base_id,
                )
                .all()
            )

            for existing_kb in existing:
                existing_spec = existing_kb.json.get("spec", {})
                if existing_spec.get("name") == data.name:
                    raise ValueError(
                        f"Knowledge base with name '{data.name}' already exists"
                    )

            spec["name"] = data.name

        if data.description is not None:
            spec["description"] = data.description

        # Update retrieval config if provided (only allowed fields)
        if data.retrieval_config is not None:
            current_retrieval_config = spec.get("retrievalConfig", {})
            if current_retrieval_config:
                # Only update allowed fields, keep retriever and embedding_config unchanged
                if data.retrieval_config.retrieval_mode is not None:
                    current_retrieval_config["retrieval_mode"] = (
                        data.retrieval_config.retrieval_mode
                    )
                if data.retrieval_config.top_k is not None:
                    current_retrieval_config["top_k"] = data.retrieval_config.top_k
                if data.retrieval_config.score_threshold is not None:
                    current_retrieval_config["score_threshold"] = (
                        data.retrieval_config.score_threshold
                    )
                if data.retrieval_config.hybrid_weights is not None:
                    current_retrieval_config["hybrid_weights"] = (
                        data.retrieval_config.hybrid_weights.model_dump()
                    )
                spec["retrievalConfig"] = current_retrieval_config

        # Update summary_enabled if provided
        if data.summary_enabled is not None:
            spec["summaryEnabled"] = data.summary_enabled

        # Update summary_model_ref if explicitly provided (including null to clear)
        # Use model_fields_set to detect if the field was explicitly passed
        if "summary_model_ref" in data.model_fields_set:
            spec["summaryModelRef"] = data.summary_model_ref

        kb_json["spec"] = spec
        kb.json = kb_json
        # Mark JSON field as modified so SQLAlchemy detects the change
        flag_modified(kb, "json")

        db.commit()
        db.refresh(kb)
        return kb

    @staticmethod
    def delete_knowledge_base(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> bool:
        """
        Delete a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            True if deleted, False if not found

        Raises:
            ValueError: If permission denied or knowledge base has documents
        """
        kb = KnowledgeService.get_knowledge_base(db, knowledge_base_id, user_id)
        if not kb:
            return False

        # Check permission for team knowledge base
        if kb.namespace != "default":
            if not check_group_permission(
                db, user_id, kb.namespace, GroupRole.Maintainer
            ):
                raise ValueError(
                    "Only Owner or Maintainer can delete knowledge base in this group"
                )

        # Check if knowledge base has documents - prevent deletion if documents exist
        document_count = KnowledgeService.get_document_count(db, knowledge_base_id)
        if document_count > 0:
            raise ValueError(
                f"Cannot delete knowledge base with {document_count} document(s). "
                "Please delete all documents first."
            )

        # Physically delete the knowledge base
        db.delete(kb)
        db.commit()
        return True

    @staticmethod
    def get_document_count(
        db: Session,
        knowledge_base_id: int,
    ) -> int:
        """
        Get the total document count for a knowledge base (all documents).

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Number of documents in the knowledge base
        """
        from sqlalchemy import func

        return (
            db.query(func.count(KnowledgeDocument.id))
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
            )
            .scalar()
            or 0
        )

    @staticmethod
    def get_total_file_size(
        db: Session,
        knowledge_base_id: int,
    ) -> int:
        """
        Get the total file size for all active documents in a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Total file size in bytes for all active documents
        """
        from sqlalchemy import func

        return (
            db.query(func.coalesce(func.sum(KnowledgeDocument.file_size), 0))
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
                KnowledgeDocument.is_active == True,
            )
            .scalar()
            or 0
        )

    @staticmethod
    def get_active_document_count(
        db: Session,
        knowledge_base_id: int,
    ) -> int:
        """
        Get the active document count for a knowledge base.
        Only counts documents that are indexed (is_active=True).
        Used for AI chat integration to show available documents.

        Note: The status field is reserved for future use and not currently checked.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID

        Returns:
            Number of active documents in the knowledge base
        """
        from sqlalchemy import func

        return (
            db.query(func.count(KnowledgeDocument.id))
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
                KnowledgeDocument.is_active == True,
            )
            .scalar()
            or 0
        )

    # ============== Knowledge Document Operations ==============

    @staticmethod
    def create_document(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        data: KnowledgeDocumentCreate,
    ) -> KnowledgeDocument:
        """
        Create a new document in a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Uploader user ID
            data: Document creation data

        Returns:
            Created KnowledgeDocument

        Raises:
            ValueError: If validation fails or permission denied
        """
        kb = KnowledgeService.get_knowledge_base(db, knowledge_base_id, user_id)
        if not kb:
            raise ValueError("Knowledge base not found or access denied")

        # Check permission for team knowledge base
        if kb.namespace != "default":
            if not check_group_permission(
                db, user_id, kb.namespace, GroupRole.Maintainer
            ):
                raise ValueError(
                    "Only Owner or Maintainer can add documents to this knowledge base"
                )

        document = KnowledgeDocument(
            kind_id=knowledge_base_id,
            attachment_id=data.attachment_id if data.attachment_id is not None else 0,
            name=data.name,
            file_extension=data.file_extension,
            file_size=data.file_size,
            user_id=user_id,
            splitter_config=(
                data.splitter_config.model_dump() if data.splitter_config else {}
            ),  # Save splitter_config with default {}
            source_type=data.source_type.value if data.source_type else "file",
            source_config=data.source_config if data.source_config else {},
        )
        db.add(document)

        db.commit()
        db.refresh(document)
        return document

    @staticmethod
    def get_document(
        db: Session,
        document_id: int,
        user_id: int,
    ) -> Optional[KnowledgeDocument]:
        """
        Get a document by ID with permission check.

        Args:
            db: Database session
            document_id: Document ID
            user_id: Requesting user ID

        Returns:
            KnowledgeDocument if found and accessible, None otherwise
        """
        doc = (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.id == document_id,
            )
            .first()
        )

        if not doc:
            return None

        # Check access via knowledge base
        kb = KnowledgeService.get_knowledge_base(db, doc.kind_id, user_id)
        if not kb:
            return None

        return doc

    @staticmethod
    def list_documents(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> list[KnowledgeDocument]:
        """
        List documents in a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            List of documents
        """
        # Check access to knowledge base
        kb = KnowledgeService.get_knowledge_base(db, knowledge_base_id, user_id)
        if not kb:
            return []

        return (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
            )
            .order_by(KnowledgeDocument.created_at.desc())
            .all()
        )

    @staticmethod
    def update_document(
        db: Session,
        document_id: int,
        user_id: int,
        data: KnowledgeDocumentUpdate,
    ) -> Optional[KnowledgeDocument]:
        """
        Update a document (enable/disable status).

        Args:
            db: Database session
            document_id: Document ID
            user_id: Requesting user ID
            data: Update data

        Returns:
            Updated KnowledgeDocument if successful, None otherwise

        Raises:
            ValueError: If permission denied
        """
        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            return None

        # Check permission for team knowledge base
        kb = (
            db.query(Kind)
            .filter(Kind.id == doc.kind_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if kb and kb.namespace != "default":
            if not check_group_permission(
                db, user_id, kb.namespace, GroupRole.Maintainer
            ):
                raise ValueError(
                    "Only Owner or Maintainer can update documents in this knowledge base"
                )

        if data.name is not None:
            doc.name = data.name

        if data.status is not None:
            doc.status = DocumentStatus(data.status.value)

        if data.splitter_config is not None:
            doc.splitter_config = data.splitter_config.model_dump()

        db.commit()
        db.refresh(doc)
        return doc

    @staticmethod
    def delete_document(
        db: Session,
        document_id: int,
        user_id: int,
    ) -> DocumentDeleteResult:
        """
        Physically delete a document, its RAG index, and associated attachment.

        Args:
            db: Database session
            document_id: Document ID
            user_id: Requesting user ID

        Returns:
            DocumentDeleteResult with success status and kb_id for summary updates

        Raises:
            ValueError: If permission denied
        """
        import asyncio
        import logging

        from app.services.adapters.retriever_kinds import retriever_kinds_service
        from app.services.context import context_service
        from app.services.rag.document_service import DocumentService
        from app.services.rag.storage.factory import create_storage_backend

        logger = logging.getLogger(__name__)

        def run_async(coro):
            """
            Run an async coroutine safely, handling the case where
            an event loop is already running (e.g., in FastAPI async context).
            """
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                # No running event loop, safe to use asyncio.run()
                return asyncio.run(coro)
            else:
                # Event loop is already running, create a new task
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor() as executor:
                    future = executor.submit(asyncio.run, coro)
                    return future.result()

        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            return DocumentDeleteResult(success=False, kb_id=None)

        # Check permission for team knowledge base
        kb = (
            db.query(Kind)
            .filter(Kind.id == doc.kind_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if kb and kb.namespace != "default":
            if not check_group_permission(
                db, user_id, kb.namespace, GroupRole.Maintainer
            ):
                raise ValueError(
                    "Only Owner or Maintainer can delete documents from this knowledge base"
                )

        # Store document_id (used as doc_ref in RAG), kind_id, and attachment_id before deletion for cleanup
        doc_ref = str(doc.id)  # document_id is used as doc_ref in RAG indexing
        kind_id = doc.kind_id
        attachment_id = doc.attachment_id

        # Physically delete document from database
        db.delete(doc)
        db.commit()

        # Delete RAG index if knowledge base has retrieval_config
        if kb:
            spec = kb.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if retrieval_config:
                retriever_name = retrieval_config.get("retriever_name")
                retriever_namespace = retrieval_config.get(
                    "retriever_namespace", "default"
                )

                if retriever_name:
                    try:
                        # Get retriever from database
                        retriever_crd = retriever_kinds_service.get_retriever(
                            db=db,
                            user_id=user_id,
                            name=retriever_name,
                            namespace=retriever_namespace,
                        )

                        if retriever_crd:
                            # Create storage backend from retriever
                            storage_backend = create_storage_backend(retriever_crd)

                            # Create document service
                            doc_service = DocumentService(
                                storage_backend=storage_backend
                            )

                            # Get the correct user_id for index naming
                            # For group knowledge bases, use the KB creator's user_id
                            # This ensures we delete from the same index where documents were stored
                            if kb.namespace == "default":
                                index_owner_user_id = user_id
                            else:
                                # Group knowledge base - use KB creator's user_id
                                index_owner_user_id = kb.user_id

                            # Delete RAG index using the correct user_id
                            run_async(
                                doc_service.delete_document(
                                    knowledge_id=str(kind_id),
                                    doc_ref=doc_ref,
                                    user_id=index_owner_user_id,
                                )
                            )
                            logger.info(
                                f"Deleted RAG index for doc_ref '{doc_ref}' in knowledge base {kind_id} "
                                f"(index_owner_user_id={index_owner_user_id})"
                            )
                        else:
                            logger.warning(
                                f"Retriever {retriever_name} not found, skipping RAG index deletion"
                            )
                    except Exception as e:
                        # Log error but don't fail the document deletion
                        logger.error(
                            f"Failed to delete RAG index for doc_ref '{doc_ref}': {str(e)}",
                            exc_info=True,
                        )

        # Delete associated attachment (context) if exists
        if attachment_id:
            try:
                deleted = context_service.delete_context(
                    db=db,
                    context_id=attachment_id,
                    user_id=user_id,
                )
                if deleted:
                    logger.info(
                        f"Deleted attachment context {attachment_id} for document {document_id}"
                    )
                else:
                    logger.warning(
                        f"Failed to delete attachment context {attachment_id} for document {document_id}"
                    )
            except Exception as e:
                # Log error but don't fail the document deletion
                logger.error(
                    f"Failed to delete attachment context {attachment_id}: {str(e)}",
                    exc_info=True,
                )

        return DocumentDeleteResult(success=True, kb_id=kind_id)

    # ============== Accessible Knowledge Query ==============

    @staticmethod
    def get_accessible_knowledge(
        db: Session,
        user_id: int,
    ) -> AccessibleKnowledgeResponse:
        """
        Get all knowledge bases accessible to the user.

        Args:
            db: Database session
            user_id: Requesting user ID

        Returns:
            AccessibleKnowledgeResponse with personal and team knowledge bases
        """
        # Get personal knowledge bases
        personal_kbs = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.user_id == user_id,
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.updated_at.desc())
            .all()
        )

        personal = [
            AccessibleKnowledgeBase(
                id=kb.id,
                name=kb.json.get("spec", {}).get("name", ""),
                description=kb.json.get("spec", {}).get("description")
                or None,  # Convert empty string to None
                document_count=KnowledgeService.get_active_document_count(db, kb.id),
                updated_at=kb.updated_at,
            )
            for kb in personal_kbs
        ]

        # Get team knowledge bases grouped by namespace
        accessible_groups = get_user_groups(db, user_id)
        team_groups: list[TeamKnowledgeGroup] = []

        for group_name in accessible_groups:
            # Get namespace display name
            namespace = (
                db.query(Namespace)
                .filter(
                    Namespace.name == group_name,
                    Namespace.is_active == True,
                )
                .first()
            )
            display_name = namespace.display_name if namespace else None

            # Get knowledge bases in this group
            group_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.namespace == group_name,
                    Kind.is_active == True,
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

            if group_kbs:
                team_groups.append(
                    TeamKnowledgeGroup(
                        group_name=group_name,
                        group_display_name=display_name,
                        knowledge_bases=[
                            AccessibleKnowledgeBase(
                                id=kb.id,
                                name=kb.json.get("spec", {}).get("name", ""),
                                description=kb.json.get("spec", {}).get("description")
                                or None,  # Convert empty string to None
                                document_count=KnowledgeService.get_active_document_count(
                                    db, kb.id
                                ),
                                updated_at=kb.updated_at,
                            )
                            for kb in group_kbs
                        ],
                    )
                )

        return AccessibleKnowledgeResponse(personal=personal, team=team_groups)

    @staticmethod
    def can_manage_knowledge_base(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> bool:
        """
        Check if user can manage (create/edit/delete) a knowledge base.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: User ID

        Returns:
            True if user has management permission
        """
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

        if not kb:
            return False

        if kb.namespace == "default":
            return kb.user_id == user_id
        else:
            return check_group_permission(
                db, user_id, kb.namespace, GroupRole.Maintainer
            )

    # ============== Batch Document Operations ==============

    @staticmethod
    def batch_delete_documents(
        db: Session,
        document_ids: list[int],
        user_id: int,
    ) -> BatchDeleteResult:
        """
        Batch delete multiple documents.

        Args:
            db: Database session
            document_ids: List of document IDs to delete
            user_id: Requesting user ID

        Returns:
            BatchDeleteResult with operation result and KB IDs for summary updates
        """
        success_count = 0
        failed_ids = []
        kb_ids = set()  # Collect unique KB IDs from deleted documents

        for doc_id in document_ids:
            try:
                result = KnowledgeService.delete_document(db, doc_id, user_id)
                if result.success:
                    success_count += 1
                    if result.kb_id is not None:
                        kb_ids.add(result.kb_id)
                else:
                    failed_ids.append(doc_id)
            except (ValueError, Exception):
                failed_ids.append(doc_id)

        operation_result = BatchOperationResult(
            success_count=success_count,
            failed_count=len(failed_ids),
            failed_ids=failed_ids,
            message=f"Successfully deleted {success_count} documents, {len(failed_ids)} failed",
        )

        return BatchDeleteResult(
            result=operation_result,
            kb_ids=list(kb_ids),
        )

    @staticmethod
    def batch_enable_documents(
        db: Session,
        document_ids: list[int],
        user_id: int,
    ) -> BatchOperationResult:
        """
        Batch enable multiple documents.

        Args:
            db: Database session
            document_ids: List of document IDs to enable
            user_id: Requesting user ID

        Returns:
            BatchOperationResult with success/failure counts
        """
        from app.schemas.knowledge import DocumentStatus as SchemaDocumentStatus
        from app.schemas.knowledge import KnowledgeDocumentUpdate

        success_count = 0
        failed_ids = []

        for doc_id in document_ids:
            try:
                update_data = KnowledgeDocumentUpdate(
                    status=SchemaDocumentStatus.ENABLED
                )
                doc = KnowledgeService.update_document(db, doc_id, user_id, update_data)
                if doc:
                    success_count += 1
                else:
                    failed_ids.append(doc_id)
            except (ValueError, Exception):
                failed_ids.append(doc_id)

        return BatchOperationResult(
            success_count=success_count,
            failed_count=len(failed_ids),
            failed_ids=failed_ids,
            message=f"Successfully enabled {success_count} documents, {len(failed_ids)} failed",
        )

    @staticmethod
    def batch_disable_documents(
        db: Session,
        document_ids: list[int],
        user_id: int,
    ) -> BatchOperationResult:
        """
        Batch disable multiple documents.

        Args:
            db: Database session
            document_ids: List of document IDs to disable
            user_id: Requesting user ID

        Returns:
            BatchOperationResult with success/failure counts
        """
        from app.schemas.knowledge import DocumentStatus as SchemaDocumentStatus
        from app.schemas.knowledge import KnowledgeDocumentUpdate

        success_count = 0
        failed_ids = []

        for doc_id in document_ids:
            try:
                update_data = KnowledgeDocumentUpdate(
                    status=SchemaDocumentStatus.DISABLED
                )
                doc = KnowledgeService.update_document(db, doc_id, user_id, update_data)
                if doc:
                    success_count += 1
                else:
                    failed_ids.append(doc_id)
            except (ValueError, Exception):
                failed_ids.append(doc_id)

        return BatchOperationResult(
            success_count=success_count,
            failed_count=len(failed_ids),
            failed_ids=failed_ids,
            message=f"Successfully disabled {success_count} documents, {len(failed_ids)} failed",
        )

    # ============== Table Operations ==============

    @staticmethod
    def list_table_documents(
        db: Session,
        user_id: int,
    ) -> list[KnowledgeDocument]:
        """
        List all table documents accessible to the user.

        This method returns all documents with source_type='table'
        from knowledge bases that the user has access to.
        Supports multiple providers: DingTalk, Feishu, etc.

        Args:
            db: Database session
            user_id: Requesting user ID

        Returns:
            List of table documents
        """
        from app.models.knowledge import DocumentSourceType

        # Get all accessible knowledge base IDs
        accessible_kb_ids = []

        # Get personal knowledge bases
        personal_kbs = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.user_id == user_id,
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .all()
        )
        accessible_kb_ids.extend([kb.id for kb in personal_kbs])

        # Get team knowledge bases from accessible groups
        accessible_groups = get_user_groups(db, user_id)
        if accessible_groups:
            team_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.namespace.in_(accessible_groups),
                    Kind.is_active == True,
                )
                .all()
            )
            accessible_kb_ids.extend([kb.id for kb in team_kbs])

        if not accessible_kb_ids:
            return []

        # Query table documents from accessible knowledge bases
        return (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.kind_id.in_(accessible_kb_ids),
                KnowledgeDocument.source_type == DocumentSourceType.TABLE.value,
            )
            .order_by(KnowledgeDocument.created_at.desc())
            .all()
        )

    @staticmethod
    def get_table_document_by_id(
        db: Session,
        document_id: int,
        user_id: int,
    ) -> Optional[KnowledgeDocument]:
        """
        Get a table document by ID with permission check.

        Args:
            db: Database session
            document_id: Document ID
            user_id: Requesting user ID

        Returns:
            KnowledgeDocument if found, accessible, and is table type, None otherwise
        """
        from app.models.knowledge import DocumentSourceType

        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            return None

        # Verify it's a table document
        if doc.source_type != DocumentSourceType.TABLE.value:
            return None

        return doc

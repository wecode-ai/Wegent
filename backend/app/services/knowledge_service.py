# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base and document service using kinds table.
"""

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
            raise ValueError(
                f"Knowledge base with name '{data.name}' already exists"
            )

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
        kb_crd = KnowledgeBaseCRD(
            apiVersion="agent.wecode.io/v1",
            kind="KnowledgeBase",
            metadata=ObjectMeta(
                name=kb_name,
                namespace=data.namespace,
            ),
            spec=KnowledgeBaseSpec(
                name=data.name,
                description=data.description or "",
                retrievalConfig=data.retrieval_config,
            ),
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
                    current_retrieval_config["retrieval_mode"] = data.retrieval_config.retrieval_mode
                if data.retrieval_config.top_k is not None:
                    current_retrieval_config["top_k"] = data.retrieval_config.top_k
                if data.retrieval_config.score_threshold is not None:
                    current_retrieval_config["score_threshold"] = data.retrieval_config.score_threshold
                if data.retrieval_config.hybrid_weights is not None:
                    current_retrieval_config["hybrid_weights"] = data.retrieval_config.hybrid_weights.model_dump()
                spec["retrievalConfig"] = current_retrieval_config

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
            ValueError: If permission denied
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
        Get the document count for a knowledge base.

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
            attachment_id=data.attachment_id,
            name=data.name,
            file_extension=data.file_extension,
            file_size=data.file_size,
            user_id=user_id,
            splitter_config=data.splitter_config.model_dump() if data.splitter_config else None,  # Save splitter_config
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
                KnowledgeDocument.is_active == True,
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
                KnowledgeDocument.is_active == True,
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
    ) -> bool:
        """
        Physically delete a document.

        Args:
            db: Database session
            document_id: Document ID
            user_id: Requesting user ID

        Returns:
            True if deleted, False if not found

        Raises:
            ValueError: If permission denied
        """
        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            return False

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

        # Physically delete document
        db.delete(doc)
        db.commit()
        return True

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
                description=kb.json.get("spec", {}).get("description"),
                document_count=KnowledgeService.get_document_count(db, kb.id),
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
                                description=kb.json.get("spec", {}).get("description"),
                                document_count=KnowledgeService.get_document_count(db, kb.id),
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
    ) -> BatchOperationResult:
        """
        Batch delete multiple documents.

        Args:
            db: Database session
            document_ids: List of document IDs to delete
            user_id: Requesting user ID

        Returns:
            BatchOperationResult with success/failure counts
        """
        success_count = 0
        failed_ids = []

        for doc_id in document_ids:
            try:
                deleted = KnowledgeService.delete_document(db, doc_id, user_id)
                if deleted:
                    success_count += 1
                else:
                    failed_ids.append(doc_id)
            except (ValueError, Exception):
                failed_ids.append(doc_id)

        return BatchOperationResult(
            success_count=success_count,
            failed_count=len(failed_ids),
            failed_ids=failed_ids,
            message=f"Successfully deleted {success_count} documents, {len(failed_ids)} failed",
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

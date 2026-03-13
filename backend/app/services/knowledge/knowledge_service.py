# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base and document service using kinds table.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.exceptions import ValidationException
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
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.group_member_helper import NAMESPACE_RESOURCE_TYPE
from app.services.group_permission import (
    check_group_permission,
    get_effective_role_in_group,
    get_user_groups,
)
from app.services.knowledge.knowledge_permission import (
    check_kb_write_permission,
    check_organization_kb_permission,
    check_team_kb_permission,
    is_organization_namespace,
)

if TYPE_CHECKING:
    from app.models.resource_member import ResourceMember
    from app.models.share_link import ResourceType
    from app.models.task import TaskResource
    from app.models.task_kb_binding import TaskKnowledgeBaseBinding
    from app.services.share.knowledge_share_service import KnowledgeShareService

logger = logging.getLogger(__name__)


@dataclass
class DocumentDeleteResult:
    """Result of a document deletion operation.

    Contains information needed to trigger KB summary updates after deletion.
    """

    success: bool
    kb_id: int | None = None


@dataclass
class BatchDeleteResult:
    """Result of a batch document deletion operation.

    Contains the standard batch operation result plus additional info
    for triggering KB summary updates.
    """

    result: BatchOperationResult
    kb_ids: list[int]  # Unique KB IDs from successfully deleted documents


@dataclass
class ActiveDocumentTextStats:
    """Aggregated stats for active documents in a knowledge base."""

    file_size_total: int
    text_length_total: int
    active_document_count: int


class KnowledgeService:
    """Service for managing knowledge bases and documents using kinds table."""

    # Maximum number of documents allowed in notebook mode knowledge base
    NOTEBOOK_MAX_DOCUMENTS = 50

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
        # Check permission for organization-level knowledge base (admin only)
        check_organization_kb_permission(db, data.namespace, user_id, "create")

        # Check permission for team knowledge base (skip for organization namespaces)
        if data.namespace != "default" and not is_organization_namespace(
            db, data.namespace
        ):
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
            "kbType": data.kb_type
            or "notebook",  # Default to 'notebook' if not provided
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
        # Flush to get the auto-increment id populated
        db.flush()
        # Note: Caller is responsible for commit

        return db_resource.id

    @staticmethod
    def get_knowledge_base(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> Kind | None:
        """
        Get a knowledge base by ID with permission check.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            Kind if found and accessible, None otherwise
        """
        from app.services.share import knowledge_share_service

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

        # Use the knowledge share service to check access
        has_access, _, _, _ = knowledge_share_service.get_user_kb_permission(
            db, knowledge_base_id, user_id
        )

        if not has_access:
            return None

        return kb

    @staticmethod
    def list_knowledge_bases(
        db: Session,
        user_id: int,
        scope: ResourceScope = ResourceScope.ALL,
        group_name: str | None = None,
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
            # Get knowledge bases with explicit approved permission (shared to user)
            shared_kb_ids = KnowledgeService._get_shared_kb_ids(db, user_id)

            # Get knowledge bases bound to group chats where user is a member
            bound_kb_ids = KnowledgeService._get_bound_kb_ids_for_user(db, user_id)

            # Single query to get personal, shared, and bound knowledge bases
            # Only return KBs in "default" namespace (personal KBs).
            # Group KBs (namespace != "default") are excluded — they are
            # shown on the "Group" tab instead.
            # Personal: user_id matches and namespace is "default"
            # Shared: id is in shared_kb_ids (any namespace)
            # Bound: id is in bound_kb_ids (any namespace)
            conditions = []

            # Personal KBs: owned by user in default namespace
            conditions.append((Kind.user_id == user_id) & (Kind.namespace == "default"))

            # Shared KBs: any namespace
            if shared_kb_ids:
                conditions.append(Kind.id.in_(shared_kb_ids))

            # Bound KBs: any namespace
            if bound_kb_ids:
                conditions.append(Kind.id.in_(bound_kb_ids))

            all_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                    or_(*conditions),
                )
                .all()
            )

            # Separate into personal and shared/bound for sorting
            personal = [
                kb
                for kb in all_kbs
                if kb.user_id == user_id and kb.namespace == "default"
            ]
            other = [kb for kb in all_kbs if kb not in personal]

            # Combine and sort by updated_at
            all_kbs = personal + other
            all_kbs.sort(key=lambda kb: kb.updated_at, reverse=True)
            return all_kbs

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

        elif scope == ResourceScope.ORGANIZATION:
            # Organization knowledge bases are visible to all users
            # Query knowledge bases in namespaces with level='organization'
            return (
                db.query(Kind)
                .join(Namespace, Kind.namespace == Namespace.name)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                    Namespace.level == GroupLevel.organization.value,
                    Namespace.is_active == True,
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

        else:  # ALL
            # Get team knowledge bases from accessible groups
            accessible_groups = get_user_groups(db, user_id)

            # Get knowledge bases with explicit approved permission (shared to user)
            shared_kb_ids = KnowledgeService._get_shared_kb_ids(db, user_id)

            # Get organization-level namespace names
            org_namespaces = (
                db.query(Namespace.name)
                .filter(
                    Namespace.level == GroupLevel.organization.value,
                    Namespace.is_active == True,
                )
                .all()
            )
            org_namespace_names = [n[0] for n in org_namespaces]

            # Get knowledge bases bound to group chats where user is a member
            bound_kb_ids = KnowledgeService._get_bound_kb_ids_for_user(db, user_id)

            # Single query to get personal, team, organization, shared, and bound knowledge bases
            # Personal: user_id matches and namespace is "default"
            # Team: namespace is in accessible_groups
            # Organization: namespace has level='organization'
            # Shared: id is in shared_kb_ids
            # Bound: id is in bound_kb_ids (personal KBs bound to group chats)
            query = db.query(Kind).filter(
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )

            conditions = [(Kind.user_id == user_id) & (Kind.namespace == "default")]

            if accessible_groups:
                conditions.append(Kind.namespace.in_(accessible_groups))

            if org_namespace_names:
                conditions.append(Kind.namespace.in_(org_namespace_names))

            if shared_kb_ids:
                conditions.append(Kind.id.in_(shared_kb_ids))

            if bound_kb_ids:
                conditions.append(Kind.id.in_(bound_kb_ids))

            if conditions:
                query = query.filter(or_(*conditions))

            all_kbs = query.all()

            # Separate into personal, team, organization, shared, and bound
            personal = [
                kb
                for kb in all_kbs
                if kb.user_id == user_id and kb.namespace == "default"
            ]
            team = [kb for kb in all_kbs if kb.namespace in accessible_groups]
            organization = [kb for kb in all_kbs if kb.namespace in org_namespace_names]
            # Shared/bound KBs are those not in personal, team, or organization
            other = [
                kb
                for kb in all_kbs
                if kb not in personal and kb not in team and kb not in organization
            ]

            return personal + team + organization + other

    @staticmethod
    def _get_shared_kb_ids(db: Session, user_id: int) -> list[int]:
        """Get IDs of knowledge bases explicitly shared with the user.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of knowledge base IDs shared with the user
        """
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        shared_permissions = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        return [p.resource_id for p in shared_permissions]

    @staticmethod
    def update_knowledge_base(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        data: KnowledgeBaseUpdate,
    ) -> Kind | None:
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

        # Check permission for organization-level knowledge base (admin only)
        check_organization_kb_permission(db, kb.namespace, user_id, "update")

        # Check permission for team knowledge base
        if kb.namespace != "default":
            if not is_organization_namespace(db, kb.namespace):
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

        # Update retrieval config if provided
        # Allow updating all fields including retriever_name and embedding_config
        # Note: Changing retriever/embedding requires reindexing documents
        if data.retrieval_config is not None:
            current_retrieval_config = spec.get("retrievalConfig", {}) or {}

            # Update retriever_name if provided
            if data.retrieval_config.retriever_name:
                current_retrieval_config["retriever_name"] = (
                    data.retrieval_config.retriever_name
                )

            # Update retriever_namespace only if explicitly provided (not None)
            if data.retrieval_config.retriever_namespace is not None:
                current_retrieval_config["retriever_namespace"] = (
                    data.retrieval_config.retriever_namespace
                )

            # Update embedding_config if provided
            if data.retrieval_config.embedding_config is not None:
                current_retrieval_config["embedding_config"] = (
                    data.retrieval_config.embedding_config.model_dump()
                )

            # Update tunable fields
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

            if current_retrieval_config:
                spec["retrievalConfig"] = current_retrieval_config

        # Update summary_enabled if provided
        if data.summary_enabled is not None:
            spec["summaryEnabled"] = data.summary_enabled

        # Update summary_model_ref if explicitly provided (including null to clear)
        # Use model_fields_set to detect if the field was explicitly passed
        if "summary_model_ref" in data.model_fields_set:
            spec["summaryModelRef"] = data.summary_model_ref

        # Update call limit configuration if provided
        if data.max_calls_per_conversation is not None:
            spec["maxCallsPerConversation"] = data.max_calls_per_conversation

        if data.exempt_calls_before_check is not None:
            spec["exemptCallsBeforeCheck"] = data.exempt_calls_before_check

        # Validate call limits: exempt < max (additional backend validation)
        max_calls = spec.get("maxCallsPerConversation", 10)
        exempt_calls = spec.get("exemptCallsBeforeCheck", 5)
        if exempt_calls >= max_calls:
            raise ValidationException(
                f"exemptCallsBeforeCheck ({exempt_calls}) must be less than "
                f"maxCallsPerConversation ({max_calls})"
            )

        kb_json["spec"] = spec
        kb.json = kb_json
        # Mark JSON field as modified so SQLAlchemy detects the change
        flag_modified(kb, "json")

        # Note: Caller is responsible for commit

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
        from app.services.share import knowledge_share_service

        # First, try to get the KB without permission check to check namespace
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

        # Check permission for organization-level knowledge base (admin only)
        if is_organization_namespace(db, kb.namespace):
            from app.models.user import User

            user = db.query(User).filter(User.id == user_id).first()
            if not user or user.role != "admin":
                raise ValueError("Only admin can delete organization knowledge base")
            # Admin can delete organization KB, skip get_knowledge_base permission check
        else:
            # For non-organization KBs, use get_knowledge_base for permission check
            kb = KnowledgeService.get_knowledge_base(db, knowledge_base_id, user_id)
            if not kb:
                return False
            # Only creator can delete personal/group knowledge base
            if kb.user_id != user_id:
                raise ValueError("Only the creator can delete this knowledge base")

        # Check if knowledge base has documents - prevent deletion if documents exist
        document_count = KnowledgeService.get_document_count(db, knowledge_base_id)
        if document_count > 0:
            raise ValueError(
                f"Cannot delete knowledge base with {document_count} document(s). "
                "Please delete all documents first."
            )

        # Delete all members for this KB
        knowledge_share_service.delete_members_for_kb(db, knowledge_base_id)

        # Physically delete the knowledge base
        db.delete(kb)
        # Note: Caller is responsible for commit

        return True

    @staticmethod
    def update_knowledge_base_type(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        new_type: str,
    ) -> Kind | None:
        """
        Update the knowledge base type (notebook <-> classic conversion).

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID
            new_type: New knowledge base type ('notebook' or 'classic')

        Returns:
            Updated Kind if successful, None if not found

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
                    "Only Owner or Maintainer can update knowledge base type in this group"
                )

        # Validate new_type
        if new_type not in ("notebook", "classic"):
            raise ValueError("kb_type must be 'notebook' or 'classic'")

        # Get current type
        kb_json = kb.json
        spec = kb_json.get("spec", {})
        current_type = spec.get("kbType", "notebook")

        # If same type, return current kb
        if current_type == new_type:
            return kb

        # If converting to notebook, check document count limit
        if new_type == "notebook":
            document_count = KnowledgeService.get_document_count(db, knowledge_base_id)
            if document_count > KnowledgeService.NOTEBOOK_MAX_DOCUMENTS:
                raise ValueError(
                    f"Cannot convert to notebook mode: document count ({document_count}) "
                    f"exceeds the limit of {KnowledgeService.NOTEBOOK_MAX_DOCUMENTS}"
                )

        # Update the type
        spec["kbType"] = new_type
        kb_json["spec"] = spec
        kb.json = kb_json
        # Mark JSON field as modified so SQLAlchemy detects the change
        flag_modified(kb, "json")

        # Note: Caller is responsible for commit

        return kb

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
        return (
            db.query(func.count(KnowledgeDocument.id))
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
            )
            .scalar()
            or 0
        )

    @staticmethod
    def _update_document_count_cache(
        db: Session,
        knowledge_base_id: int,
    ) -> None:
        """
        Update the cached document_count in knowledge base spec.

        This method queries the actual document count from the database
        and updates the spec.document_count field to keep it in sync.
        Called after document creation/deletion.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
        """
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
            )
            .first()
        )

        if kb:
            # Query actual document count from database
            actual_count = KnowledgeService.get_document_count(db, knowledge_base_id)

            kb_json = kb.json
            spec = kb_json.get("spec", {})
            spec["document_count"] = actual_count
            kb_json["spec"] = spec
            kb.json = kb_json
            flag_modified(kb, "json")

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
        return (
            db.query(func.count(KnowledgeDocument.id))
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
                KnowledgeDocument.is_active == True,
            )
            .scalar()
            or 0
        )

    @staticmethod
    def get_active_document_text_length_stats(
        db: Session,
        knowledge_base_id: int,
    ) -> ActiveDocumentTextStats:
        """
        Get aggregated active document stats with extracted text length.

        Returns total extracted text length (SubtaskContext.text_length),
        total raw file size, and active document count using a single query.
        """
        from app.models.subtask_context import SubtaskContext

        file_size_total, text_length_total, active_document_count = (
            db.query(
                func.coalesce(func.sum(KnowledgeDocument.file_size), 0),
                func.coalesce(func.sum(SubtaskContext.text_length), 0),
                func.count(KnowledgeDocument.id),
            )
            .outerjoin(
                SubtaskContext,
                KnowledgeDocument.attachment_id == SubtaskContext.id,
            )
            .filter(
                KnowledgeDocument.kind_id == knowledge_base_id,
                KnowledgeDocument.is_active == True,
            )
            .one()
        )

        return ActiveDocumentTextStats(
            file_size_total=int(file_size_total or 0),
            text_length_total=int(text_length_total or 0),
            active_document_count=int(active_document_count or 0),
        )

    @staticmethod
    def get_document_counts_batch(
        db: Session,
        kb_ids: list[int],
    ) -> dict[int, int]:
        """Batch get document counts for multiple knowledge bases.

        Delegates to knowledge_repository for the actual query.

        Args:
            db: Database session
            kb_ids: List of knowledge base IDs

        Returns:
            Dictionary mapping kb_id to document count
        """
        from app.services.knowledge.knowledge_repository import (
            get_document_counts_batch,
        )

        return get_document_counts_batch(db, kb_ids)

    @staticmethod
    def get_active_document_counts_batch(
        db: Session,
        kb_ids: list[int],
    ) -> dict[int, int]:
        """Batch get active document counts for multiple knowledge bases.

        Delegates to knowledge_repository for the actual query.

        Args:
            db: Database session
            kb_ids: List of knowledge base IDs

        Returns:
            Dictionary mapping kb_id to active document count
        """
        from app.services.knowledge.knowledge_repository import (
            get_active_document_counts_batch,
        )

        return get_active_document_counts_batch(db, kb_ids)

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
        # First, query the KB directly without permission check to determine namespace
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
            raise ValueError("Knowledge base not found or access denied")

        # Check permission based on namespace type
        check_organization_kb_permission(db, kb.namespace, user_id, "add documents to")

        if kb.namespace == "default":
            # Personal KB - only owner can add documents
            if kb.user_id != user_id:
                raise ValueError("Knowledge base not found or access denied")
        elif not is_organization_namespace(db, kb.namespace):
            # Team/Group KB - check group permission
            if not check_group_permission(
                db, user_id, kb.namespace, GroupRole.Maintainer
            ):
                raise ValueError(
                    "Only Owner or Maintainer can add documents to this knowledge base"
                )

        # Check document limit for notebook mode knowledge base
        kb_spec = kb.json.get("spec", {})
        kb_type = kb_spec.get("kbType", "notebook")
        if kb_type == "notebook":
            current_count = KnowledgeService.get_document_count(db, knowledge_base_id)
            if current_count >= KnowledgeService.NOTEBOOK_MAX_DOCUMENTS:
                raise ValueError(
                    f"Notebook mode knowledge base can have at most {KnowledgeService.NOTEBOOK_MAX_DOCUMENTS} documents. "
                    f"Current count: {current_count}"
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
        # Note: Caller is responsible for commit

        return document

    @staticmethod
    def get_document(
        db: Session,
        document_id: int,
        user_id: int,
    ) -> KnowledgeDocument | None:
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
    ) -> KnowledgeDocument | None:
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

        # Check permission for knowledge base
        kb = (
            db.query(Kind)
            .filter(Kind.id == doc.kind_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if kb:
            # Check permission for organization-level knowledge base (admin only)
            check_organization_kb_permission(
                db, kb.namespace, user_id, "update documents in"
            )

            # Check permission for team knowledge base
            if kb.namespace != "default" and not is_organization_namespace(
                db, kb.namespace
            ):
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

        # Note: Caller is responsible for commit

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
        from app.services.adapters.retriever_kinds import retriever_kinds_service
        from app.services.context import context_service
        from app.services.rag.storage.factory import create_storage_backend

        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            return DocumentDeleteResult(success=False, kb_id=None)

        # Check permission for knowledge base
        kb = (
            db.query(Kind)
            .filter(Kind.id == doc.kind_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if kb:
            # Check permission for organization-level knowledge base (admin only)
            check_organization_kb_permission(
                db, kb.namespace, user_id, "delete documents from"
            )

            # Check permission for team knowledge base
            if kb.namespace != "default" and not is_organization_namespace(
                db, kb.namespace
            ):
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

        # Note: Caller is responsible for commit

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

                            # Get the correct user_id for index naming
                            # For group knowledge bases, use the KB creator's user_id
                            # This ensures we delete from the same index where documents were stored
                            if kb.namespace == "default" or is_organization_namespace(
                                db, kb.namespace
                            ):
                                # Personal/Organization knowledge base - use current user's ID
                                index_owner_user_id = user_id
                            else:
                                # Group knowledge base - use KB creator's user_id
                                index_owner_user_id = kb.user_id

                            # Ensure a valid event loop exists before calling storage_backend.delete_document
                            # LlamaIndex's ElasticsearchStore uses nest_asyncio and internally calls
                            # asyncio.get_event_loop().run_until_complete(), which requires a valid loop
                            _ensure_event_loop()

                            # Delete RAG index using the synchronous storage backend method
                            # storage_backend.delete_document is synchronous but internally uses async operations
                            storage_backend.delete_document(
                                knowledge_id=str(kind_id),
                                doc_ref=doc_ref,
                                user_id=index_owner_user_id,
                            )
                            logger.info(
                                f"Deleted RAG index for doc_ref '{doc_ref}' in knowledge base {kind_id} "
                                f"(index_owner_user_id={index_owner_user_id})"
                            )
                        else:
                            logger.warning(
                                f"Retriever {retriever_name} not found, skipping RAG index deletion"
                            )
                    except Exception:
                        # Log error but don't fail the document deletion
                        logger.exception(
                            f"Failed to delete RAG index for doc_ref '{doc_ref}'"
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
            except Exception:
                # Log error but don't fail the document deletion
                logger.exception(f"Failed to delete attachment context {attachment_id}")

        return DocumentDeleteResult(success=True, kb_id=kind_id)

    @staticmethod
    def update_document_content(
        db: Session,
        document_id: int,
        content: str,
        user_id: int,
    ) -> KnowledgeDocument | None:
        """
        Update document content for TEXT type documents.

        Updates the extracted_text field in SubtaskContext and returns
        the updated document. RAG re-indexing should be handled separately
        by the API endpoint.

        Args:
            db: Database session
            document_id: Document ID
            content: New Markdown content
            user_id: Requesting user ID

        Returns:
            Updated KnowledgeDocument if successful, None if not found

        Raises:
            ValueError: If document is not TEXT type or permission denied
        """
        from app.models.subtask_context import SubtaskContext

        doc = KnowledgeService.get_document(db, document_id, user_id)
        if not doc:
            return None

        # Verify document is editable (TEXT type or plain text files)
        editable_extensions = ["txt", "md", "markdown"]
        is_text_type = doc.source_type == "text"
        is_editable_file = (
            doc.source_type == "file"
            and doc.file_extension.lower() in editable_extensions
        )
        if not (is_text_type or is_editable_file):
            raise ValueError(
                "Only TEXT type documents or plain text files (txt, md) can be edited"
            )

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
                    "Only Owner or Maintainer can edit documents in this knowledge base"
                )

        # Update the extracted_text in SubtaskContext
        if doc.attachment_id:
            context = (
                db.query(SubtaskContext)
                .filter(SubtaskContext.id == doc.attachment_id)
                .first()
            )
            if context:
                context.extracted_text = content
                context.text_length = len(content)
                # Note: Caller is responsible for commit

        return doc

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
            AccessibleKnowledgeResponse with personal, team, and organization knowledge bases
        """
        # Get personal knowledge bases (created by user)
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

        # Batch get document counts for personal KBs to avoid N+1 query problem
        personal_kb_ids = [kb.id for kb in personal_kbs]
        personal_doc_counts = KnowledgeService.get_active_document_counts_batch(
            db, personal_kb_ids
        )

        personal = [
            AccessibleKnowledgeBase(
                id=kb.id,
                name=kb.json.get("spec", {}).get("name", ""),
                description=kb.json.get("spec", {}).get("description")
                or None,  # Convert empty string to None
                document_count=personal_doc_counts.get(kb.id, 0),
                updated_at=kb.updated_at,
            )
            for kb in personal_kbs
        ]

        # Get personal knowledge bases that are bound to group chats where user is a member
        # These are shared via group chat binding, not by explicit sharing
        bound_kb_ids = KnowledgeService._get_bound_kb_ids_for_user(db, user_id)
        if bound_kb_ids:
            bound_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.id.in_(bound_kb_ids),
                    Kind.user_id
                    != user_id,  # Exclude user's own KBs (already included above)
                    Kind.is_active == True,
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

            # Batch get document counts for bound KBs
            bound_kb_ids_list = [kb.id for kb in bound_kbs]
            bound_doc_counts = KnowledgeService.get_active_document_counts_batch(
                db, bound_kb_ids_list
            )

            for kb in bound_kbs:
                personal.append(
                    AccessibleKnowledgeBase(
                        id=kb.id,
                        name=kb.json.get("spec", {}).get("name", ""),
                        description=kb.json.get("spec", {}).get("description") or None,
                        document_count=bound_doc_counts.get(kb.id, 0),
                        updated_at=kb.updated_at,
                    )
                )

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
                # Batch get document counts for group KBs
                group_kb_ids = [kb.id for kb in group_kbs]
                group_doc_counts = KnowledgeService.get_active_document_counts_batch(
                    db, group_kb_ids
                )

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
                                document_count=group_doc_counts.get(kb.id, 0),
                                updated_at=kb.updated_at,
                            )
                            for kb in group_kbs
                        ],
                    )
                )

        # Get organization knowledge bases (accessible to all authenticated users)
        # Query knowledge bases in namespaces with level='organization'
        org_kbs = (
            db.query(Kind, Namespace)
            .join(Namespace, Kind.namespace == Namespace.name)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
                Namespace.level == GroupLevel.organization.value,
                Namespace.is_active == True,
            )
            .order_by(Kind.updated_at.desc())
            .all()
        )

        if org_kbs:
            # Group KBs by namespace
            org_groups: dict[str, dict] = {}
            for kb, ns in org_kbs:
                if ns.name not in org_groups:
                    org_groups[ns.name] = {"namespace": ns, "kbs": []}
                org_groups[ns.name]["kbs"].append(kb)

            # Collect all org KB IDs for batch document count query
            all_org_kb_ids = [
                kb.id for group_data in org_groups.values() for kb in group_data["kbs"]
            ]
            org_doc_counts = KnowledgeService.get_active_document_counts_batch(
                db, all_org_kb_ids
            )

            for ns_name, group_data in org_groups.items():
                ns = group_data["namespace"]
                kbs = group_data["kbs"]
                team_groups.append(
                    TeamKnowledgeGroup(
                        group_name=ns_name,
                        group_display_name=ns.display_name or ns_name,
                        knowledge_bases=[
                            AccessibleKnowledgeBase(
                                id=kb.id,
                                name=kb.json.get("spec", {}).get("name", ""),
                                description=kb.json.get("spec", {}).get("description")
                                or None,  # Convert empty string to None
                                document_count=org_doc_counts.get(kb.id, 0),
                                updated_at=kb.updated_at,
                            )
                            for kb in kbs
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

    @staticmethod
    def _get_bound_kb_ids_for_user(db: Session, user_id: int) -> list[int]:
        """Get IDs of knowledge bases bound to group chats where user is a member.

        This method finds all personal knowledge bases that have been bound to
        group chats where the specified user is a member.

        Optimized for large datasets by splitting the query into two parts:
        1. Query bindings where user is the task owner
        2. Query bindings where user is an approved resource member
        Then merge results in Python to avoid expensive OR conditions and DISTINCT.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of knowledge base IDs that are bound to user's group chats
        """
        from sqlalchemy.exc import ProgrammingError

        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType
        from app.models.task import TaskResource
        from app.models.task_kb_binding import TaskKnowledgeBaseBinding

        try:
            # Optimization: Split into separate queries to avoid OR condition
            # and expensive DISTINCT operation on large datasets

            # Query 1: Get KB IDs where user is the task owner
            # Uses index: tasks(user_id, kind, is_active)
            # Only include group chat tasks (is_group_chat == True)
            owner_kb_ids = (
                db.query(TaskKnowledgeBaseBinding.knowledge_base_id)
                .join(TaskResource, TaskResource.id == TaskKnowledgeBaseBinding.task_id)
                .filter(
                    TaskResource.is_active == True,
                    TaskResource.kind == "Task",
                    TaskResource.is_group_chat == True,
                    TaskResource.user_id == user_id,
                )
                .all()
            )

            # Query 2: Get KB IDs where user is an approved resource member
            # Uses index: resource_members(resource_type, resource_id, status, user_id)
            # Only include group chat tasks (is_group_chat == True)
            member_kb_ids = (
                db.query(TaskKnowledgeBaseBinding.knowledge_base_id)
                .join(TaskResource, TaskResource.id == TaskKnowledgeBaseBinding.task_id)
                .join(
                    ResourceMember,
                    (ResourceMember.resource_id == TaskResource.id)
                    & (ResourceMember.resource_type == ResourceType.TASK.value)
                    & (ResourceMember.user_id == user_id)
                    & (ResourceMember.status == MemberStatus.APPROVED.value),
                )
                .filter(
                    TaskResource.is_active == True,
                    TaskResource.kind == "Task",
                    TaskResource.is_group_chat == True,
                )
                .all()
            )

            # Query 3: Get KB IDs where user accesses group chats via linked namespace
            # This handles users who are members of the linked group but not direct task members
            # Join through task_knowledge_base_bindings to get linked_group_id
            linked_ns_kb_ids = (
                db.query(TaskKnowledgeBaseBinding.knowledge_base_id)
                .join(TaskResource, TaskResource.id == TaskKnowledgeBaseBinding.task_id)
                .join(
                    ResourceMember,
                    (
                        ResourceMember.resource_id
                        == TaskKnowledgeBaseBinding.linked_group_id
                    )
                    & (ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE)
                    & (ResourceMember.user_id == user_id)
                    & (ResourceMember.status == MemberStatus.APPROVED.value),
                )
                .filter(
                    TaskResource.is_active == True,
                    TaskResource.kind == "Task",
                    TaskResource.is_group_chat == True,
                )
                .all()
            )

            # Merge results in Python using set for deduplication
            # This is much faster than SQL DISTINCT on large datasets with OR conditions
            kb_id_set = set()
            for row in owner_kb_ids:
                kb_id_set.add(row[0])
            for row in member_kb_ids:
                kb_id_set.add(row[0])
            for row in linked_ns_kb_ids:
                kb_id_set.add(row[0])

            return list(kb_id_set)
        except ProgrammingError:
            # Table may not exist yet (migration not run), return empty list
            return []

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
            except ValueError as e:
                # Log permission/validation errors for debugging
                logger.warning(f"Failed to delete document {doc_id}: {e}")
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
            except ValueError as e:
                # Log permission/validation errors for debugging
                logger.warning(f"Failed to enable document {doc_id}: {e}")
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
            except ValueError as e:
                # Log permission/validation errors for debugging
                logger.warning(f"Failed to disable document {doc_id}: {e}")
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
    ) -> KnowledgeDocument | None:
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


def _ensure_event_loop() -> asyncio.AbstractEventLoop:
    """
    Ensure there is a valid, open event loop in the current thread.

    LlamaIndex's ElasticsearchStore uses nest_asyncio and internally calls
    asyncio.get_event_loop().run_until_complete(). This function ensures
    a valid event loop exists before those calls to avoid "Event loop is closed" errors.

    This is thread-safe because asyncio.set_event_loop() is thread-local.
    Each thread maintains its own event loop, so setting it in one thread
    does not affect other threads.

    Returns:
        A valid, open event loop
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            # Event loop exists but is closed, create a new one
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        return loop
    except RuntimeError:
        # No event loop in current thread, create one
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        return loop

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base and document service using kinds table.
"""

from dataclasses import dataclass
from typing import Optional

from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.exceptions import ValidationException
from app.models.kind import Kind
from app.models.knowledge import (
    DocumentStatus,
    KnowledgeDocument,
)
from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.kind import KnowledgeBase as KnowledgeBaseCRD
from app.schemas.kind import KnowledgeBaseSpec, ObjectMeta
from app.schemas.knowledge import (
    AccessibleKnowledgeBase,
    AccessibleKnowledgeResponse,
    AllGroupedKnowledgeResponse,
    AllGroupedOrganization,
    AllGroupedPersonal,
    AllGroupedSummary,
    AllGroupedTeamGroup,
    BatchOperationResult,
    KnowledgeBaseCreate,
    KnowledgeBaseResponse,
    KnowledgeBaseUpdate,
    KnowledgeBaseWithGroupInfo,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
    ResourceScope,
    TeamKnowledgeGroup,
)
from app.schemas.namespace import GroupLevel, GroupRole
from app.services.group_permission import (
    get_effective_role_in_group,
    get_user_groups,
    get_view_role_in_group,
)
from app.services.knowledge.namespace_utils import is_organization_namespace
from app.services.knowledge.permission_policy import (
    can_create_namespace_knowledge_base,
    can_manage_accessible_knowledge_base,
    can_manage_accessible_knowledge_base_documents,
    can_manage_accessible_knowledge_document,
)


def _build_attachment_filename(name: str, file_extension: str) -> str:
    """Build a stable attachment filename from document metadata."""
    normalized_extension = (file_extension or "").strip().lstrip(".")
    if not normalized_extension:
        return name

    suffix = f".{normalized_extension}"
    if name.lower().endswith(suffix.lower()):
        return name
    return f"{name}{suffix}"


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


@dataclass
class ActiveDocumentTextStats:
    """Aggregated stats for active documents in a knowledge base."""

    file_size_total: int
    text_length_total: int
    active_document_count: int


class KnowledgeService:
    """Service for managing knowledge bases and documents using kinds table."""

    @staticmethod
    def _get_user_or_raise(db: Session, user_id: int) -> User:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError("User not found")
        return user

    @staticmethod
    def _get_knowledge_base_record(
        db: Session, knowledge_base_id: int
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .first()
        )

    @staticmethod
    def _has_namespaced_admin_access(db: Session, user: User, kb: Kind) -> bool:
        return user.role == "admin" and is_organization_namespace(db, kb.namespace)

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

        user = KnowledgeService._get_user_or_raise(db, user_id)
        if not can_create_namespace_knowledge_base(db, user, data.namespace):
            raise ValueError(
                "You do not have permission to create a knowledge base in this namespace"
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

        # Add guidedQuestions if provided
        if data.guided_questions:
            spec_kwargs["guidedQuestions"] = data.guided_questions

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
    ) -> tuple[Optional[Kind], bool]:
        """
        Get a knowledge base by ID with permission check.

        Args:
            db: Database session
            knowledge_base_id: Knowledge base ID
            user_id: Requesting user ID

        Returns:
            Tuple of (Kind, has_access):
            - Kind: The knowledge base Kind if found, None otherwise
            - has_access: True if user has access to the knowledge base, False otherwise
        """
        from app.services.share import knowledge_share_service

        kb = KnowledgeService._get_knowledge_base_record(db, knowledge_base_id)

        if not kb:
            return None, False

        has_access, _, _ = KnowledgeService._get_user_kb_permission(
            db, knowledge_base_id, user_id, kb=kb
        )

        return kb, has_access

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
            from app.models.resource_member import MemberStatus, ResourceMember
            from app.models.share_link import ResourceType

            # Get knowledge bases with explicit approved permission (shared to user)
            shared_permissions = (
                db.query(ResourceMember.resource_id)
                .filter(
                    ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                    ResourceMember.user_id == user_id,
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .all()
            )
            shared_kb_ids = [p.resource_id for p in shared_permissions]

            # Get knowledge bases bound to group chats where user is a member
            bound_kb_ids = KnowledgeService._get_bound_kb_ids_for_user(db, user_id)

            # Single query to get personal, shared, and bound knowledge bases
            # Personal: user_id matches and namespace is "default"
            # Shared: id is in shared_kb_ids
            # Bound: id is in bound_kb_ids (personal KBs bound to group chats)
            all_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                    ((Kind.user_id == user_id) & (Kind.namespace == "default"))
                    | (Kind.id.in_(shared_kb_ids) if shared_kb_ids else False)
                    | (Kind.id.in_(bound_kb_ids) if bound_kb_ids else False),
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
            from app.models.resource_member import MemberStatus, ResourceMember
            from app.models.share_link import ResourceType

            # Get team knowledge bases from accessible groups
            accessible_groups = get_user_groups(db, user_id)

            # Get knowledge bases with explicit approved permission (shared to user)
            shared_permissions = (
                db.query(ResourceMember.resource_id)
                .filter(
                    ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                    ResourceMember.user_id == user_id,
                    ResourceMember.status == MemberStatus.APPROVED.value,
                )
                .all()
            )
            shared_kb_ids = [p.resource_id for p in shared_permissions]

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
                from sqlalchemy import or_

                query = query.filter(or_(*conditions))

            all_kbs = query.all()

            # Separate into personal, team, organization, shared, and bound
            personal = [
                kb
                for kb in all_kbs
                if kb.user_id == user_id and kb.namespace == "default"
            ]
            team = [
                kb
                for kb in all_kbs
                if kb.namespace in accessible_groups
                and kb.namespace not in org_namespace_names
            ]
            organization = [kb for kb in all_kbs if kb.namespace in org_namespace_names]
            # Shared/bound KBs are those not in personal, team, or organization
            other = [
                kb
                for kb in all_kbs
                if kb not in personal and kb not in team and kb not in organization
            ]

            return personal + team + organization + other

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
        kb, has_access = KnowledgeService.get_knowledge_base(
            db, knowledge_base_id, user_id
        )
        if not kb or not has_access:
            return None

        if not KnowledgeService.can_manage_knowledge_base(
            db, knowledge_base_id, user_id
        ):
            raise ValueError("You do not have permission to manage this knowledge base")

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

        # Update guided_questions if explicitly provided (including null to clear)
        if "guided_questions" in data.model_fields_set:
            spec["guidedQuestions"] = data.guided_questions

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

        kb, has_access = KnowledgeService.get_knowledge_base(
            db, knowledge_base_id, user_id
        )
        if not kb or not has_access:
            return False
        if not KnowledgeService.can_manage_knowledge_base(
            db, knowledge_base_id, user_id
        ):
            raise ValueError("You do not have permission to manage this knowledge base")

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
        db.commit()
        return True

    @staticmethod
    def update_knowledge_base_type(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        new_type: str,
    ) -> Optional[Kind]:
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
        kb, has_access = KnowledgeService.get_knowledge_base(
            db, knowledge_base_id, user_id
        )
        if not kb or not has_access:
            return None

        if not KnowledgeService.can_manage_knowledge_base(
            db, knowledge_base_id, user_id
        ):
            raise ValueError("You do not have permission to manage this knowledge base")

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

        db.commit()
        db.refresh(kb)
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

    @staticmethod
    def get_active_document_counts(
        db: Session,
        knowledge_base_ids: list[int],
    ) -> dict[int, int]:
        """
        Get active document counts for multiple knowledge bases in a single query.

        Args:
            db: Database session
            knowledge_base_ids: List of knowledge base IDs

        Returns:
            Dict mapping kb_id -> active document count
        """
        from sqlalchemy import func

        if not knowledge_base_ids:
            return {}

        results = (
            db.query(
                KnowledgeDocument.kind_id,
                func.count(KnowledgeDocument.id).label("count"),
            )
            .filter(
                KnowledgeDocument.kind_id.in_(knowledge_base_ids),
                KnowledgeDocument.is_active == True,
            )
            .group_by(KnowledgeDocument.kind_id)
            .all()
        )

        return {kb_id: count for kb_id, count in results}

    @staticmethod
    def get_document_prompt_stats(
        db: Session,
        knowledge_base_ids: list[int],
    ) -> dict[int, dict[str, int]]:
        """Get prompt-oriented document stats for multiple knowledge bases."""
        if not knowledge_base_ids:
            return {}

        spreadsheet_exts = ["csv", "xls", "xlsx"]

        results = (
            db.query(
                KnowledgeDocument.kind_id,
                func.count(KnowledgeDocument.id).label("total_count"),
                func.sum(case((KnowledgeDocument.is_active == True, 1), else_=0)).label(
                    "searchable_count"
                ),
                func.sum(
                    case(
                        (
                            and_(
                                KnowledgeDocument.is_active == True,
                                func.lower(KnowledgeDocument.file_extension).in_(
                                    spreadsheet_exts
                                ),
                            ),
                            1,
                        ),
                        else_=0,
                    )
                ).label("spreadsheet_count"),
            )
            .filter(KnowledgeDocument.kind_id.in_(knowledge_base_ids))
            .group_by(KnowledgeDocument.kind_id)
            .all()
        )

        return {
            kb_id: {
                "total_document_count": int(total_count or 0),
                "searchable_document_count": int(searchable_count or 0),
                "spreadsheet_document_count": int(spreadsheet_count or 0),
            }
            for kb_id, total_count, searchable_count, spreadsheet_count in results
        }

    @staticmethod
    def resolve_document_ids_by_names(
        db: Session,
        knowledge_base_ids: list[int],
        document_names: list[str],
    ) -> list[int]:
        """Resolve exact document names within the provided knowledge-base scope."""
        if not knowledge_base_ids or not document_names:
            return []

        normalized_names = [
            name.strip() for name in document_names if name and name.strip()
        ]
        if not normalized_names:
            return []

        rows = (
            db.query(KnowledgeDocument.id)
            .filter(
                KnowledgeDocument.kind_id.in_(knowledge_base_ids),
                KnowledgeDocument.name.in_(normalized_names),
                KnowledgeDocument.is_active == True,
            )
            .all()
        )
        return [row.id for row in rows]

    @staticmethod
    def get_active_document_text_length_stats(
        db: Session,
        knowledge_base_id: int,
    ) -> "ActiveDocumentTextStats":
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

    # ============== Knowledge Document Operations ==============

    # Maximum number of documents allowed in notebook mode knowledge base
    NOTEBOOK_MAX_DOCUMENTS = 50

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

        if not KnowledgeService.can_manage_knowledge_base_documents(
            db, knowledge_base_id, user_id
        ):
            raise ValueError(
                "You do not have permission to add documents to this knowledge base"
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
        db.flush()  # Flush to persist document before counting

        # Update cached document count in knowledge base spec
        KnowledgeService._update_document_count_cache(db, knowledge_base_id)

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
        kb, has_access = KnowledgeService.get_knowledge_base(db, doc.kind_id, user_id)
        if not kb or not has_access:
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
        kb, has_access = KnowledgeService.get_knowledge_base(
            db, knowledge_base_id, user_id
        )
        if not kb or not has_access:
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
    def _assert_can_manage_document(
        db: Session,
        kb: Kind,
        document: KnowledgeDocument,
        user_id: int,
    ) -> None:
        """Ensure the user can manage the target document."""
        kb_id = getattr(kb, "id", None)
        if kb_id is None:
            kb_owner_id = getattr(kb, "user_id", None)
            if kb.namespace == "default" and kb_owner_id in (None, user_id):
                return
            if document.user_id == user_id:
                return
            raise ValueError(
                "You do not have permission to manage this document in this knowledge base"
            )

        if not KnowledgeService.can_manage_knowledge_document(
            db, kb_id, user_id, document.user_id
        ):
            raise ValueError(
                "You do not have permission to manage this document in this knowledge base"
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

        # Check permission for knowledge base
        kb = (
            db.query(Kind)
            .filter(Kind.id == doc.kind_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if kb:
            KnowledgeService._assert_can_manage_document(db, kb, doc, user_id)

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

        from app.services.context import context_service
        from app.services.rag.local_gateway import LocalRagGateway

        logger = logging.getLogger(__name__)
        rag_gateway = LocalRagGateway()

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
            KnowledgeService._assert_can_manage_document(db, kb, doc, user_id)

        # Store document_id (used as doc_ref in RAG), kind_id, and attachment_id before deletion for cleanup
        doc_ref = str(doc.id)  # document_id is used as doc_ref in RAG indexing
        kind_id = doc.kind_id
        attachment_id = doc.attachment_id

        # Physically delete document from database
        db.delete(doc)

        # Update cached document count in knowledge base spec
        KnowledgeService._update_document_count_cache(db, kind_id)

        db.commit()

        # Delete RAG index if knowledge base has retrieval_config
        if kb:
            spec = kb.json.get("spec", {})
            retrieval_config = spec.get("retrievalConfig")

            if retrieval_config:
                retriever_name = retrieval_config.get("retriever_name")

                if retriever_name:
                    try:
                        if kb.namespace == "default" or is_organization_namespace(
                            db, kb.namespace
                        ):
                            index_owner_user_id = user_id
                        else:
                            index_owner_user_id = kb.user_id

                        result = asyncio.run(
                            rag_gateway.delete_document_index(
                                knowledge_base_id=kind_id,
                                document_ref=doc_ref,
                                db=db,
                                index_owner_user_id=index_owner_user_id,
                            )
                        )
                        if result.get("status") == "success":
                            logger.info(
                                f"Deleted RAG index for doc_ref '{doc_ref}' in knowledge base {kind_id} "
                                f"(index_owner_user_id={index_owner_user_id})"
                            )
                        else:
                            logger.warning(
                                "Skipped RAG index deletion for doc_ref '%s' in knowledge base %s: %s",
                                doc_ref,
                                kind_id,
                                result.get("reason", result.get("status", "unknown")),
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

    @staticmethod
    def update_document_content(
        db: Session,
        document_id: int,
        content: str,
        user_id: int,
    ) -> Optional[KnowledgeDocument]:
        """
        Update document content for TEXT type documents.

        Overwrites the underlying attachment so binary storage, extracted text,
        and downstream indexing all observe the same content. RAG re-indexing
        should be handled separately by the API endpoint.

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
        from app.services.context import context_service

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

        kb = (
            db.query(Kind)
            .filter(Kind.id == doc.kind_id, Kind.kind == "KnowledgeBase")
            .first()
        )
        if kb:
            KnowledgeService._assert_can_manage_document(db, kb, doc, user_id)

        if not doc.attachment_id:
            raise ValueError("Document has no attachment to update")

        context = (
            db.query(SubtaskContext)
            .filter(SubtaskContext.id == doc.attachment_id)
            .first()
        )
        if context is None:
            raise ValueError("Document attachment not found")

        binary_content = content.encode("utf-8")
        doc.file_size = len(binary_content)

        filename = context.original_filename or _build_attachment_filename(
            doc.name, doc.file_extension
        )
        context_service.overwrite_attachment(
            db=db,
            context_id=context.id,
            user_id=user_id,
            filename=filename,
            binary_data=binary_content,
        )

        db.refresh(doc)
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

        # Get personal knowledge bases that are bound to group chats where user is a member
        # These are shared via group chat binding, not by explicit sharing
        bound_kb_ids = KnowledgeService._get_bound_kb_ids_for_user(db, user_id)
        if bound_kb_ids:
            bound_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.id.in_(bound_kb_ids),
                    Kind.namespace == "default",
                    Kind.user_id
                    != user_id,  # Exclude user's own KBs (already included above)
                    Kind.is_active == True,
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

            for kb in bound_kbs:
                personal.append(
                    AccessibleKnowledgeBase(
                        id=kb.id,
                        name=kb.json.get("spec", {}).get("name", ""),
                        description=kb.json.get("spec", {}).get("description") or None,
                        document_count=KnowledgeService.get_active_document_count(
                            db, kb.id
                        ),
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
            org_groups: dict[str, list] = {}
            for kb, ns in org_kbs:
                if ns.name not in org_groups:
                    org_groups[ns.name] = {"namespace": ns, "kbs": []}
                org_groups[ns.name]["kbs"].append(kb)

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
                                document_count=KnowledgeService.get_active_document_count(
                                    db, kb.id
                                ),
                                updated_at=kb.updated_at,
                            )
                            for kb in kbs
                        ],
                    )
                )

        return AccessibleKnowledgeResponse(personal=personal, team=team_groups)

    @staticmethod
    def get_personal_knowledge_bases_grouped(
        db: Session,
        user_id: int,
    ) -> dict:
        """
        Get personal knowledge bases grouped by ownership.

        Groups knowledge bases into:
        - created_by_me: Knowledge bases created by the current user (namespace=default)
        - shared_with_me: Knowledge bases shared with the current user (via ResourceMember, any namespace)

        Args:
            db: Database session
            user_id: Current user ID

        Returns:
            Dict with 'created_by_me' and 'shared_with_me' lists
        """
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        # Get KBs created by user (personal knowledge bases, namespace=default)
        created_kbs = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
                Kind.namespace == "default",
                Kind.user_id == user_id,
            )
            .order_by(Kind.updated_at.desc())
            .all()
        )

        # Get KB IDs that are shared with the user via ResourceMember
        shared_kb_ids = (
            db.query(ResourceMember.resource_id)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        shared_kb_ids = [p[0] for p in shared_kb_ids]

        # Query shared personal KBs (namespace=default, but not created by current user)
        shared_kbs = []
        if shared_kb_ids:
            shared_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                    Kind.id.in_(shared_kb_ids),
                    Kind.namespace == "default",
                    Kind.user_id != user_id,  # Exclude KBs created by current user
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

        # Batch fetch document counts for all KBs to avoid N+1 queries
        all_kb_ids = [kb.id for kb in created_kbs] + [kb.id for kb in shared_kbs]
        document_counts = KnowledgeService.get_active_document_counts(db, all_kb_ids)

        # Build response lists using batched counts
        created_by_me = []
        for kb in created_kbs:
            document_count = document_counts.get(kb.id, 0)
            kb_response = KnowledgeBaseResponse.from_kind(kb, document_count)
            created_by_me.append(kb_response)

        shared_with_me = []
        for kb in shared_kbs:
            document_count = document_counts.get(kb.id, 0)
            kb_response = KnowledgeBaseResponse.from_kind(kb, document_count)
            shared_with_me.append(kb_response)

        return {
            "created_by_me": created_by_me,
            "shared_with_me": shared_with_me,
        }

    @staticmethod
    def get_all_knowledge_bases_grouped(
        db: Session,
        user_id: int,
    ) -> AllGroupedKnowledgeResponse:
        """
        Get all knowledge bases accessible to the user, grouped by scope.

        This method optimizes the N+1 query problem by:
        1. Fetching all accessible group names in one query
        2. Fetching all knowledge bases in those groups in one query
        3. Grouping results in memory

        Args:
            db: Database session
            user_id: Current user ID

        Returns:
            AllGroupedKnowledgeResponse with personal, groups, organization, and summary sections
        Returns:
            AllGroupedKnowledgeResponse with personal, groups, organization, and summary sections
        """
        from app.models.resource_member import MemberStatus, ResourceMember
        from app.models.share_link import ResourceType

        user = KnowledgeService._get_user_or_raise(db, user_id)

        # 1. Get personal knowledge bases created by user (single query)
        personal_created = (
            db.query(Kind)
            .filter(
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
                Kind.namespace == "default",
                Kind.user_id == user_id,
            )
            .order_by(Kind.updated_at.desc())
            .all()
        )

        # 2. Get shared knowledge bases with their roles (single query)
        shared_members = (
            db.query(ResourceMember.resource_id, ResourceMember.role)
            .filter(
                ResourceMember.resource_type == ResourceType.KNOWLEDGE_BASE.value,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )
        shared_kb_ids = [p[0] for p in shared_members]
        # Build a map from kb_id to role for shared KBs
        shared_kb_roles: dict[int, str] = {p[0]: p[1] for p in shared_members}

        shared_kbs: list[Kind] = []
        if shared_kb_ids:
            shared_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                    Kind.id.in_(shared_kb_ids),
                    Kind.user_id != user_id,
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )

        shared_namespace_names = {
            kb.namespace for kb in shared_kbs if kb.namespace != "default"
        }
        shared_namespaces = {}
        if shared_namespace_names:
            shared_namespaces = {
                ns.name: ns
                for ns in db.query(Namespace)
                .filter(
                    Namespace.name.in_(shared_namespace_names),
                    Namespace.is_active == True,
                )
                .all()
            }

        personal_shared = [kb for kb in shared_kbs if kb.namespace == "default"]
        shared_group_kbs = [
            kb
            for kb in shared_kbs
            if kb.namespace != "default"
            and (
                shared_namespaces.get(kb.namespace) is None
                or shared_namespaces[kb.namespace].level
                != GroupLevel.organization.value
            )
        ]

        # 3. Get all accessible groups with roles (single query)
        from app.services.group_permission import get_user_groups_with_roles

        accessible_groups_with_roles = get_user_groups_with_roles(db, user_id)
        accessible_groups = [g[0] for g in accessible_groups_with_roles]
        # Build a map from group_name to role
        group_roles: dict[str, str] = {g[0]: g[1] for g in accessible_groups_with_roles}
        shared_group_names = list(
            dict.fromkeys(kb.namespace for kb in shared_group_kbs)
        )
        grouped_namespace_names = list(
            dict.fromkeys(accessible_groups + shared_group_names)
        )

        # 4. Get ALL group knowledge bases in ONE query (key optimization)
        group_kbs: list[Kind] = []
        if accessible_groups:
            group_kbs = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                    Kind.namespace.in_(accessible_groups),
                )
                .order_by(Kind.updated_at.desc())
                .all()
            )
        group_kb_map = {kb.id: kb for kb in group_kbs}
        for kb in shared_group_kbs:
            group_kb_map[kb.id] = kb
        group_kbs = list(group_kb_map.values())

        # 5. Get organization knowledge bases (single query)
        org_kbs = (
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

        organization_namespaces = (
            db.query(Namespace)
            .filter(
                Namespace.level == GroupLevel.organization.value,
                Namespace.is_active == True,
            )
            .all()
        )
        organization_namespace_map = {
            namespace.name: namespace for namespace in organization_namespaces
        }
        org_namespace = organization_namespaces[0] if organization_namespaces else None

        # 6. Batch fetch document counts (single query)
        all_kb_ids = list(
            dict.fromkeys(
                [kb.id for kb in personal_created]
                + [kb.id for kb in personal_shared]
                + [kb.id for kb in group_kbs]
                + [kb.id for kb in org_kbs]
            )
        )
        document_counts = KnowledgeService.get_active_document_counts(db, all_kb_ids)

        # 7. Batch fetch namespace display names for groups
        namespace_display_names = {}
        if grouped_namespace_names:
            namespaces = (
                db.query(Namespace)
                .filter(
                    Namespace.name.in_(grouped_namespace_names),
                    Namespace.is_active == True,
                )
                .all()
            )
            namespace_display_names = {ns.name: ns.display_name for ns in namespaces}

        # Helper function to convert Kind to KnowledgeBaseWithGroupInfo
        def kb_to_response(
            kb: Kind,
            group_id: str,
            group_name: str,
            group_type: str,
            my_role: str | None = None,
        ) -> KnowledgeBaseWithGroupInfo:
            spec = kb.json.get("spec", {})
            return KnowledgeBaseWithGroupInfo(
                id=kb.id,
                name=spec.get("name", ""),
                description=spec.get("description") or None,
                kb_type=spec.get("kbType", "notebook"),
                namespace=kb.namespace,
                document_count=document_counts.get(kb.id, 0),
                updated_at=kb.updated_at,
                created_at=kb.created_at,
                user_id=kb.user_id,
                group_id=group_id,
                group_name=group_name,
                group_type=group_type,
                my_role=my_role,
            )

        def merge_roles(*roles: str | None) -> str | None:
            highest: str | None = None
            for role in roles:
                if role is None:
                    continue
                if highest is None or has_permission(role, highest):
                    highest = role
            return highest

        def get_namespace_view_role(namespace_name: str, namespace_level: str) -> str:
            view_role = get_view_role_in_group(
                db,
                user_id,
                namespace_name,
                user_role=user.role,
                group_level=namespace_level,
            )
            return view_role.value if view_role is not None else BaseRole.Reporter.value

        # Build personal section
        # Use stable English identifiers for group_name - frontend handles localization
        # For personal created KBs, user is always Owner
        created_by_me = [
            kb_to_response(kb, "default", "personal", "personal", "Owner")
            for kb in personal_created
        ]
        # For shared KBs, use the role from ResourceMember
        shared_with_me = [
            kb_to_response(
                kb,
                "default",
                "personal-shared",
                "personal-shared",
                shared_kb_roles.get(kb.id),
            )
            for kb in personal_shared
        ]
        # Build groups section - group KBs by namespace in memory
        groups_map: dict[str, list[Kind]] = {}
        for kb in group_kbs:
            groups_map.setdefault(kb.namespace, []).append(kb)

        # Build groups list - include ALL accessible groups, even those without KBs
        # For group KBs, use the user's role in that group
        groups = []
        for ns_name in grouped_namespace_names:
            display_name = namespace_display_names.get(ns_name, ns_name)
            kbs = groups_map.get(ns_name, [])
            user_group_role = group_roles.get(ns_name)
            groups.append(
                AllGroupedTeamGroup(
                    group_name=ns_name,
                    group_display_name=display_name or ns_name,
                    kb_count=len(kbs),
                    knowledge_bases=[
                        kb_to_response(
                            kb,
                            ns_name,
                            display_name or ns_name,
                            "group",
                            merge_roles(shared_kb_roles.get(kb.id), user_group_role),
                        )
                        for kb in kbs
                    ],
                )
            )

        # Build organization section
        # Use stable English identifier for fallback - frontend handles localization
        # For organization KBs, use the user's role in the organization namespace
        org_display_name = (
            org_namespace.display_name if org_namespace else "organization"
        )
        org_ns_name = org_namespace.name if org_namespace else None
        organization = AllGroupedOrganization(
            namespace=org_ns_name,
            display_name=org_display_name,
            kb_count=len(org_kbs),
            knowledge_bases=[
                kb_to_response(
                    kb,
                    org_ns_name or "organization",
                    org_display_name,
                    "organization",
                    merge_roles(
                        shared_kb_roles.get(kb.id),
                        get_namespace_view_role(
                            kb.namespace,
                            organization_namespace_map[kb.namespace].level,
                        ),
                    ),
                )
                for kb in org_kbs
            ],
        )

        # Build summary
        summary = AllGroupedSummary(
            total_count=len(personal_created)
            + len(personal_shared)
            + len(group_kbs)
            + len(org_kbs),
            personal_count=len(personal_created) + len(personal_shared),
            group_count=len(group_kbs),
            organization_count=len(org_kbs),
        )

        return AllGroupedKnowledgeResponse(
            personal=AllGroupedPersonal(
                created_by_me=created_by_me,
                shared_with_me=shared_with_me,
            ),
            groups=groups,
            organization=organization,
            summary=summary,
        )

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
        has_access, role, is_creator = KnowledgeService._get_user_kb_permission(
            db, knowledge_base_id, user_id
        )
        return can_manage_accessible_knowledge_base(has_access, role, is_creator)

    @staticmethod
    def _get_user_kb_permission(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        kb: Kind | None = None,
    ) -> tuple[bool, BaseRole | None, bool]:
        """Return merged access for the user on the target knowledge base."""
        from app.services.share import knowledge_share_service

        knowledge_base = kb or KnowledgeService._get_knowledge_base_record(
            db, knowledge_base_id
        )
        if knowledge_base is None:
            return False, None, False

        user = KnowledgeService._get_user_or_raise(db, user_id)
        if KnowledgeService._has_namespaced_admin_access(db, user, knowledge_base):
            return True, BaseRole.Owner, False

        has_access, role, is_creator = knowledge_share_service.get_user_kb_permission(
            db, knowledge_base_id, user_id
        )

        effective_role = BaseRole(role) if role is not None else None
        return has_access, effective_role, is_creator

    @staticmethod
    def can_manage_knowledge_base_documents(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
    ) -> bool:
        """Return whether the user can add documents to the target knowledge base."""
        has_access, role, is_creator = KnowledgeService._get_user_kb_permission(
            db, knowledge_base_id, user_id
        )
        return can_manage_accessible_knowledge_base_documents(
            has_access, role, is_creator
        )

    @staticmethod
    def can_manage_knowledge_document(
        db: Session,
        knowledge_base_id: int,
        user_id: int,
        document_owner_id: int,
    ) -> bool:
        """Return whether the user can manage the target document."""
        has_access, role, is_creator = KnowledgeService._get_user_kb_permission(
            db, knowledge_base_id, user_id
        )
        return can_manage_accessible_knowledge_document(
            has_access=has_access,
            role=role,
            is_creator=is_creator,
            user_id=user_id,
            document_owner_id=document_owner_id,
        )

    @staticmethod
    def _get_bound_kb_ids_for_user(db: Session, user_id: int) -> list[int]:
        """Get IDs of knowledge bases bound to group chats where user is a member.

        This method finds all personal knowledge bases that have been bound to
        group chats where the specified user is a member.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            List of knowledge base IDs that are bound to user's group chats
        """
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
            raise ValueError("Knowledge base not found")

        # Only personal knowledge bases (namespace='default') can be migrated
        if kb.namespace != "default":
            raise ValueError("Only personal knowledge bases can be migrated to groups")

        # Only the creator can migrate
        if kb.user_id != user_id:
            raise ValueError("Only the creator can migrate this knowledge base")

        # Check if user has access to the target group
        target_role = get_effective_role_in_group(db, user_id, target_group_name)
        if target_role is None:
            raise ValueError(f"You don't have access to group '{target_group_name}'")

        # Check if user has Maintainer+ permission in target group
        if target_role not in {GroupRole.Owner, GroupRole.Maintainer}:
            raise ValueError(
                "You need Maintainer or Owner permission in the target group to migrate knowledge bases"
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
                raise ValueError(
                    f"A knowledge base with name '{kb_name}' already exists in the target group"
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

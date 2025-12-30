# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Retriever service for managing RAG retrieval configurations
"""
import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.namespace import Namespace
from app.models.namespace_member import NamespaceMember
from app.models.user import User
from app.schemas.kind import Retriever
from app.services.base import BaseService
from app.services.group_permission import check_group_permission, get_user_groups

logger = logging.getLogger(__name__)


class RetrieverKindsService(BaseService[Kind, Dict, Dict]):
    """
    Retriever service class using kinds table
    """

    def list_retrievers(
        self,
        db: Session,
        *,
        user_id: int,
        scope: str = "personal",
        group_name: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        List retrievers with scope support, including public retrievers.

        Scope behavior:
        - scope='personal' (default): personal retrievers + public retrievers (namespace='default')
        - scope='group': group retrievers + public retrievers (requires group_name or queries all user's groups)
        - scope='all': personal + all user's groups + public retrievers

        Query logic:
        - For personal scope (namespace='default'): query with user_id filter, plus public (user_id=0)
        - For group scope (namespace!='default'): query without user_id filter, plus public
          Group retrievers may be created by other users in the same group.

        Note: Public retrievers are always included, even if they have the same name as
        personal/group retrievers. The frontend will display them in separate sections.

        Args:
            db: Database session
            user_id: User ID
            scope: Query scope ('personal', 'group', or 'all')
            group_name: Group name (required when scope='group')

        Returns:
            List of retriever summaries
        """
        # Determine which namespaces to query based on scope
        personal_namespaces = []
        group_namespaces = []
        include_public = True  # Always include public retrievers

        if scope == "personal":
            # Personal retrievers only (default namespace)
            personal_namespaces = ["default"]
        elif scope == "group":
            # Group retrievers - if group_name not provided, query all user's groups
            if group_name:
                group_namespaces = [group_name]
            else:
                # Query all user's groups (excluding default)
                user_groups = get_user_groups(db, user_id)
                group_namespaces = user_groups if user_groups else []
        elif scope == "all":
            # Personal + all user's groups
            personal_namespaces = ["default"]
            group_namespaces = get_user_groups(db, user_id)
        else:
            raise ValueError(f"Invalid scope: {scope}")

        retrievers = []

        # Query personal retrievers (with user_id filter)
        if personal_namespaces:
            personal_retrievers = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Retriever",
                    Kind.namespace.in_(personal_namespaces),
                    Kind.is_active == True,
                )
                .order_by(Kind.created_at.desc())
                .all()
            )
            retrievers.extend(personal_retrievers)

        # Query group retrievers (without user_id filter)
        if group_namespaces:
            group_retrievers = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Retriever",
                    Kind.namespace.in_(group_namespaces),
                    Kind.is_active == True,
                )
                .order_by(Kind.created_at.desc())
                .all()
            )
            retrievers.extend(group_retrievers)

        # Query public retrievers (user_id=0) - always include
        if include_public:
            public_retrievers = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Retriever",
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .order_by(Kind.created_at.desc())
                .all()
            )
            logger.info(
                f"Found {len(public_retrievers)} public retrievers for user_id={user_id}, scope={scope}"
            )
            # Always include public retrievers, even if they have the same name
            # as personal/group retrievers. Frontend displays them in separate sections.
            retrievers.extend(public_retrievers)

        return [self._kind_to_summary(kind) for kind in retrievers]

    def get_retriever(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str = "default",
    ) -> Retriever:
        """
        Get a specific retriever by name with public retriever fallback.

        Query logic:
        - If namespace='default': query with user_id filter (personal retriever),
          fall back to public retriever (user_id=0) if not found
        - If namespace!='default': query without user_id filter (group retriever),
          fall back to public retriever if not found
          Group retrievers may be created by other users in the same group.

        Priority: personal/group retriever > public retriever

        Args:
            db: Database session
            user_id: User ID
            name: Retriever name
            namespace: Namespace

        Returns:
            Retriever CRD

        Raises:
            HTTPException: If retriever not found or access denied
        """
        # Check permissions for group resources
        if namespace != "default":
            if not check_group_permission(
                db, user_id, namespace, required_role="Reporter"
            ):
                raise HTTPException(
                    status_code=403, detail="Access denied to this group"
                )

        # Query retriever with priority fallback
        # For group resources (namespace != 'default'), don't filter by user_id
        # since the retriever may be created by other users in the same group
        kind = None

        if namespace == "default":
            # Personal retriever: filter by user_id, fallback to public (user_id=0)
            kind = (
                db.query(Kind)
                .filter(
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .filter((Kind.user_id == user_id) | (Kind.user_id == 0))
                .order_by(
                    Kind.user_id.desc()
                )  # Prioritize user's retriever (user_id > 0)
                .first()
            )
        else:
            # Group retriever: no user_id filter
            kind = (
                db.query(Kind)
                .filter(
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            # Fallback to public retriever if not found in group
            if not kind:
                kind = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == 0,
                        Kind.name == name,
                        Kind.kind == "Retriever",
                        Kind.namespace == "default",
                        Kind.is_active == True,
                    )
                    .first()
                )

        if not kind:
            raise HTTPException(status_code=404, detail="Retriever not found")

        return Retriever.model_validate(kind.json)

    def create_retriever(
        self,
        db: Session,
        *,
        user_id: int,
        retriever: Retriever,
    ) -> Retriever:
        """
        Create a new retriever.

        For group resources (namespace != 'default'), check if a retriever with the
        same name already exists in the group (regardless of who created it).

        Args:
            db: Database session
            user_id: User ID
            retriever: Retriever CRD

        Returns:
            Created Retriever CRD

        Raises:
            HTTPException: If validation fails or access denied
        """
        namespace = retriever.metadata.namespace or "default"

        # Check permissions for group resources
        if namespace != "default":
            if not check_group_permission(
                db, user_id, namespace, required_role="Developer"
            ):
                raise HTTPException(
                    status_code=403, detail="Access denied to this group"
                )

        # Check if retriever with same name already exists
        # For group resources, check without user_id filter (any user in the group)
        if namespace == "default":
            # Personal retriever: check only current user's retrievers
            existing = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.name == retriever.metadata.name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )
        else:
            # Group retriever: check all retrievers in the group
            existing = (
                db.query(Kind)
                .filter(
                    Kind.name == retriever.metadata.name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )

        if existing:
            if namespace == "default":
                raise HTTPException(
                    status_code=409,
                    detail="Retriever with this name already exists",
                )
            else:
                raise HTTPException(
                    status_code=409,
                    detail=f"Retriever with this name already exists in group {namespace}",
                )

        # Create Kind record
        kind = Kind(
            user_id=user_id,
            name=retriever.metadata.name,
            kind="Retriever",
            namespace=namespace,
            json=retriever.model_dump(mode="json", exclude_none=True),
            is_active=True,
        )
        db.add(kind)
        db.commit()
        db.refresh(kind)

        return Retriever.model_validate(kind.json)

    def update_retriever(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        retriever: Retriever,
    ) -> Retriever:
        """
        Update an existing retriever.

        Query logic:
        - If namespace='default': query with user_id filter (personal retriever)
        - If namespace!='default': query without user_id filter (group retriever)
          Group retrievers may be created by other users in the same group.

        Args:
            db: Database session
            user_id: User ID
            name: Retriever name
            retriever: Updated Retriever CRD

        Returns:
            Updated Retriever CRD

        Raises:
            HTTPException: If retriever not found or access denied
        """
        namespace = retriever.metadata.namespace or "default"

        # Check permissions for group resources
        if namespace != "default":
            if not check_group_permission(
                db, user_id, namespace, required_role="Developer"
            ):
                raise HTTPException(
                    status_code=403, detail="Access denied to this group"
                )

        # Query retriever
        # For group resources (namespace != 'default'), don't filter by user_id
        if namespace == "default":
            # Personal retriever: filter by user_id
            kind = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )
        else:
            # Group retriever: no user_id filter
            kind = (
                db.query(Kind)
                .filter(
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )

        if not kind:
            raise HTTPException(status_code=404, detail="Retriever not found")

        # Check for name conflicts if name is being changed
        new_name = retriever.metadata.name
        if new_name != name:
            # For group resources, check without user_id filter
            if namespace == "default":
                conflict = (
                    db.query(Kind)
                    .filter(
                        Kind.user_id == user_id,
                        Kind.name == new_name,
                        Kind.kind == "Retriever",
                        Kind.namespace == namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )
            else:
                conflict = (
                    db.query(Kind)
                    .filter(
                        Kind.name == new_name,
                        Kind.kind == "Retriever",
                        Kind.namespace == namespace,
                        Kind.is_active == True,
                    )
                    .first()
                )
            if conflict:
                raise HTTPException(
                    status_code=409,
                    detail=f"Retriever with name '{new_name}' already exists",
                )

        # Update Kind record
        kind.json = retriever.model_dump(mode="json", exclude_none=True)
        kind.name = new_name
        db.commit()
        db.refresh(kind)

        return Retriever.model_validate(kind.json)

    def delete_retriever(
        self,
        db: Session,
        *,
        user_id: int,
        name: str,
        namespace: str = "default",
    ) -> None:
        """
        Delete a retriever (soft delete).

        Query logic:
        - If namespace='default': query with user_id filter (personal retriever)
        - If namespace!='default': query without user_id filter (group retriever)
          Group retrievers may be created by other users in the same group.

        Args:
            db: Database session
            user_id: User ID
            name: Retriever name
            namespace: Namespace

        Raises:
            HTTPException: If retriever not found or access denied
        """
        # Check permissions for group resources
        if namespace != "default":
            if not check_group_permission(
                db, user_id, namespace, required_role="Maintainer"
            ):
                raise HTTPException(
                    status_code=403, detail="Access denied to this group"
                )

        # Query retriever
        # For group resources (namespace != 'default'), don't filter by user_id
        if namespace == "default":
            # Personal retriever: filter by user_id
            kind = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )
        else:
            # Group retriever: no user_id filter
            kind = (
                db.query(Kind)
                .filter(
                    Kind.name == name,
                    Kind.kind == "Retriever",
                    Kind.namespace == namespace,
                    Kind.is_active == True,
                )
                .first()
            )

        if not kind:
            raise HTTPException(status_code=404, detail="Retriever not found")

        # Soft delete
        kind.is_active = False
        db.commit()

    def count_retrievers(
        self,
        db: Session,
        *,
        user_id: int,
        scope: str = "personal",
        group_name: Optional[str] = None,
    ) -> int:
        """
        Count user's active retrievers based on scope.

        Scope behavior:
        - scope='personal' (default): personal retrievers only
        - scope='group': group retrievers (requires group_name or counts all user's groups)
        - scope='all': personal + all user's groups

        Query logic:
        - For personal scope (namespace='default'): count with user_id filter
        - For group scope (namespace!='default'): count without user_id filter
          Group retrievers may be created by other users in the same group.
        """
        # Determine which namespaces to count based on scope
        personal_namespaces = []
        group_namespaces = []

        if scope == "personal":
            personal_namespaces = ["default"]
        elif scope == "group":
            # Group retrievers - if group_name not provided, count all user's groups
            if group_name:
                group_namespaces = [group_name]
            else:
                # Count all user's groups (excluding default)
                user_groups = get_user_groups(db, user_id)
                group_namespaces = user_groups if user_groups else []
        elif scope == "all":
            personal_namespaces = ["default"]
            group_namespaces = get_user_groups(db, user_id)
        else:
            raise ValueError(f"Invalid scope: {scope}")

        # Handle empty namespaces case
        if not personal_namespaces and not group_namespaces:
            return 0

        total_count = 0

        # Count personal retrievers (with user_id filter)
        if personal_namespaces:
            personal_count = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Retriever",
                    Kind.namespace.in_(personal_namespaces),
                    Kind.is_active == True,
                )
                .count()
            )
            total_count += personal_count

        # Count group retrievers (without user_id filter)
        if group_namespaces:
            group_count = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Retriever",
                    Kind.namespace.in_(group_namespaces),
                    Kind.is_active == True,
                )
                .count()
            )
            total_count += group_count

        return total_count

    def _kind_to_summary(self, kind: Kind) -> Dict[str, Any]:
        """
        Convert Kind to retriever summary.

        Args:
            kind: Kind record

        Returns:
            Retriever summary dict
        """
        try:
            retriever = Retriever.model_validate(kind.json)
            # Determine type based on user_id and namespace
            # - user_id=0: public retriever
            # - namespace!='default': group retriever
            # - otherwise: user (personal) retriever
            if kind.user_id == 0:
                type_ = "public"
            elif kind.namespace != "default":
                type_ = "group"
            else:
                type_ = "user"
            return {
                "name": kind.name,
                "type": type_,
                "displayName": retriever.metadata.displayName or kind.name,
                "storageType": retriever.spec.storageConfig.type,
                "namespace": kind.namespace,
                "description": retriever.spec.description,
            }
        except Exception as e:
            logger.warning(f"Failed to parse retriever {kind.name}: {e}")
            # Determine type based on user_id and namespace
            if kind.user_id == 0:
                type_ = "public"
            elif kind.namespace != "default":
                type_ = "group"
            else:
                type_ = "user"
            return {
                "name": kind.name,
                "type": type_,
                "displayName": kind.name,
                "storageType": "unknown",
                "namespace": kind.namespace,
                "description": None,
            }


retriever_kinds_service = RetrieverKindsService(Kind)

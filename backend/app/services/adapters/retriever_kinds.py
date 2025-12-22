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
        List retrievers with scope support.

        Scope behavior:
        - scope='personal' (default): personal retrievers only (namespace='default')
        - scope='group': group retrievers (requires group_name or queries all user's groups)
        - scope='all': personal + all user's groups

        Args:
            db: Database session
            user_id: User ID
            scope: Query scope ('personal', 'group', or 'all')
            group_name: Group name (required when scope='group')

        Returns:
            List of retriever summaries
        """
        # Determine which namespaces to query based on scope
        namespaces_to_query = []

        if scope == "personal":
            # Personal retrievers only (default namespace)
            namespaces_to_query = ["default"]
        elif scope == "group":
            # Group retrievers - if group_name not provided, query all user's groups
            if group_name:
                namespaces_to_query = [group_name]
            else:
                # Query all user's groups (excluding default)
                user_groups = get_user_groups(db, user_id)
                namespaces_to_query = user_groups if user_groups else []
        elif scope == "all":
            # Personal + all user's groups
            namespaces_to_query = ["default"] + get_user_groups(db, user_id)
        else:
            raise ValueError(f"Invalid scope: {scope}")

        # Handle empty namespaces case
        if not namespaces_to_query:
            return []

        # Query retrievers from all target namespaces
        retrievers = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Retriever",
                Kind.namespace.in_(namespaces_to_query),
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .all()
        )

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
        Get a specific retriever by name.

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

        # Query retriever
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

        if not kind:
            raise HTTPException(status_code=404, detail="Retriever not found")

        # Check for name conflicts if name is being changed
        new_name = retriever.metadata.name
        if new_name != name:
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
        """
        # Determine which namespaces to count based on scope
        namespaces_to_count = []

        if scope == "personal":
            namespaces_to_count = ["default"]
        elif scope == "group":
            # Group retrievers - if group_name not provided, count all user's groups
            if group_name:
                namespaces_to_count = [group_name]
            else:
                # Count all user's groups (excluding default)
                user_groups = get_user_groups(db, user_id)
                namespaces_to_count = user_groups if user_groups else []
        elif scope == "all":
            namespaces_to_count = ["default"] + get_user_groups(db, user_id)
        else:
            raise ValueError(f"Invalid scope: {scope}")

        # Handle empty namespaces case
        if not namespaces_to_count:
            return 0

        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Retriever",
                Kind.namespace.in_(namespaces_to_count),
                Kind.is_active == True,
            )
            .count()
        )

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
            # Determine type based on namespace
            type_ = "group" if kind.namespace != "default" else "user"
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
            # Determine type based on namespace
            type_ = "group" if kind.namespace != "default" else "user"
            return {
                "name": kind.name,
                "type": type_,
                "displayName": kind.name,
                "storageType": "unknown",
                "namespace": kind.namespace,
                "description": None,
            }


retriever_kinds_service = RetrieverKindsService(Kind)

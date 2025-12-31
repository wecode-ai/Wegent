# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Public Retriever service for managing system-level retriever configurations.
Public retrievers are stored in the kinds table with user_id=0.
"""
import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.user import User
from app.schemas.kind import Retriever
from app.services.base import BaseService

logger = logging.getLogger(__name__)


class RetrieverAdapter:
    """
    Adapter to convert Kind (Retriever) to Retriever-like dictionary for API compatibility
    """

    @staticmethod
    def to_retriever_dict(kind: Kind) -> Dict[str, Any]:
        """
        Convert Kind (Retriever) to Retriever-like dictionary
        """
        display_name = None
        storage_type = "unknown"
        description = None

        if isinstance(kind.json, dict):
            try:
                retriever = Retriever.model_validate(kind.json)
                display_name = retriever.metadata.displayName
                storage_type = retriever.spec.storageConfig.type
                description = retriever.spec.description
            except Exception as e:
                logger.warning(f"Failed to parse retriever {kind.name}: {e}")

        return {
            "id": kind.id,
            "name": kind.name,
            "displayName": display_name,
            "namespace": kind.namespace,
            "storageType": storage_type,
            "description": description,
            "json": kind.json,
            "is_active": kind.is_active,
            "created_at": kind.created_at,
            "updated_at": kind.updated_at,
        }


class PublicRetrieverService(BaseService[Kind, Dict, Dict]):
    """
    Public Retriever service class - queries kinds table with user_id=0
    """

    def create_retriever(
        self, db: Session, *, retriever: Retriever, current_user: User
    ) -> Dict[str, Any]:
        """
        Create a Public Retriever entry in kinds table

        Args:
            db: Database session
            retriever: Retriever CRD
            current_user: Current admin user

        Returns:
            Created retriever dictionary

        Raises:
            HTTPException: If retriever with same name already exists
        """
        namespace = retriever.metadata.namespace or "default"

        # Ensure unique name in namespace
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Retriever",
                Kind.name == retriever.metadata.name,
                Kind.namespace == namespace,
                Kind.is_active == True,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Public retriever '{retriever.metadata.name}' already exists in namespace '{namespace}'",
            )

        # Create Kind record
        db_obj = Kind(
            user_id=0,
            kind="Retriever",
            name=retriever.metadata.name,
            namespace=namespace,
            json=retriever.model_dump(mode="json", exclude_none=True),
            is_active=True,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return RetrieverAdapter.to_retriever_dict(db_obj)

    def get_retrievers(
        self, db: Session, *, skip: int = 0, limit: int = 100, current_user: User
    ) -> List[Dict[str, Any]]:
        """
        Get active public retrievers from kinds table (paginated)

        Args:
            db: Database session
            skip: Number of records to skip
            limit: Maximum number of records to return
            current_user: Current admin user

        Returns:
            List of retriever dictionaries
        """
        public_retrievers = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Retriever",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .order_by(Kind.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )
        return [RetrieverAdapter.to_retriever_dict(r) for r in public_retrievers]

    def count_active_retrievers(self, db: Session, *, current_user: User) -> int:
        """
        Count active public retrievers in kinds table

        Args:
            db: Database session
            current_user: Current admin user

        Returns:
            Count of active public retrievers
        """
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Retriever",
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .count()
        )

    def get_by_id(
        self, db: Session, *, retriever_id: int, current_user: User
    ) -> Dict[str, Any]:
        """
        Get public retriever by ID from kinds table (only active)

        Args:
            db: Database session
            retriever_id: Retriever ID
            current_user: Current admin user

        Returns:
            Retriever dictionary

        Raises:
            HTTPException: If retriever not found
        """
        retriever = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Retriever",
                Kind.id == retriever_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not retriever:
            raise HTTPException(status_code=404, detail="Public retriever not found")
        return RetrieverAdapter.to_retriever_dict(retriever)

    def update_retriever(
        self,
        db: Session,
        *,
        retriever_id: int,
        retriever: Retriever,
        current_user: User,
    ) -> Dict[str, Any]:
        """
        Update public retriever by ID in kinds table

        Args:
            db: Database session
            retriever_id: Retriever ID
            retriever: Updated Retriever CRD
            current_user: Current admin user

        Returns:
            Updated retriever dictionary

        Raises:
            HTTPException: If retriever not found or name conflict
        """
        # Get the actual Kind object for update
        kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Retriever",
                Kind.id == retriever_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not kind:
            raise HTTPException(status_code=404, detail="Public retriever not found")

        # Check for name conflicts if name is being changed
        new_name = retriever.metadata.name
        new_namespace = retriever.metadata.namespace or "default"
        if new_name != kind.name or new_namespace != kind.namespace:
            conflict = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Retriever",
                    Kind.name == new_name,
                    Kind.namespace == new_namespace,
                    Kind.is_active == True,
                    Kind.id != retriever_id,
                )
                .first()
            )
            if conflict:
                raise HTTPException(
                    status_code=400,
                    detail=f"Public retriever with name '{new_name}' already exists in namespace '{new_namespace}'",
                )

        # Update Kind record
        kind.name = new_name
        kind.namespace = new_namespace
        kind.json = retriever.model_dump(mode="json", exclude_none=True)
        db.commit()
        db.refresh(kind)
        return RetrieverAdapter.to_retriever_dict(kind)

    def delete_retriever(
        self, db: Session, *, retriever_id: int, current_user: User
    ) -> None:
        """
        Delete public retriever from kinds table (hard delete)

        Args:
            db: Database session
            retriever_id: Retriever ID
            current_user: Current admin user

        Raises:
            HTTPException: If retriever not found
        """
        kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Retriever",
                Kind.id == retriever_id,
                Kind.is_active == True,
            )
            .first()
        )
        if not kind:
            raise HTTPException(status_code=404, detail="Public retriever not found")
        db.delete(kind)
        db.commit()


public_retriever_service = PublicRetrieverService(Kind)

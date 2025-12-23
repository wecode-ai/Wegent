# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Base service for all Kubernetes-style CRD operations
"""
import json
import logging
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Dict, Generic, List, Optional, Type, TypeVar

from sqlalchemy import and_
from sqlalchemy.orm import Session

from app.core.exceptions import ConflictException, NotFoundException
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.services.group_permission import check_user_group_permission

logger = logging.getLogger(__name__)


class KindBaseService(ABC):
    """Base service for all Kubernetes-style CRD operations"""

    def __init__(self, kind: str):
        self.kind = kind

    def get_db(self) -> Session:
        """Get database session"""
        return SessionLocal()

    def _build_filters(
        self, user_id: int, namespace: str, name: Optional[str] = None
    ) -> List:
        """Build database query filters

        For personal resources (namespace='default'), filter by user_id.
        For group resources, filter by namespace only (permission check is done separately).
        """
        filters = [
            Kind.kind == self.kind,
            Kind.namespace == namespace,
            Kind.is_active == True,
        ]

        # For personal resources, filter by user_id
        # For group resources, we query by namespace only
        if namespace == "default":
            filters.append(Kind.user_id == user_id)

        if name:
            filters.append(Kind.name == name)

        return filters

    def _check_group_permission(
        self, user_id: int, namespace: str, min_role: str = "Reporter"
    ) -> bool:
        """Check if user has permission to access resources in the given namespace

        Args:
            user_id: User ID
            namespace: Resource namespace
            min_role: Minimum required role (Reporter, Developer, Maintainer, Owner)

        Returns:
            bool: True if user has permission, False otherwise
        """
        if namespace == "default":
            return True

        # Check group permission
        return check_user_group_permission(user_id, namespace, min_role)

    def list_resources(self, user_id: int, namespace: str) -> List[Kind]:
        """List all resources in a namespace"""
        # Check group permission for non-default namespaces
        if not self._check_group_permission(user_id, namespace, "Reporter"):
            return []

        with self.get_db() as db:
            filters = self._build_filters(user_id, namespace)
            return db.query(Kind).filter(and_(*filters)).all()

    def get_resource(self, user_id: int, namespace: str, name: str) -> Optional[Kind]:
        """Get a specific resource"""
        # Check group permission for non-default namespaces
        if not self._check_group_permission(user_id, namespace, "Reporter"):
            return None

        with self.get_db() as db:
            filters = self._build_filters(user_id, namespace, name)
            return db.query(Kind).filter(and_(*filters)).first()

    def create_resource(self, user_id: int, resource: Dict[str, Any]) -> int:
        """Create a new resource and return its ID"""
        # Check group permission for non-default namespaces (need Maintainer or Owner)
        namespace = resource.get("metadata", {}).get("namespace", "default")
        if not self._check_group_permission(user_id, namespace, "Maintainer"):
            raise NotFoundException(
                f"Namespace '{namespace}' not found or permission denied"
            )

        with self.get_db() as db:
            # Check if resource already exists
            existing = self.get_resource(
                user_id, resource["metadata"]["namespace"], resource["metadata"]["name"]
            )

            if existing:
                raise ConflictException(
                    f"{self.kind} '{resource['metadata']['name']}' already exists"
                )

            # Extract resource data
            resource_data = self._extract_resource_data(resource)

            # Validate references
            self._validate_references(db, user_id, resource)

            # Create new resource
            db_resource = Kind(
                user_id=user_id,
                kind=self.kind,
                name=resource["metadata"]["name"],
                namespace=resource["metadata"]["namespace"],
                json=resource_data,
            )

            db.add(db_resource)
            db.commit()
            db.refresh(db_resource)

            # Get the resource ID
            resource_id = db_resource.id

            # Log resource creation
            logger.info(
                f"Created {self.kind} resource: name='{resource['metadata']['name']}', "
                f"namespace='{resource['metadata']['namespace']}', user_id={user_id}, "
                f"resource_id={resource_id}"
            )

            # Perform side effects
            self._perform_side_effects(db, user_id, db_resource, resource)

            return resource_id

    def update_resource(
        self, user_id: int, namespace: str, name: str, resource: Dict[str, Any]
    ) -> int:
        """Update an existing resource and return its ID"""
        # Check group permission for non-default namespaces (need Developer or above)
        if not self._check_group_permission(user_id, namespace, "Developer"):
            raise NotFoundException(
                f"{self.kind} '{name}' not found or permission denied"
            )

        with self.get_db() as db:
            filters = self._build_filters(user_id, namespace, name)
            db_resource = db.query(Kind).filter(and_(*filters)).first()
            if not db_resource:
                raise NotFoundException(f"{self.kind} '{name}' not found")

            # Validate references
            self._validate_references(db, user_id, resource)

            # Extract resource data
            resource_data = self._extract_resource_data(resource)

            # Update resource
            db_resource.json = resource_data
            db_resource.updated_at = datetime.now()

            db.commit()
            db.refresh(db_resource)

            # Get the resource ID
            resource_id = db_resource.id

            # Log resource update
            logger.info(
                f"Updated {self.kind} resource: name='{name}', "
                f"namespace='{namespace}', user_id={user_id}, "
                f"resource_id={resource_id}"
            )

            # Perform side effects
            self._update_side_effects(db, user_id, db_resource, resource)

            return resource_id

    def soft_delete_resource(self, user_id: int, namespace: str, name: str) -> bool:
        """Soft delete a resource (mark as inactive)"""
        # Check group permission for non-default namespaces (need Maintainer or Owner)
        if not self._check_group_permission(user_id, namespace, "Maintainer"):
            raise NotFoundException(
                f"{self.kind} '{name}' not found or permission denied"
            )

        with self.get_db() as db:
            filters = self._build_filters(user_id, namespace, name)
            db_resource = db.query(Kind).filter(and_(*filters)).first()
            if not db_resource:
                logger.warning(
                    f"Attempted to soft delete non-existent {self.kind} '{name}' in namespace '{namespace}' for user {user_id}"
                )
                raise NotFoundException(f"{self.kind} '{name}' not found")

            db_resource.is_active = False
            db_resource.updated_at = datetime.now()

            # Perform pre-delete side effects
            self._pre_delete_side_effects(db, user_id, db_resource)

            db.commit()
            logger.info(
                f"Soft deleted {self.kind} '{name}' in namespace '{namespace}' for user {user_id}"
            )

            # Perform post-delete side effects
            self._post_delete_side_effects(db, user_id, db_resource)

            return True

    def delete_resource(self, user_id: int, namespace: str, name: str) -> bool:
        """Hard delete a resource (permanently remove from database)"""
        # Check group permission for non-default namespaces (need Maintainer or Owner)
        if not self._check_group_permission(user_id, namespace, "Maintainer"):
            raise NotFoundException(
                f"{self.kind} '{name}' not found or permission denied"
            )

        with self.get_db() as db:
            filters = self._build_filters(user_id, namespace, name)
            db_resource = db.query(Kind).filter(and_(*filters)).first()
            if not db_resource:
                logger.warning(
                    f"Attempted to hard delete non-existent {self.kind} '{name}' in namespace '{namespace}' for user {user_id}"
                )
                raise NotFoundException(f"{self.kind} '{name}' not found")

            # Perform pre-delete side effects
            self._pre_delete_side_effects(db, user_id, db_resource)

            # Check if deletion should proceed
            if self._should_delete_resource(db, user_id, db_resource):
                db.delete(db_resource)
                db.commit()
                logger.info(
                    f"Hard deleted {self.kind} '{name}' in namespace '{namespace}' for user {user_id}"
                )

            # Perform post-delete side effects
            self._post_delete_side_effects(db, user_id, db_resource)

            return True

    def _extract_resource_data(self, resource: Dict[str, Any]) -> Dict[str, Any]:
        """Extract resource data directly from the resource object"""
        # Ensure status exists
        if "status" not in resource or resource["status"] is None:
            resource["status"] = {"state": "Available"}

        # Return the entire resource object
        return resource

    def _pre_delete_side_effects(
        self, db: Session, user_id: int, db_resource: Kind
    ) -> None:
        """Perform side effects before resource deletion"""
        pass

    def _post_delete_side_effects(
        self, db: Session, user_id: int, db_resource: Kind
    ) -> None:
        """Perform side effects after resource deletion"""
        pass

    def _should_delete_resource(
        self, db: Session, user_id: int, db_resource: Kind
    ) -> bool:
        """Determine whether the resource should be deleted

        Args:
            db: Database session
            user_id: User ID
            db_resource: The resource being deleted

        Returns:
            bool: True to proceed with deletion, False to cancel
        """
        return True

    @abstractmethod
    def _validate_references(
        self, db: Session, user_id: int, resource: Dict[str, Any]
    ) -> None:
        """Validate resource references"""
        pass

    def _perform_side_effects(
        self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]
    ) -> None:
        """Perform side effects after resource creation"""
        pass

    def _update_side_effects(
        self, db: Session, user_id: int, db_resource: Kind, resource: Dict[str, Any]
    ) -> None:
        """Perform side effects after resource update"""
        pass

    def _format_resource(self, resource: Kind) -> Dict[str, Any]:
        """Format resource for API response directly from stored JSON"""
        # Get the stored resource data
        stored_resource = resource.json

        # Ensure metadata has the correct name and namespace from the database
        result = stored_resource.copy()

        # Update metadata with values from the database (in case they were changed)
        if "metadata" not in result:
            result["metadata"] = {}

        result["metadata"]["name"] = resource.name
        result["metadata"]["namespace"] = resource.namespace

        # Ensure apiVersion and kind are set correctly
        result["apiVersion"] = "agent.wecode.io/v1"
        result["kind"] = self.kind

        return result

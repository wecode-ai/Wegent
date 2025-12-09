# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unified Kind service for all Kubernetes-style CRD operations
"""
from typing import Any, Dict, List, Optional

from app.core.exceptions import NotFoundException
from app.models.kind import Kind
from app.services.kind_factory import KindServiceFactory


class KindService:
    """Unified service for all Kubernetes-style CRD operations"""

    def list_resources(self, user_id: int, kind: str, namespace: str) -> List[Kind]:
        """List all resources of a specific kind in a namespace"""
        service = KindServiceFactory.get_service(kind)
        return service.list_resources(user_id, namespace)

    def get_resource(
        self, user_id: int, kind: str, namespace: str, name: str
    ) -> Optional[Kind]:
        """Get a specific resource"""
        service = KindServiceFactory.get_service(kind)
        return service.get_resource(user_id, namespace, name)

    def create_resource(self, user_id: int, kind: str, resource: Dict[str, Any]) -> int:
        """Create a new resource and return its ID"""
        service = KindServiceFactory.get_service(kind)
        return service.create_resource(user_id, resource)

    def update_resource(
        self,
        user_id: int,
        kind: str,
        namespace: str,
        name: str,
        resource: Dict[str, Any],
    ) -> int:
        """Update an existing resource and return its ID"""
        service = KindServiceFactory.get_service(kind)
        return service.update_resource(user_id, namespace, name, resource)

    def delete_resource(
        self, user_id: int, kind: str, namespace: str, name: str
    ) -> bool:
        """Delete a resource (soft delete)"""
        service = KindServiceFactory.get_service(kind)
        return service.delete_resource(user_id, namespace, name)

    def _extract_resource_data(
        self, kind: str, resource: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Extract resource data directly from the resource object"""
        service = KindServiceFactory.get_service(kind)
        return service._extract_resource_data(resource)

    def _format_resource(self, kind: str, resource: Kind) -> Dict[str, Any]:
        """Format resource for API response directly from stored JSON"""
        service = KindServiceFactory.get_service(kind)
        return service._format_resource(resource)

    def _format_resource_by_id(self, kind: str, resource_id: int) -> Dict[str, Any]:
        """Format resource for API response by ID using a new session"""
        from app.db.session import SessionLocal

        with SessionLocal() as db:
            resource = (
                db.query(Kind)
                .filter(
                    Kind.id == resource_id, Kind.kind == kind, Kind.is_active == True
                )
                .first()
            )

            if not resource:
                raise NotFoundException(f"{kind} with ID {resource_id} not found")

            service = KindServiceFactory.get_service(kind)
            return service._format_resource(resource)

    def get_resource_by_id(self, kind: str, resource_id: int) -> Optional[Kind]:
        """Get a resource by its ID using a new session"""
        from app.db.session import SessionLocal

        with SessionLocal() as db:
            resource = (
                db.query(Kind)
                .filter(
                    Kind.id == resource_id, Kind.kind == kind, Kind.is_active == True
                )
                .first()
            )
            return resource

    def get_team_by_id(self, team_id: int) -> Optional[Dict[str, Any]]:
        """Get a team by its ID and return formatted data"""
        from app.db.session import SessionLocal

        with SessionLocal() as db:
            resource = (
                db.query(Kind)
                .filter(Kind.id == team_id, Kind.kind == "Team", Kind.is_active == True)
                .first()
            )
            if not resource:
                return None

            service = KindServiceFactory.get_service("Team")
            formatted = service._format_resource(resource)
            # Add the database ID
            formatted["id"] = resource.id
            # Add agent_type from the resource's json
            if resource.json:
                formatted["agent_type"] = resource.json.get("agent_type")
            return formatted


# Create service instance
kind_service = KindService()

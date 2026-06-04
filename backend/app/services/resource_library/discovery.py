# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge-backed discovery index for Resource Library listings."""

from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.namespace import Namespace
from app.models.user import User
from app.schemas.namespace import GroupLevel
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.orchestrator import knowledge_orchestrator
from app.services.resource_library.service import (
    RESOURCE_LIBRARY_STATUS_PUBLISHED,
    resource_library_service,
)

logger = logging.getLogger(__name__)

DISCOVERY_SOURCE = "resource_library"
DISCOVERY_CONFIG_KIND = "ResourceLibraryDiscoveryConfig"
DISCOVERY_CONFIG_NAME = "default"
DISCOVERY_CONFIG_NAMESPACE = "resource-library"
DEFAULT_DISCOVERY_ASSISTANT_TEAM = {
    "name": "resource-discovery-assistant",
    "namespace": "default",
}


class ResourceLibraryDiscoveryService:
    """Maintain and query the organization KB used by Resource Library discovery."""

    def get_page_config(self, db: Session) -> dict[str, Any]:
        config = self.find_discovery_config_kind(db)
        spec = self._kind_spec(config)
        knowledge_base = self.find_discovery_knowledge_base(db)
        assistant_team_ref = spec.get("assistantTeamRef")
        if not isinstance(assistant_team_ref, dict):
            assistant_team_ref = DEFAULT_DISCOVERY_ASSISTANT_TEAM

        return {
            "knowledge_base_ref": (
                self._knowledge_base_payload(knowledge_base)
                if knowledge_base
                else self._configured_knowledge_base_ref(spec)
            ),
            "assistant_team_ref": {
                "name": assistant_team_ref.get("name")
                or DEFAULT_DISCOVERY_ASSISTANT_TEAM["name"],
                "namespace": assistant_team_ref.get("namespace")
                or DEFAULT_DISCOVERY_ASSISTANT_TEAM["namespace"],
            },
        }

    def find_discovery_config_kind(self, db: Session) -> Kind | None:
        return (
            db.query(Kind)
            .filter(
                Kind.kind == DISCOVERY_CONFIG_KIND,
                Kind.name == DISCOVERY_CONFIG_NAME,
                Kind.namespace == DISCOVERY_CONFIG_NAMESPACE,
                Kind.is_active == True,
            )
            .first()
        )

    def sync_listing(self, db: Session, listing: Kind) -> dict[str, Any]:
        """Synchronize a published listing into the organization discovery KB."""
        if not settings.RESOURCE_LIBRARY_DISCOVERY_SYNC_ENABLED:
            return {"status": "disabled"}
        if resource_library_service.get_listing_status(listing) != (
            RESOURCE_LIBRARY_STATUS_PUBLISHED
        ):
            return self.remove_listing_document(db, listing)

        knowledge_base = self.find_discovery_knowledge_base(db)
        if knowledge_base is None:
            return {"status": "missing_knowledge_base"}

        owner = db.query(User).filter(User.id == knowledge_base.user_id).first()
        if owner is None:
            return {"status": "missing_knowledge_base_owner"}

        content = self.build_listing_document_content(db, listing)
        document = self.find_listing_document(db, listing_id=listing.id)
        document_name = self._document_name(listing)
        source_config = self._source_config(listing)

        if document and document.attachment_id:
            knowledge_orchestrator.update_document_content(
                db=db,
                user=owner,
                document_id=document.id,
                content=content,
                trigger_reindex=True,
            )
            document.name = document_name
            document.source_config = source_config
            flag_modified(document, "source_config")
            db.commit()
            return {"status": "updated", "document_id": document.id}

        if document:
            KnowledgeService.delete_document(
                db=db,
                document_id=document.id,
                user_id=owner.id,
            )

        created = knowledge_orchestrator.create_document_with_content(
            db=db,
            user=owner,
            knowledge_base_id=knowledge_base.id,
            name=document_name,
            source_type="text",
            content=content,
            file_extension="md",
            trigger_indexing=True,
            trigger_summary=False,
        )
        created_doc = (
            db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == created.id)
            .first()
        )
        if created_doc:
            created_doc.source_config = source_config
            flag_modified(created_doc, "source_config")
            db.commit()
        return {"status": "created", "document_id": created.id}

    def remove_listing_document(self, db: Session, listing: Kind) -> dict[str, Any]:
        knowledge_base = self.find_discovery_knowledge_base(db)
        if knowledge_base is None:
            return {"status": "missing_knowledge_base"}
        owner = db.query(User).filter(User.id == knowledge_base.user_id).first()
        document = self.find_listing_document(db, listing_id=listing.id)
        if owner is None or document is None:
            return {"status": "not_found"}

        KnowledgeService.delete_document(
            db=db,
            document_id=document.id,
            user_id=owner.id,
        )
        return {"status": "deleted", "document_id": document.id}

    def find_discovery_knowledge_base(self, db: Session) -> Kind | None:
        config = self.find_discovery_config_kind(db)
        spec = self._kind_spec(config)
        configured_ref = self._configured_knowledge_base_ref(spec)
        configured_id = configured_ref.get("id")
        if configured_id:
            try:
                configured_kb_id = int(configured_id)
            except (TypeError, ValueError):
                configured_kb_id = 0
            knowledge_base = (
                db.query(Kind)
                .filter(
                    Kind.id == configured_kb_id,
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active == True,
                )
                .first()
            )
            if knowledge_base and self._is_organization_knowledge_base(
                db, knowledge_base
            ):
                return knowledge_base

        namespace_names = self._organization_namespace_names(db)
        if not namespace_names:
            return None

        query = db.query(Kind).filter(
            Kind.kind == "KnowledgeBase",
            Kind.is_active == True,
            Kind.namespace.in_(namespace_names),
        )
        configured_namespace = str(
            configured_ref.get("namespace")
            or settings.RESOURCE_LIBRARY_DISCOVERY_KB_NAMESPACE
            or ""
        ).strip()
        if configured_namespace:
            query = query.filter(Kind.namespace == configured_namespace)

        configured_name = str(
            configured_ref.get("name") or settings.RESOURCE_LIBRARY_DISCOVERY_KB_NAME
        ).strip()
        for knowledge_base in query.order_by(Kind.updated_at.desc(), Kind.id.desc()):
            spec = self._kind_spec(knowledge_base)
            if spec.get("name") == configured_name:
                return knowledge_base
        return None

    def find_listing_document(
        self,
        db: Session,
        *,
        listing_id: int,
    ) -> KnowledgeDocument | None:
        return (
            db.query(KnowledgeDocument)
            .filter(
                KnowledgeDocument.source_config["source"].as_string()
                == DISCOVERY_SOURCE,
                KnowledgeDocument.source_config[
                    "resource_library_listing_id"
                ].as_integer()
                == listing_id,
            )
            .order_by(KnowledgeDocument.updated_at.desc(), KnowledgeDocument.id.desc())
            .first()
        )

    def build_listing_document_content(self, db: Session, listing: Kind) -> str:
        spec = self._kind_spec(listing)
        metadata = self._kind_metadata(listing)
        source = resource_library_service._source_for_listing(db, listing)
        source_metadata = self._kind_metadata(source) if source else {}
        source_spec = self._kind_spec(source) if source else {}
        source_description = (
            source_metadata.get("description")
            or source_spec.get("description")
            or source_spec.get("systemPrompt")
            or ""
        )

        tags = spec.get("tags") or []
        tag_text = ", ".join(str(tag) for tag in tags) if tags else "none"
        resource_type = str(spec.get("resourceType") or "")

        return "\n".join(
            [
                f"# {spec.get('displayName') or listing.name}",
                "",
                "## Resource Library Listing",
                f"- Listing ID: {listing.id}",
                f"- Resource type: {resource_type}",
                f"- Resource name: {spec.get('name') or listing.name}",
                f"- Version: {spec.get('version') or '1.0.0'}",
                f"- Tags: {tag_text}",
                f"- Publisher user ID: {listing.user_id}",
                f"- Updated at: {listing.updated_at}",
                "",
                "## Listing Description",
                str(spec.get("description") or metadata.get("description") or ""),
                "",
                "## Source Resource",
                f"- Kind: {source.kind if source else spec.get('sourceKind')}",
                f"- ID: {source.id if source else spec.get('sourceKindId')}",
                f"- Namespace: {source.namespace if source else spec.get('sourceNamespace')}",
                f"- Name: {source.name if source else ''}",
                f"- Description: {source_description}",
            ]
        )

    def _organization_namespace_names(self, db: Session) -> list[str]:
        rows = (
            db.query(Namespace.name)
            .filter(
                Namespace.level == GroupLevel.organization.value,
                Namespace.is_active == True,
            )
            .all()
        )
        return [row.name for row in rows]

    def _knowledge_base_payload(self, knowledge_base: Kind) -> dict[str, Any]:
        spec = self._kind_spec(knowledge_base)
        return {
            "id": knowledge_base.id,
            "name": spec.get("name") or knowledge_base.name,
            "namespace": knowledge_base.namespace,
        }

    def _configured_knowledge_base_ref(self, spec: dict[str, Any]) -> dict[str, Any]:
        configured_ref = spec.get("knowledgeBaseRef")
        if not isinstance(configured_ref, dict):
            configured_ref = {}
        return {
            "id": configured_ref.get("id"),
            "name": configured_ref.get("name")
            or settings.RESOURCE_LIBRARY_DISCOVERY_KB_NAME,
            "namespace": configured_ref.get("namespace")
            or settings.RESOURCE_LIBRARY_DISCOVERY_KB_NAMESPACE
            or None,
        }

    def _is_organization_knowledge_base(
        self, db: Session, knowledge_base: Kind
    ) -> bool:
        return knowledge_base.namespace in self._organization_namespace_names(db)

    def _source_config(self, listing: Kind) -> dict[str, Any]:
        spec = self._kind_spec(listing)
        return {
            "source": DISCOVERY_SOURCE,
            "resource_library_listing_id": listing.id,
            "resource_type": spec.get("resourceType"),
            "source_kind": spec.get("sourceKind"),
            "source_kind_id": spec.get("sourceKindId"),
        }

    def _document_name(self, listing: Kind) -> str:
        display_name = self._kind_spec(listing).get("displayName") or listing.name
        cleaned = re.sub(r"\s+", " ", str(display_name)).strip()
        return f"{cleaned[:180]} - 资源库说明"

    def _listing_description(self, listing: Kind) -> str:
        spec = self._kind_spec(listing)
        return str(spec.get("description") or "")

    def _kind_spec(self, kind: Kind | None) -> dict[str, Any]:
        if not kind or not isinstance(kind.json, dict):
            return {}
        spec = kind.json.get("spec")
        return spec if isinstance(spec, dict) else {}

    def _kind_metadata(self, kind: Kind | None) -> dict[str, Any]:
        if not kind or not isinstance(kind.json, dict):
            return {}
        metadata = kind.json.get("metadata")
        return metadata if isinstance(metadata, dict) else {}


resource_library_discovery_service = ResourceLibraryDiscoveryService()

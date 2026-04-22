# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Template service for managing template CRUD operations.

Templates are stored as Kind records with kind='Template', user_id=0, namespace='system'.
"""

import logging
from typing import Any, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.template import (
    TemplateCreate,
    TemplateInstantiateResponse,
    TemplateListResponse,
    TemplateResources,
    TemplateResponse,
    TemplateUpdate,
)
from app.services.template_instantiation import get_instantiator

logger = logging.getLogger(__name__)

TEMPLATE_KIND = "Template"
TEMPLATE_NAMESPACE = "system"
TEMPLATE_USER_ID = 0  # System-owned resource
ALLOWED_TEMPLATE_MODEL_BINDING_KEYS = {
    "bind_model",
    "bind_model_type",
    "bind_model_namespace",
}
ALLOWED_TEMPLATE_MODEL_TYPES = {"public", "user", "group"}


class TemplateService:
    """Service for template CRUD and instantiation."""

    def create_template(self, db: Session, data: TemplateCreate) -> TemplateResponse:
        """Create a new template (admin only)."""
        # Check duplicate name
        existing = (
            db.query(Kind)
            .filter(
                Kind.kind == TEMPLATE_KIND,
                Kind.name == data.name,
                Kind.namespace == TEMPLATE_NAMESPACE,
                Kind.is_active == True,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Template '{data.name}' already exists",
            )

        self._validate_resources_for_write(data.resources)

        # Build CRD JSON
        resource_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": TEMPLATE_KIND,
            "metadata": {
                "name": data.name,
                "namespace": TEMPLATE_NAMESPACE,
            },
            "spec": {
                "displayName": data.displayName,
                "description": data.description,
                "category": data.category,
                "tags": data.tags,
                "icon": data.icon,
                "resources": data.resources.model_dump(mode="json"),
            },
            "status": {"state": "Available"},
        }

        db_template = Kind(
            user_id=TEMPLATE_USER_ID,
            kind=TEMPLATE_KIND,
            name=data.name,
            namespace=TEMPLATE_NAMESPACE,
            json=resource_json,
            is_active=True,
        )
        db.add(db_template)
        db.commit()
        db.refresh(db_template)

        logger.info(f"Created template: id={db_template.id}, name={data.name}")
        return self._to_response(db_template)

    def update_template(
        self, db: Session, template_id: int, data: TemplateUpdate
    ) -> TemplateResponse:
        """Update an existing template (admin only)."""
        template = self._get_template_or_404(db, template_id)

        spec = dict(template.json.get("spec", {}))
        if data.displayName is not None:
            spec["displayName"] = data.displayName
        if data.description is not None:
            spec["description"] = data.description
        if data.category is not None:
            spec["category"] = data.category
        if data.tags is not None:
            spec["tags"] = data.tags
        if data.icon is not None:
            spec["icon"] = data.icon
        if data.resources is not None:
            self._validate_resources_for_write(data.resources)
            spec["resources"] = data.resources.model_dump(mode="json")

        # Replace entire json to trigger SQLAlchemy dirty tracking
        updated_json = dict(template.json)
        updated_json["spec"] = spec
        template.json = updated_json

        db.commit()
        db.refresh(template)

        logger.info(f"Updated template: id={template_id}")
        return self._to_response(template)

    def delete_template(self, db: Session, template_id: int) -> bool:
        """Soft-delete a template (admin only)."""
        template = self._get_template_or_404(db, template_id)
        template.is_active = False
        db.commit()
        logger.info(f"Deleted template: id={template_id}")
        return True

    def list_templates(
        self, db: Session, category: Optional[str] = None
    ) -> TemplateListResponse:
        """List available templates, optionally filtered by category."""
        query = db.query(Kind).filter(
            Kind.kind == TEMPLATE_KIND,
            Kind.is_active == True,
        )

        templates = query.order_by(Kind.created_at.desc()).all()

        # Filter by category in Python for cross-DB compatibility
        if category:
            templates = [
                t
                for t in templates
                if t.json.get("spec", {}).get("category") == category
            ]

        items = [self._to_response(t) for t in templates]
        return TemplateListResponse(total=len(items), items=items)

    def get_template(self, db: Session, template_id: int) -> TemplateResponse:
        """Get a single template by ID."""
        template = self._get_template_or_404(db, template_id)
        return self._to_response(template)

    def instantiate_template(
        self, db: Session, user_id: int, template_id: int
    ) -> TemplateInstantiateResponse:
        """Instantiate a template, creating all related resources."""
        template = self._get_template_or_404(db, template_id)
        spec = template.json.get("spec", {})
        category = spec.get("category", "inbox")

        instantiator = get_instantiator(category)
        try:
            result = instantiator.instantiate(db, user_id, template)
            db.commit()
            logger.info(
                f"Instantiated template: template_id={template_id}, "
                f"user_id={user_id}, queue_id={result.queueId}"
            )
            return result
        except HTTPException:
            db.rollback()
            raise
        except Exception as e:
            db.rollback()
            logger.error(f"Failed to instantiate template {template_id}: {e}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to instantiate template: {str(e)}",
            )

    def _get_template_or_404(self, db: Session, template_id: int) -> Kind:
        """Get a template Kind record or raise 404."""
        template = (
            db.query(Kind)
            .filter(
                Kind.id == template_id,
                Kind.kind == TEMPLATE_KIND,
                Kind.is_active == True,
            )
            .first()
        )
        if not template:
            raise HTTPException(status_code=404, detail="Template not found")
        return template

    def _to_response(self, kind: Kind) -> TemplateResponse:
        """Convert a Kind record to TemplateResponse."""
        spec = kind.json.get("spec", {})
        return TemplateResponse(
            id=kind.id,
            name=kind.name,
            displayName=spec.get("displayName", kind.name),
            description=spec.get("description"),
            category=spec.get("category", "inbox"),
            tags=spec.get("tags", []),
            icon=spec.get("icon"),
            resources=spec.get("resources", {}),
            createdAt=kind.created_at,
            updatedAt=kind.updated_at,
        )

    def _validate_resources_for_write(self, resources: TemplateResources) -> None:
        """Validate template resources for create/update write paths only."""
        bot = resources.bot
        if not bot or not bot.agentConfig:
            return

        self._validate_bot_agent_config(bot.agentConfig)

    def _validate_bot_agent_config(self, agent_config: Any) -> None:
        """Validate template bot agentConfig uses the standard model binding shape."""
        if not isinstance(agent_config, dict):
            raise HTTPException(
                status_code=400,
                detail="Template bot agentConfig must be a JSON object",
            )

        if "namespace" in agent_config:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Template bot agentConfig must use bind_model_namespace; "
                    "legacy namespace is not allowed"
                ),
            )

        keys = set(agent_config.keys())
        unknown_keys = keys - ALLOWED_TEMPLATE_MODEL_BINDING_KEYS
        if unknown_keys:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Template bot agentConfig only supports bind_model, "
                    "bind_model_type, and bind_model_namespace; "
                    f"unsupported keys: {sorted(unknown_keys)}"
                ),
            )

        bind_model = agent_config.get("bind_model")
        if not isinstance(bind_model, str) or not bind_model.strip():
            raise HTTPException(
                status_code=400,
                detail="Template bot agentConfig must provide a non-empty bind_model",
            )

        model_type = agent_config.get("bind_model_type")
        if model_type is not None and model_type not in ALLOWED_TEMPLATE_MODEL_TYPES:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Template bot agentConfig bind_model_type must be one of "
                    "public, user, or group"
                ),
            )

        model_namespace = agent_config.get("bind_model_namespace")
        if model_namespace is not None and (
            not isinstance(model_namespace, str) or not model_namespace.strip()
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Template bot agentConfig bind_model_namespace must be a "
                    "non-empty string when provided"
                ),
            )


template_service = TemplateService()

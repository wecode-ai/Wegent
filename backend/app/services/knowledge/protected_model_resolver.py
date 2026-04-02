# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Model resolution for protected knowledge mediation."""

from __future__ import annotations

import logging
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.chat.config import extract_and_process_model_config

logger = logging.getLogger(__name__)


class ProtectedModelResolver:
    """Resolve the model config used for restricted safe-summary mediation."""

    def resolve_model_config(
        self,
        *,
        db: Session,
        mediation_context: dict | None,
        knowledge_base_ids: list[int],
        user_id: int | None,
        user_name: str = "system",
    ) -> dict[str, Any]:
        """Resolve the best available model config for protected mediation."""
        if mediation_context and mediation_context.get("current_model_name"):
            current_model = self._resolve_named_model(
                db=db,
                model_name=mediation_context["current_model_name"],
                model_namespace=mediation_context.get(
                    "current_model_namespace", "default"
                ),
                user_id=user_id,
                user_name=user_name,
            )
            if current_model:
                return current_model

        summary_model = self._resolve_summary_or_system_fallback(
            db=db,
            knowledge_base_ids=knowledge_base_ids,
            user_id=user_id,
            user_name=user_name,
        )
        if summary_model:
            return summary_model

        logger.warning(
            "[protected_model_resolver] No mediation model resolved: user_id=%s, knowledge_base_ids=%s",
            user_id,
            knowledge_base_ids,
        )
        return {}

    def _resolve_named_model(
        self,
        *,
        db: Session,
        model_name: str,
        model_namespace: str,
        user_id: int | None,
        user_name: str,
    ) -> Optional[dict[str, Any]]:
        """Resolve a named model using user/group/public lookup priority."""
        model_kind, model_type = self._lookup_model_kind(
            db=db,
            model_name=model_name,
            model_namespace=model_namespace,
            model_type=None,
            user_id=user_id,
        )
        if model_kind is None or model_type is None:
            return None
        return self._build_model_config(
            model_kind=model_kind,
            model_name=model_name,
            model_namespace=model_namespace,
            model_type=model_type,
            user_id=user_id,
            user_name=user_name,
        )

    def _resolve_summary_or_system_fallback(
        self,
        *,
        db: Session,
        knowledge_base_ids: list[int],
        user_id: int | None,
        user_name: str,
    ) -> Optional[dict[str, Any]]:
        """Resolve KB summary model refs as the fallback mediation model."""
        if not knowledge_base_ids:
            return None

        knowledge_bases = (
            db.query(Kind)
            .filter(
                Kind.id.in_(knowledge_base_ids),
                Kind.kind == "KnowledgeBase",
                Kind.is_active == True,
            )
            .all()
        )
        for kb in knowledge_bases:
            spec = (kb.json or {}).get("spec", {})
            summary_model_ref = spec.get("summaryModelRef") or {}
            model_name = summary_model_ref.get("name")
            if not model_name:
                continue

            model_namespace = summary_model_ref.get("namespace", "default")
            model_type = summary_model_ref.get("type")
            model_kind, resolved_model_type = self._lookup_model_kind(
                db=db,
                model_name=model_name,
                model_namespace=model_namespace,
                model_type=model_type,
                user_id=user_id,
            )
            if model_kind is None:
                continue

            return self._build_model_config(
                model_kind=model_kind,
                model_name=model_name,
                model_namespace=model_namespace,
                model_type=resolved_model_type or model_type or "public",
                user_id=user_id,
                user_name=user_name,
            )

        return None

    def _lookup_model_kind(
        self,
        *,
        db: Session,
        model_name: str,
        model_namespace: str,
        model_type: str | None,
        user_id: int | None,
    ) -> tuple[Optional[Kind], Optional[str]]:
        """Find the model Kind and normalized model type."""
        if model_type == "public":
            model_kind = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == "default",
                    Kind.is_active == True,
                )
                .first()
            )
            if model_kind:
                return model_kind, "public"
            return None, None

        if model_type in {"user", "group"} and user_id is not None:
            model_kind = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if model_kind:
                return model_kind, model_type

        if user_id is not None:
            user_kind = (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Model",
                    Kind.name == model_name,
                    Kind.namespace == model_namespace,
                    Kind.is_active == True,
                )
                .first()
            )
            if user_kind:
                normalized_type = "user" if model_namespace == "default" else "group"
                return user_kind, normalized_type

        public_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )
        if public_kind:
            return public_kind, "public"

        return None, None

    def _build_model_config(
        self,
        *,
        model_kind: Kind,
        model_name: str,
        model_namespace: str,
        model_type: str,
        user_id: int | None,
        user_name: str,
    ) -> dict[str, Any]:
        """Build processed model config from a model Kind."""
        model_spec = (model_kind.json or {}).get("spec", {})
        processed_config = extract_and_process_model_config(
            model_spec=model_spec,
            user_id=user_id or 0,
            user_name=user_name,
        )
        processed_config.setdefault("model_name", model_name)
        processed_config.setdefault("model_namespace", model_namespace)
        processed_config.setdefault("model_type", model_type)
        return processed_config


protected_model_resolver = ProtectedModelResolver()

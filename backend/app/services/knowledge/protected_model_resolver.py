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

    def load_knowledge_base_snapshots(
        self,
        *,
        db: Session,
        knowledge_base_ids: list[int],
    ) -> list[dict[str, Any]]:
        """Load KB names and summary-model refs in request order."""
        if not knowledge_base_ids:
            return []

        try:
            knowledge_bases = (
                db.query(Kind)
                .filter(
                    Kind.id.in_(knowledge_base_ids),
                    Kind.kind == "KnowledgeBase",
                    Kind.is_active,
                )
                .all()
            )
        except Exception:
            logger.debug(
                "[protected_model_resolver] Failed to load KB snapshots",
                exc_info=True,
            )
            return []

        snapshots_by_id: dict[int, dict[str, Any]] = {}
        for kb in knowledge_bases:
            spec = (kb.json or {}).get("spec", {})
            snapshots_by_id[kb.id] = {
                "id": kb.id,
                "name": spec.get("name", f"KB-{kb.id}"),
                "summary_model_ref": spec.get("summaryModelRef") or {},
            }

        return [
            snapshots_by_id[kb_id]
            for kb_id in knowledge_base_ids
            if kb_id in snapshots_by_id
        ]

    def resolve_model_config(
        self,
        *,
        db: Session,
        mediation_context: dict | None,
        knowledge_base_ids: list[int],
        knowledge_base_snapshots: list[dict[str, Any]] | None = None,
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
            knowledge_base_snapshots=knowledge_base_snapshots,
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
            model_name=str(model_kind.name),
            model_namespace=str(model_kind.namespace),
            model_type=model_type,
            user_id=user_id,
            user_name=user_name,
        )

    def _resolve_summary_or_system_fallback(
        self,
        *,
        db: Session,
        knowledge_base_ids: list[int],
        knowledge_base_snapshots: list[dict[str, Any]] | None,
        user_id: int | None,
        user_name: str,
    ) -> Optional[dict[str, Any]]:
        """Resolve KB summary model refs as the fallback mediation model."""
        if not knowledge_base_ids:
            return None

        snapshots = knowledge_base_snapshots
        if snapshots is None:
            snapshots = self.load_knowledge_base_snapshots(
                db=db,
                knowledge_base_ids=knowledge_base_ids,
            )

        summary_model_refs = self._collect_unique_summary_model_refs(snapshots)
        resolved_model_kinds = self._batch_lookup_summary_model_kinds(
            db=db,
            summary_model_refs=summary_model_refs,
            user_id=user_id,
        )

        for summary_model_ref in summary_model_refs:
            model_name = summary_model_ref["name"]
            model_namespace = summary_model_ref["namespace"]
            model_type = summary_model_ref["type"]
            resolved = resolved_model_kinds.get(
                (model_name, model_namespace, model_type)
            )
            if resolved is None:
                continue

            model_kind, resolved_model_type = resolved

            return self._build_model_config(
                model_kind=model_kind,
                model_name=str(model_kind.name),
                model_namespace=str(model_kind.namespace),
                model_type=resolved_model_type or model_type or "public",
                user_id=user_id,
                user_name=user_name,
            )

        return None

    def _collect_unique_summary_model_refs(
        self,
        snapshots: list[dict[str, Any]],
    ) -> list[dict[str, str | None]]:
        """Collect unique summary model refs in snapshot order."""
        unique_refs: list[dict[str, str | None]] = []
        seen_refs: set[tuple[str, str, str | None]] = set()

        for snapshot in snapshots:
            summary_model_ref = snapshot.get("summary_model_ref") or {}
            model_name = summary_model_ref.get("name")
            if not model_name:
                continue

            model_namespace = summary_model_ref.get("namespace", "default")
            model_type = summary_model_ref.get("type")
            ref_key = (model_name, model_namespace, model_type)
            if ref_key in seen_refs:
                continue
            seen_refs.add(ref_key)
            unique_refs.append(
                {
                    "name": model_name,
                    "namespace": model_namespace,
                    "type": model_type,
                }
            )

        return unique_refs

    def _load_user_model_kinds(
        self,
        *,
        db: Session,
        user_id: int | None,
        model_refs: list[dict[str, str | None]],
    ) -> dict[tuple[str, str], Kind]:
        """Batch-load user/group scoped models for candidate refs."""
        if user_id is None:
            return {}

        user_names = {
            str(model_ref["name"])
            for model_ref in model_refs
            if model_ref.get("type") != "public"
        }
        user_namespaces = {
            str(model_ref["namespace"])
            for model_ref in model_refs
            if model_ref.get("type") != "public"
        }
        if not user_names or not user_namespaces:
            return {}

        model_kinds = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Model",
                Kind.name.in_(user_names),
                Kind.namespace.in_(user_namespaces),
                Kind.is_active,
            )
            .all()
        )
        return {
            (str(model_kind.name), str(model_kind.namespace)): model_kind
            for model_kind in model_kinds
        }

    def _load_public_model_kinds(
        self,
        *,
        db: Session,
        model_refs: list[dict[str, str | None]],
    ) -> dict[str, Kind]:
        """Batch-load public models for candidate refs."""
        public_names = {str(model_ref["name"]) for model_ref in model_refs}
        if not public_names:
            return {}

        model_kinds = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name.in_(public_names),
                Kind.namespace == "default",
                Kind.is_active,
            )
            .all()
        )
        return {str(model_kind.name): model_kind for model_kind in model_kinds}

    def _batch_lookup_summary_model_kinds(
        self,
        *,
        db: Session,
        summary_model_refs: list[dict[str, str | None]],
        user_id: int | None,
    ) -> dict[tuple[str, str, str | None], tuple[Kind, str]]:
        """Resolve candidate summary models with batched scope queries."""
        user_model_kinds = self._load_user_model_kinds(
            db=db,
            user_id=user_id,
            model_refs=summary_model_refs,
        )
        public_model_kinds = self._load_public_model_kinds(
            db=db,
            model_refs=summary_model_refs,
        )

        resolved: dict[tuple[str, str, str | None], tuple[Kind, str]] = {}
        for model_ref in summary_model_refs:
            model_name = str(model_ref["name"])
            model_namespace = str(model_ref["namespace"])
            model_type = model_ref.get("type")
            ref_key = (model_name, model_namespace, model_type)

            if model_type == "public":
                public_kind = public_model_kinds.get(model_name)
                if public_kind is not None:
                    resolved[ref_key] = (public_kind, "public")
                continue

            user_kind = user_model_kinds.get((model_name, model_namespace))
            if user_kind is not None and model_type in {"user", "group"}:
                resolved[ref_key] = (user_kind, model_type)
                continue
            if user_kind is not None and user_id is not None:
                normalized_type = "user" if model_namespace == "default" else "group"
                resolved[ref_key] = (user_kind, normalized_type)
                continue

            public_kind = public_model_kinds.get(model_name)
            if public_kind is not None:
                resolved[ref_key] = (public_kind, "public")

        return resolved

    def _get_user_scoped_model_kind(
        self,
        *,
        db: Session,
        model_name: str,
        model_namespace: str,
        user_id: int | None,
    ) -> Optional[Kind]:
        """Load a user-visible model Kind for the given namespace."""
        if user_id is None:
            return None

        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == model_namespace,
                Kind.is_active,
            )
            .first()
        )

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
                    Kind.is_active,
                )
                .first()
            )
            if model_kind:
                return model_kind, "public"
            return None, None

        user_kind: Optional[Kind] = None
        if user_id is not None:
            user_kind = self._get_user_scoped_model_kind(
                db=db,
                model_name=model_name,
                model_namespace=model_namespace,
                user_id=user_id,
            )
            if user_kind:
                if model_type in {"user", "group"}:
                    return user_kind, model_type
                normalized_type = "user" if model_namespace == "default" else "group"
                return user_kind, normalized_type

        public_kind = (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == "Model",
                Kind.name == model_name,
                Kind.namespace == "default",
                Kind.is_active,
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
        processed_config["model_name"] = model_name
        processed_config["model_namespace"] = model_namespace
        processed_config["model_type"] = model_type
        return processed_config


protected_model_resolver = ProtectedModelResolver()

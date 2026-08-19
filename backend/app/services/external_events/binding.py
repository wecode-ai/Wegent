# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""External event binding rows: the routing index between events and cards."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import ExternalEventBinding, loop_datetime_is_unset


class ExternalEventBindingService:
    def create(
        self,
        db: Session,
        *,
        provider: str,
        opaque_ref: str,
        cloud_project_id: str,
        loop_item_id: str,
        issue_item_id: str,
        workflow_node_id: str,
        automation_run_id: str,
        created_by_user_id: int,
    ) -> ExternalEventBinding:
        """Register one (provider, opaque reference) for a waiting task."""

        provider = provider.strip()
        opaque_ref = opaque_ref.strip()
        if not provider or not opaque_ref:
            raise ValueError("provider and opaque_ref are required")
        existing = self._active(
            db,
            provider=provider,
            opaque_ref=opaque_ref,
            loop_item_id=loop_item_id,
            workflow_node_id=workflow_node_id,
        )
        if existing is not None:
            return existing
        row = ExternalEventBinding(
            cloud_project_id=cloud_project_id,
            loop_item_id=loop_item_id,
            provider=provider,
            opaque_ref=opaque_ref,
            created_by_user_id=created_by_user_id,
            metadata_json={
                "issue_item_id": issue_item_id,
                "workflow_node_id": workflow_node_id,
                "automation_run_id": automation_run_id,
            },
        )
        db.add(row)
        db.flush()
        return row

    def route(
        self,
        db: Session,
        *,
        provider: str,
        opaque_ref: str,
    ) -> list[ExternalEventBinding]:
        """Return every active binding matching one provider reference."""

        return (
            db.query(ExternalEventBinding)
            .filter(
                ExternalEventBinding.provider == provider,
                ExternalEventBinding.opaque_ref == opaque_ref,
                loop_datetime_is_unset(ExternalEventBinding.deleted_at),
            )
            .all()
        )

    def for_execution(
        self,
        db: Session,
        *,
        loop_item_id: str,
        automation_run_id: str,
    ) -> list[ExternalEventBinding]:
        """Return active bindings whose registered task uses one run."""

        return (
            db.query(ExternalEventBinding)
            .filter(
                ExternalEventBinding.loop_item_id == loop_item_id,
                ExternalEventBinding.metadata_json["automation_run_id"].as_string()
                == automation_run_id,
                loop_datetime_is_unset(ExternalEventBinding.deleted_at),
            )
            .all()
        )

    def archive(self, db: Session, binding: ExternalEventBinding) -> None:
        """Soft-delete one binding row."""

        binding.deleted_at = datetime.now(timezone.utc)
        db.flush()

    @staticmethod
    def _active(
        db: Session,
        *,
        provider: str,
        opaque_ref: str,
        loop_item_id: str,
        workflow_node_id: str,
    ) -> ExternalEventBinding | None:
        return (
            db.query(ExternalEventBinding)
            .filter(
                ExternalEventBinding.provider == provider,
                ExternalEventBinding.opaque_ref == opaque_ref,
                ExternalEventBinding.loop_item_id == loop_item_id,
                ExternalEventBinding.metadata_json["workflow_node_id"].as_string()
                == workflow_node_id,
                loop_datetime_is_unset(ExternalEventBinding.deleted_at),
            )
            .first()
        )

    @staticmethod
    def metadata(binding: ExternalEventBinding) -> dict[str, Any]:
        value = binding.metadata_json
        return value if isinstance(value, dict) else {}


external_event_binding_service = ExternalEventBindingService()

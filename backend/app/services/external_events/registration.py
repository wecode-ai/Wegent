# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Register external references for waiting workflow nodes."""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.schemas.base_role import BaseRole
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.external_events.binding import external_event_binding_service
from app.services.external_events.evaluate import external_event_evaluation_service
from app.services.project_workflow_projection import update_workflow_node


class ExternalEventRegistrationService:
    def register(
        self,
        db: Session,
        *,
        user_id: int,
        cloud_project_id: str,
        loop_item_id: str,
        provider: str,
        opaque_ref: str,
        automation_run_id: str,
    ) -> dict[str, Any]:
        """Bind one provider reference to a waiting workflow node.

        Only a task that is executing a preset workflow with a wait node may
        register. The provider and opaque reference are opaque to Wegent; the
        wait node rules decide which event types end the wait or rerun the
        task.
        """

        provider = provider.strip()
        opaque_ref = opaque_ref.strip()
        if not provider or not opaque_ref:
            raise ValueError("provider and opaque_ref are required")
        if not automation_run_id:
            raise ValueError(
                "External references require a workflow automation execution"
            )
        require_cloud_project_role(
            db, int(cloud_project_id), user_id, BaseRole.Reporter
        )
        item = db.get(LoopItem, loop_item_id)
        if item is None or str(item.cloud_project_id) != cloud_project_id:
            raise ValueError("Board item not found in this space")
        issue = item
        if item.parent_id:
            parent = db.get(LoopItem, item.parent_id)
            if parent is not None and str(parent.cloud_project_id) == cloud_project_id:
                issue = parent
        metadata = issue.metadata_json if isinstance(issue.metadata_json, dict) else {}
        workflow = metadata.get("workflow")
        nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        wait_node = next(
            (
                candidate
                for candidate in nodes or []
                if isinstance(candidate, dict)
                and candidate.get("node_type") == "wait"
                and candidate.get("status") in {"ready", "waiting"}
            ),
            None,
        )
        if wait_node is None:
            raise ValueError(
                "This task is not bound to a ready wait node in a preset workflow"
            )
        binding = external_event_binding_service.create(
            db,
            provider=provider,
            opaque_ref=opaque_ref,
            cloud_project_id=cloud_project_id,
            loop_item_id=item.id,
            issue_item_id=issue.id,
            workflow_node_id=str(wait_node.get("id")),
            automation_run_id=automation_run_id,
            created_by_user_id=user_id,
        )
        if wait_node.get("status") == "ready":
            update_workflow_node(
                db,
                item_id=issue.id,
                node_id=str(wait_node.get("id")),
                node_status="waiting",
            )
        db.flush()
        compensated = external_event_evaluation_service.compensate(db, binding=binding)
        db.commit()
        return {
            "binding_id": str(binding.id),
            "provider": provider,
            "opaque_ref": opaque_ref,
            "task_id": item.id,
            "issue_id": issue.id,
            "workflow_node_id": str(wait_node.get("id")),
            "compensated_event_count": compensated,
        }


external_event_registration_service = ExternalEventRegistrationService()

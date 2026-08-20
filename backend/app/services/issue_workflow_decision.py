# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Human approval decisions for Issue workflow stages."""

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem, LoopItemTaskBinding, loop_datetime_is_unset
from app.schemas.base_role import BaseRole
from app.schemas.issue_workflow import WorkflowNodeDecisionRequest
from app.services.delivery.access import require_loop_item_access
from app.services.project_workflow_projection import (
    apply_workflow_nodes,
    reconcile_workflow_task_nodes,
)
from app.services.workflow_deliverables import missing_requirement_ids


class IssueWorkflowDecisionService:
    def decide(
        self,
        db: Session,
        *,
        item_id: str,
        workflow_node_id: str,
        values: WorkflowNodeDecisionRequest,
        user_id: int,
    ) -> LoopItem:
        require_loop_item_access(db, item_id, user_id, BaseRole.Developer)
        item = (
            db.query(LoopItem).filter(LoopItem.id == item_id).with_for_update().first()
        )
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        metadata = dict(item.metadata_json or {})
        workflow = metadata.get("workflow")
        raw_nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        if not isinstance(raw_nodes, list):
            raise HTTPException(status.HTTP_409_CONFLICT, "Issue has no workflow")
        bindings = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .order_by(
                LoopItemTaskBinding.linked_at.desc(),
                LoopItemTaskBinding.id.desc(),
            )
            .all()
        )
        nodes = reconcile_workflow_task_nodes(
            db,
            [dict(node) for node in raw_nodes if isinstance(node, dict)],
            bindings,
        )
        node = next(
            (
                candidate
                for candidate in nodes
                if candidate.get("id") == workflow_node_id
            ),
            None,
        )
        if node is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow node not found")
        if node.get("automation_rule_id"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Automated workflow stages do not accept human decisions",
            )

        self._validate_decision(db, node, values)
        node["status"] = {
            "approve": "completed",
            "reject": "changes_requested",
            "force_advance": "forced_completed",
        }[values.action]
        history = list(node.get("decision_history") or [])
        history.append(
            {
                "action": values.action,
                "actor_user_id": user_id,
                "reason": values.reason,
                "decided_at": datetime.now(timezone.utc).isoformat(),
            }
        )
        node["decision_history"] = history
        apply_workflow_nodes(
            item,
            workflow=workflow,
            nodes=nodes,
            actor_user_id=user_id,
        )
        db.commit()
        db.refresh(item)
        return item

    @staticmethod
    def _validate_decision(
        db: Session,
        node: dict,
        values: WorkflowNodeDecisionRequest,
    ) -> None:
        node_status = node.get("status")
        if values.action == "approve":
            if node_status != "awaiting_approval":
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Workflow node is not awaiting approval",
                )
            if missing_requirement_ids(db, node):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Required workflow deliverables are missing",
                )
            return
        if values.action == "reject":
            if node_status != "awaiting_approval":
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Workflow node is not awaiting approval",
                )
            return
        if node_status in {"blocked", "completed", "forced_completed"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Workflow node cannot be force-advanced",
            )


issue_workflow_decision_service = IssueWorkflowDecisionService()

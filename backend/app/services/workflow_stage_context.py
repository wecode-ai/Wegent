# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Read workflow stage context on demand from its authoritative records."""

import logging
from datetime import timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.cloud_project import LoopItemTaskBinding
from app.models.delivery import Delivery, LoopItem, loop_datetime_is_unset
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.delivery.service import delivery_service
from app.services.delivery.storage import DeliveryObjectNotFoundError
from app.services.workflow_deliverables import delivery_fulfillments

DEFAULT_DEPENDENCY_CONTEXT = ["final_result", "deliveries"]
COMPLETED_NODE_STATUSES = {"completed", "forced_completed"}
logger = logging.getLogger(__name__)


def _iso(value: object) -> str | None:
    if value is None or not hasattr(value, "isoformat"):
        return None
    timezone_value = value
    if getattr(timezone_value, "tzinfo", None) is None:
        timezone_value = timezone_value.replace(tzinfo=timezone.utc)
    return timezone_value.isoformat()


class WorkflowStageContextResolver:
    def resolve(
        self,
        db: Session,
        *,
        item: LoopItem,
        target_node_id: str,
    ) -> dict[str, Any]:
        workflow = self._workflow(item)
        nodes = {
            str(node.get("id")): dict(node)
            for node in workflow["nodes"]
            if isinstance(node, dict) and node.get("id")
        }
        target = nodes.get(target_node_id)
        if target is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow node not found")

        dependencies = []
        dependency_context = target.get("dependency_context") or {}
        for dependency_id in target.get("depends_on") or []:
            dependency = nodes.get(str(dependency_id))
            if dependency is None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Workflow dependency does not exist",
                )
            selected = dependency_context.get(
                str(dependency_id),
                DEFAULT_DEPENDENCY_CONTEXT,
            )
            bindings = self._bindings(db, item.id, str(dependency_id))
            messages = self._messages(db, bindings)
            value: dict[str, Any] = {
                "stage_id": str(dependency_id),
                "stage_name": str(dependency.get("name") or dependency_id),
                "selected_sources": list(selected),
                "runtime_tasks": [
                    {
                        "device_id": self._workspace_device_id(db, binding),
                        "task_id": binding.task_id,
                        "task_title": binding.task_title or binding.task_id,
                    }
                    for binding in bindings
                    if binding.device_id and binding.task_id
                ],
            }
            if "final_result" in selected:
                value["final_results"] = self._final_results(bindings, messages)
            if "deliveries" in selected:
                value["deliveries"] = self._deliveries(db, dependency)
            if "activity" in selected:
                value["activity"] = self._activity(messages)
            dependencies.append(value)

        # Workspace "inherit" needs a concrete predecessor Runtime task. Direct
        # DAG dependencies are control nodes (for example a loop branch) that
        # never ran, so search outward through the workflow for the most recent
        # executed task and inherit its workspace instead.
        has_runtime_task = any(
            isinstance(dependency.get("runtime_tasks"), list)
            and dependency.get("runtime_tasks")
            for dependency in dependencies
        )
        if (
            str(target.get("workspace_policy") or "composer") == "inherit"
            and not has_runtime_task
        ):
            fallback = self._latest_executed_binding(db, item, nodes)
            if fallback is not None:
                dependencies.append(
                    {
                        "stage_id": str(fallback["node_id"]),
                        "stage_name": str(fallback["node_name"] or fallback["node_id"]),
                        "selected_sources": [],
                        "runtime_tasks": [
                            {
                                "device_id": self._workspace_device_id(
                                    db, fallback["binding"]
                                ),
                                "task_id": fallback["binding"].task_id,
                                "task_title": fallback["binding"].task_title
                                or fallback["binding"].task_id,
                            }
                        ],
                    }
                )

        snapshot = {
            "version": 1,
            "issue": {
                "id": item.id,
                "title": item.title or "",
                "description": item.description or "",
                "status": item.status or "",
            },
            "target_stage": {
                "id": target_node_id,
                "name": str(target.get("name") or target_node_id),
                "prompt": str(target.get("prompt") or ""),
                "required_deliverables": target.get("required_deliverables") or [],
                "workspace_policy": str(target.get("workspace_policy") or "composer"),
            },
            "dependencies": dependencies,
            "trigger_event": target.get("trigger_event"),
        }
        return snapshot

    @staticmethod
    def _latest_executed_binding(
        db: Session,
        item: LoopItem,
        nodes: dict[str, dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Return the newest completed task binding outside the target node."""

        bindings = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item.id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
                LoopItemTaskBinding.device_id.isnot(None),
                LoopItemTaskBinding.task_id.isnot(None),
            )
            .order_by(LoopItemTaskBinding.linked_at.desc())
            .all()
        )
        for binding in bindings:
            node_id = str(binding.workflow_node_id or "")
            node = nodes.get(node_id)
            if node is None or node.get("node_type") != "task":
                continue
            if node.get("status") not in COMPLETED_NODE_STATUSES:
                continue
            return {
                "binding": binding,
                "node_id": node_id,
                "node_name": str(node.get("name") or ""),
            }
        return None

    @staticmethod
    def _workspace_device_id(
        db: Session,
        binding: LoopItemTaskBinding,
    ) -> str:
        # The workspace of a predecessor task lives on the device that actually
        # owns its Runtime task. Logical queue devices such as "local-device"
        # must not be used here or the executor rejects the inherited workspace
        # as belonging to another device.
        if binding.device_id:
            return binding.device_id
        execution = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.runtime_task_id == binding.task_id,
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if execution is not None and execution.runtime_device_id:
            return execution.runtime_device_id
        return ""

    @staticmethod
    def _workflow(item: LoopItem) -> dict[str, Any]:
        metadata = item.metadata_json if isinstance(item.metadata_json, dict) else {}
        workflow = metadata.get("workflow")
        if not isinstance(workflow, dict) or not isinstance(
            workflow.get("nodes"), list
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Issue has no workflow")
        return workflow

    @staticmethod
    def _bindings(
        db: Session,
        item_id: str,
        workflow_node_id: str,
    ) -> list[LoopItemTaskBinding]:
        rows = (
            db.query(LoopItemTaskBinding)
            .filter(
                LoopItemTaskBinding.loop_item_id == item_id,
                loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
            )
            .order_by(LoopItemTaskBinding.linked_at.asc())
            .all()
        )
        return [row for row in rows if row.workflow_node_id == workflow_node_id]

    @staticmethod
    def _messages(
        db: Session,
        bindings: list[LoopItemTaskBinding],
    ) -> list[ProjectChatMessage]:
        addresses = [
            (binding.device_id, binding.task_id)
            for binding in bindings
            if binding.device_id and binding.task_id
        ]
        if not addresses:
            return []
        filters = [
            (
                ProjectChatMessage.runtime_device_id == device_id,
                ProjectChatMessage.runtime_task_id == task_id,
            )
            for device_id, task_id in addresses
        ]
        return (
            db.query(ProjectChatMessage)
            .filter(
                or_(*[left & right for left, right in filters]),
                loop_datetime_is_unset(ProjectChatMessage.deleted_at),
            )
            .order_by(ProjectChatMessage.id.asc())
            .limit(500)
            .all()
        )

    @staticmethod
    def _final_results(
        bindings: list[LoopItemTaskBinding],
        messages: list[ProjectChatMessage],
    ) -> list[dict[str, Any]]:
        latest_by_address: dict[tuple[str, str], ProjectChatMessage] = {}
        for message in messages:
            if message.status == "completed" and message.content.strip():
                latest_by_address[
                    (message.runtime_device_id, message.runtime_task_id)
                ] = message
        return [
            {
                "task_binding_id": str(binding.id),
                "task_title": binding.task_title or binding.task_id,
                "device_id": binding.device_id,
                "task_id": binding.task_id,
                "content": latest_by_address[address].content,
                "completed_at": _iso(latest_by_address[address].updated_at),
            }
            for binding in bindings
            if (address := (binding.device_id, binding.task_id)) in latest_by_address
        ]

    @staticmethod
    def _deliveries(db: Session, node: dict[str, Any]) -> list[dict[str, Any]]:
        delivery_ids = [
            str(value)
            for value in node.get("delivery_ids") or []
            if isinstance(value, str) and value
        ]
        if not delivery_ids:
            return []
        rows = (
            db.query(Delivery)
            .filter(Delivery.id.in_(delivery_ids), Delivery.status == "delivered")
            .order_by(Delivery.delivered_at.asc())
            .all()
        )
        deliveries = []
        for row in rows:
            content_available = True
            try:
                markdown = delivery_service.read_markdown(row)
            except DeliveryObjectNotFoundError:
                content_available = False
                markdown = ""
                logger.warning(
                    "Workflow dependency delivery content is missing: delivery_id=%s object_key=%s",
                    row.id,
                    row.markdown_object_key,
                )
            deliveries.append(
                {
                    "id": row.id,
                    "markdown": markdown,
                    "content_available": content_available,
                    "delivered_at": _iso(row.delivered_at),
                    "fulfillments": delivery_fulfillments(row),
                    "assets": [
                        {
                            "id": asset.id,
                            "display_name": asset.display_name,
                            "relative_path": asset.relative_path,
                            "content_type": asset.content_type or None,
                            "size_bytes": int(asset.size_bytes or 0),
                            "sha256": asset.sha256,
                        }
                        for asset in delivery_service.list_assets(db, row.id)
                    ],
                }
            )
        return deliveries

    @staticmethod
    def _activity(messages: list[ProjectChatMessage]) -> list[dict[str, Any]]:
        return [
            {
                "message_id": message.message_id,
                "status": message.status,
                "content": message.content,
                "created_at": _iso(message.created_at),
            }
            for message in messages[-50:]
            if message.content.strip()
        ]


workflow_stage_context_resolver = WorkflowStageContextResolver()

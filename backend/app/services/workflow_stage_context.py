# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Resolve immutable inputs for one workflow stage."""

import hashlib
import json
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
logger = logging.getLogger(__name__)


def _json_block(value: object) -> str:
    return f"```json\n{json.dumps(value, ensure_ascii=False, indent=2)}\n```"


def _upstream_final_results(dependencies: list[dict[str, Any]]) -> str:
    stages = []
    for dependency in dependencies:
        results = dependency.get("final_results")
        if not isinstance(results, list) or not results:
            continue
        stage_name = str(
            dependency.get("stage_name") or dependency.get("stage_id") or ""
        )
        stage_id = str(dependency.get("stage_id") or "")
        stages.append(f"### {stage_name} (`{stage_id}`)\n\n{_json_block(results)}")
    if not stages:
        return ""
    return "## 上游最终结果\n\n" + "\n\n".join(stages)


def _upstream_deliveries(dependencies: list[dict[str, Any]]) -> str:
    stages = []
    for dependency in dependencies:
        deliveries = dependency.get("deliveries")
        if not isinstance(deliveries, list) or not deliveries:
            continue
        stage_name = str(
            dependency.get("stage_name") or dependency.get("stage_id") or ""
        )
        stage_id = str(dependency.get("stage_id") or "")
        stages.append(f"### {stage_name} (`{stage_id}`)\n\n{_json_block(deliveries)}")
    if not stages:
        return ""
    return "## 上游已交付内容\n\n" + "\n\n".join(stages)


def _upstream_activity(dependencies: list[dict[str, Any]]) -> str:
    stages = []
    for dependency in dependencies:
        activity = dependency.get("activity")
        if not isinstance(activity, list) or not activity:
            continue
        stage_name = str(
            dependency.get("stage_name") or dependency.get("stage_id") or ""
        )
        stage_id = str(dependency.get("stage_id") or "")
        stages.append(f"### {stage_name} (`{stage_id}`)\n\n{_json_block(activity)}")
    if not stages:
        return ""
    return "## 上游执行过程\n\n" + "\n\n".join(stages)


def _deliverable_requirement_line(requirement: dict[str, Any]) -> str:
    requirement_id = str(requirement.get("id") or "")
    name = str(requirement.get("name") or "")
    value_type = str(requirement.get("value_type") or "")
    description = str(requirement.get("description") or "").strip()
    details = [f"- [{requirement_id}] {name} ({value_type})"]
    if description:
        details.append(f"  - 要求：{description}")
    constraints = requirement.get("file_constraints")
    if isinstance(constraints, dict):
        accepted_types = constraints.get("accepted_types")
        if isinstance(accepted_types, list) and accepted_types:
            details.append(
                "  - 允许类型：" + "、".join(str(value) for value in accepted_types)
            )
        details.append(
            "  - 文件数量："
            f"{int(constraints.get('min_files') or 1)}–"
            f"{int(constraints.get('max_files') or 1)}"
        )
    return "\n".join(details)


def workflow_stage_task_instruction(stage_input: dict[str, Any]) -> str:
    """Compile the concrete task instruction shared by every stage launcher."""

    target = stage_input.get("target_stage")
    if not isinstance(target, dict):
        return ""
    sections = []
    issue = stage_input.get("issue")
    if isinstance(issue, dict):
        issue_id = str(issue.get("id") or "")
        issue_title = str(issue.get("title") or "")
        stage_id = str(target.get("id") or "")
        stage_name = str(target.get("name") or "")
        positioning = [
            "## 任务定位",
            "",
            f"- Issue：{issue_title} (`{issue_id}`)",
            f"- 当前节点：{stage_name} (`{stage_id}`)",
        ]
        issue_description = str(issue.get("description") or "").strip()
        if issue_description:
            positioning.extend(["", "### Issue 描述", "", issue_description])
        sections.append("\n".join(positioning))
    prompt = str(target.get("prompt") or "").strip()
    if prompt:
        sections.append(f"## 当前节点任务\n\n{prompt}")
    dependencies = stage_input.get("dependencies")
    normalized_dependencies = (
        [value for value in dependencies if isinstance(value, dict)]
        if isinstance(dependencies, list)
        else []
    )
    sections.extend(
        section
        for section in (
            _upstream_final_results(normalized_dependencies),
            _upstream_deliveries(normalized_dependencies),
            _upstream_activity(normalized_dependencies),
        )
        if section
    )
    requirements = target.get("required_deliverables")
    if isinstance(requirements, list) and requirements:
        normalized_requirements = [
            value for value in requirements if isinstance(value, dict)
        ]
        sections.append(
            "## 当前节点交付要求\n\n"
            + "\n".join(
                _deliverable_requirement_line(requirement)
                for requirement in normalized_requirements
            )
        )
        sections.append(
            "## 提交约束\n\n"
            "完成任务后，必须通过 Issue 交付工具逐项提交上述交付物。\n"
            "上传文件后，调用 finalize_delivery 时必须传入 fulfillments，"
            "并让每个实际结果绑定对应 requirement_id。\n"
            "仅创建 Delivery、上传资产或提交空 fulfillments 都不算完成。\n"
            "提交后等待流程状态更新，不要自行宣称已经进入下一阶段。"
        )
    return "\n\n".join(section for section in sections if section)


def compiled_workflow_stage_input(stage_input: dict[str, Any]) -> dict[str, Any]:
    """Attach the canonical task instruction to one workflow stage snapshot."""

    return {
        **stage_input,
        "compiled_task_instruction": workflow_stage_task_instruction(stage_input),
    }


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
        }
        encoded = json.dumps(
            snapshot,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        snapshot["sha256"] = hashlib.sha256(encoded).hexdigest()
        return compiled_workflow_stage_input(snapshot)

    @staticmethod
    def _workspace_device_id(
        db: Session,
        binding: LoopItemTaskBinding,
    ) -> str:
        metadata = (
            binding.metadata_json if isinstance(binding.metadata_json, dict) else {}
        )
        persisted = metadata.get("workspace_device_id")
        if isinstance(persisted, str) and persisted:
            return persisted
        execution = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.runtime_device_id == binding.device_id,
                LoopItemExecution.runtime_task_id == binding.task_id,
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if execution is not None and execution.execution_device_id:
            return execution.execution_device_id
        return binding.device_id

    @staticmethod
    def freeze_binding(
        binding: LoopItemTaskBinding,
        snapshot: dict[str, Any],
    ) -> None:
        binding.metadata_json = {
            **(
                binding.metadata_json if isinstance(binding.metadata_json, dict) else {}
            ),
            "workflow_stage_input": snapshot,
            "workflow_stage_input_sha256": snapshot["sha256"],
        }

    @staticmethod
    def binding_snapshot(binding: LoopItemTaskBinding) -> dict[str, Any] | None:
        metadata = (
            binding.metadata_json if isinstance(binding.metadata_json, dict) else {}
        )
        snapshot = metadata.get("workflow_stage_input")
        return (
            compiled_workflow_stage_input(snapshot)
            if isinstance(snapshot, dict)
            else None
        )

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

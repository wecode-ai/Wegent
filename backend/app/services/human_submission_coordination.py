# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Forward committed human child-task submissions to the owning Executor."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.services.device.runtime_route import RuntimeRouteError, runtime_route_resolver
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

COORDINATION_FACT_EVENT = "device:coordination_fact"
LOCAL_EXECUTOR_NAMESPACE = "/local-executor"
_INACTIVE_EXECUTION_STATUSES = frozenset({"failed", "cancelled"})


@dataclass(frozen=True)
class ManagerExecutionTarget:
    """The Executor device that owns coordination for one child Issue."""

    owner_user_id: int
    device_id: str


class HumanSubmissionCoordinationService:
    """Publish business facts without owning coordination state or decisions."""

    @trace_async(
        span_name="human_submission_coordination.publish",
        tracer_name="backend",
        extract_attributes=lambda self, db, **kwargs: {
            "item.id": str(kwargs["item"].id),
            "submission.id": str(kwargs["message"].message_id),
        },
    )
    async def publish(
        self,
        db: Session,
        *,
        item: LoopItem,
        message: ProjectChatMessage,
    ) -> bool:
        """Send one committed ``human_submitted`` fact to the manager Executor."""

        target = self._manager_target(db, item)
        if target is None:
            return False
        try:
            route = await runtime_route_resolver.resolve(
                user_id=target.owner_user_id,
                submitted_device_id=target.device_id,
            )
            from app.core.socketio import get_sio

            await get_sio().emit(
                COORDINATION_FACT_EVENT,
                {
                    "factType": "human_submitted",
                    "itemId": item.id,
                    "submissionId": message.message_id,
                    "summary": message.content,
                },
                to=route.socket_id,
                namespace=LOCAL_EXECUTOR_NAMESPACE,
            )
        except RuntimeRouteError as exc:
            logger.info(
                "Human submission fact has no active manager route: "
                "item_id=%s code=%s",
                item.id,
                exc.code,
            )
            return False
        except Exception:
            logger.exception(
                "Human submission fact delivery failed: item_id=%s", item.id
            )
            return False
        return True

    def _manager_target(
        self,
        db: Session,
        item: LoopItem,
    ) -> ManagerExecutionTarget | None:
        for ancestor_id in self._ancestor_ids(db, item):
            executions = (
                db.query(LoopItemExecution)
                .filter(
                    LoopItemExecution.loop_item_id == ancestor_id,
                    LoopItemExecution.cloud_project_id == str(item.cloud_project_id),
                )
                .order_by(LoopItemExecution.id.desc())
                .all()
            )
            for execution in executions:
                context = execution.runtime_origin_context
                if context.get("dispatch_role") != "manager" or not context.get(
                    "collaboration_group_id"
                ):
                    continue
                if execution.status in _INACTIVE_EXECUTION_STATUSES:
                    return None
                device_id = (
                    str(execution.runtime_device_id or "").strip()
                    or str(execution.execution_device_id or "").strip()
                )
                if not device_id or not execution.executor_owner_user_id:
                    return None
                return ManagerExecutionTarget(
                    owner_user_id=int(execution.executor_owner_user_id),
                    device_id=device_id,
                )
        return None

    @staticmethod
    def _ancestor_ids(db: Session, item: LoopItem) -> list[str]:
        ancestor_ids: list[str] = []
        seen = {str(item.id)}
        parent_id = str(item.parent_id or "").strip()
        while parent_id and parent_id not in seen:
            seen.add(parent_id)
            parent = db.get(LoopItem, parent_id)
            if parent is None or str(parent.cloud_project_id) != str(
                item.cloud_project_id
            ):
                break
            ancestor_ids.append(parent_id)
            parent_id = str(parent.parent_id or "").strip()
        return ancestor_ids


human_submission_coordination_service = HumanSubmissionCoordinationService()

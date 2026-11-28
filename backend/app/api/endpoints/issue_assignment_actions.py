# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from typing import Literal

from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

from app.models.delivery import LoopItem
from app.schemas.delivery import LoopItemResponse, LoopItemUpdate
from app.schemas.project_chat import LoopItemAssign
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service


def direct_assignment(
    values: LoopItemUpdate, *, notify_self: bool = True
) -> LoopItemAssign | None:
    """A single selected assignee with no accompanying Issue edits."""
    fields: dict[str, Literal["user", "agent", "team"]] = {
        "assignee_user_id": "user",
        "assignee_agent_id": "agent",
        "assignee_team_id": "team",
    }
    if (
        values.model_fields_set
        - fields.keys()
        - {
            "version",
            "notify_assignee",
            "runner_selection",
            "redeliver",
        }
    ):
        return None
    for field, kind in fields.items():
        target = getattr(values, field)
        if target:
            return LoopItemAssign(
                version=values.version,
                assignee_type=kind,
                assignee_id=str(target),
                notify_assignee=values.notify_assignee,
                notify_self=notify_self,
                redeliver=values.redeliver,
                runner_selection=values.runner_selection,
            )
    return None


def assign_project_issue(
    db: Session,
    *,
    item_id: str,
    user_id: int,
    values: LoopItemAssign,
    background_tasks: BackgroundTasks,
    project_id: int | None = None,
    source: LoopItem | None = None,
) -> LoopItemResponse:
    from app.tasks.robot_queue_tasks import consume_queues_background

    if external_loop_item_provider.is_external_item(db, item_id):
        response = external_loop_item_provider.assign(db, item_id, user_id, values)
        background_tasks.add_task(consume_queues_background)
        return LoopItemResponse.model_validate(response)
    source = (
        source if source is not None else loop_item_service.get(db, item_id, user_id)
    )
    access = loop_item_service._require_item_access(db, source, user_id)
    previous_assignee = source.assignee_user_id
    item = loop_item_service.assign(
        db,
        project_id=(
            project_id if project_id is not None else int(source.cloud_project_id)
        ),
        item_id=item_id,
        user_id=user_id,
        values=values,
    )
    background_tasks.add_task(consume_queues_background)
    if values.redeliver or previous_assignee != item.assignee_user_id:
        from app.services.wework_notifications import emit_issue_assignments_changed

        for assignee in sorted({previous_assignee, item.assignee_user_id} - {None, 0}):
            background_tasks.add_task(emit_issue_assignments_changed, assignee)
    publish_loop_item_changed(db, item=item, reason="assignment", actor_user_id=user_id)
    return LoopItemResponse.model_validate(
        loop_item_service.response_values(db, item, user_id, access=access)
    )

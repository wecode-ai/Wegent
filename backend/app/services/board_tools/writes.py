"""Atomic domain mutations and durable receipts in the unified node store."""

from __future__ import annotations

import copy
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.mcp_server.auth import MCPAuthInfo
from app.models.delivery import LoopNode
from app.schemas.delivery import LoopItemCreate, LoopItemUpdate
from app.schemas.project_chat import LoopItemAssign, ProjectChatSend
from app.services.project_chat.issue_comments import _comment_view
from app.services.project_chat.service import project_chat_service
from shared.telemetry.decorators import trace_sync

from . import access
from .protocol import counts, digest, error_result, failure

logger = logging.getLogger(__name__)


def _check(
    db: Session, token: MCPAuthInfo, name: str, entry: dict[str, Any]
) -> tuple[Any, dict[str, Any] | None]:
    from app.mcp_server.tools import wework_space as single

    creating = name == "batch_create_board_items"
    space = entry["space"] if creating else entry["target"]["space"]
    action = {
        "batch_update_board_items": "update_board_item",
        "batch_assign_board_items": "assign_board_item",
        "batch_add_board_item_comments": "add_board_item_comment",
        "batch_create_board_items": "create_board_item",
    }[name]
    project = access.project(
        db,
        token,
        space,
        item_id=None if creating else entry["target"]["item_id"],
        action=action,
    )
    single.require_cloud_project_role(
        db, int(project.id), token.user_id, single.BaseRole.Developer
    )
    if project.task_provider in {"github", "gitlab"}:
        raise failure(
            "unsupported_operation",
            "This source does not provide atomic batch mutation receipts",
        )
    if creating:
        return project, None
    current = single._read_item(db, project, entry["target"]["item_id"], token.user_id)
    permission = {
        "batch_update_board_items": "edit_content",
        "batch_assign_board_items": "assign",
        "batch_add_board_item_comments": "comment",
    }[name]
    if not current.get("permissions", {}).get(permission):
        raise HTTPException(404, "Target is unavailable")
    if "expected_version" in entry and current["version"] != entry["expected_version"]:
        raise failure("version_conflict", "Issue changed", 409)
    return project, current


def _patch(entry: dict[str, Any], current: dict[str, Any]) -> LoopItemUpdate:
    patch = copy.deepcopy(entry["patch"])
    tags = patch.get("tags")
    if tags is not None:
        patch["tags"] = tags.get(
            "replace",
            sorted(
                (set(current.get("tags") or []) | set(tags.get("add", [])))
                - set(tags.get("remove", []))
            ),
        )
    return LoopItemUpdate.model_validate(
        {**patch, "version": entry["expected_version"]}
    )


def _apply(
    db: Session,
    token: MCPAuthInfo,
    name: str,
    entry: dict[str, Any],
    project: Any,
    current: dict[str, Any] | None,
    key: str,
) -> dict[str, Any]:
    from app.mcp_server.tools import wework_space as single

    if name == "batch_create_board_items":
        values = LoopItemCreate.model_validate(entry["item"])
        created = single.loop_item_provider_router.create(
            db, project, single._user(db, token.user_id), values, commit=False
        )
        from app.services.project_automation_domain import ProjectAutomationEvent
        from app.services.project_incoming_hooks import project_incoming_hook_service

        response = single.LoopItemResponse.model_validate(created.values)
        project_incoming_hook_service.queue_internal(
            db,
            ProjectAutomationEvent(
                event_type="task.created",
                project_id=str(project.id),
                subject_id=str(created.values["id"]),
                source=project.task_provider,
                actor_user_id=token.user_id,
                payload=response.model_dump(mode="json"),
            ),
            automation_id=(
                response.workflow.ai_automation_rule_id
                if response.workflow and response.workflow.advancement_policy == "ai"
                else None
            ),
        )
        return single._read_item(db, project, str(created.values["id"]), token.user_id)
    item_id = entry["target"]["item_id"]
    if name == "batch_add_board_item_comments":
        request = ProjectChatSend(
            client_message_id=key,
            project_id=str(project.id),
            task_id=item_id,
            content=entry["body"],
            mentions=entry.get("mentions", []),
        )
        result = project_chat_service.send(
            db,
            user_id=token.user_id,
            user_name=token.user_name,
            request=request,
            commit=False,
        )
        return _comment_view(result.message)
    if name == "batch_assign_board_items":
        owner = entry["assignee"]
        values = LoopItemAssign(
            version=entry["expected_version"],
            assignee_type=owner["type"],
            assignee_id=owner["id"],
            notify_assignee=entry.get("notify_assignee", True),
            notify_self=True,
        )
        single.loop_item_service.assign(
            db,
            project_id=int(project.id),
            item_id=item_id,
            user_id=token.user_id,
            values=values,
            commit=False,
        )
    else:
        single.loop_item_service.update(
            db, item_id, token.user_id, _patch(entry, current or {}), commit=False
        )
    return single._read_item(db, project, item_id, token.user_id)


def _view(db: Session, token: MCPAuthInfo, row: LoopNode) -> dict[str, Any]:
    if row.created_by_user_id != token.user_id or row.metadata_json[
        "owner"
    ] != access.identity(db, token):
        raise HTTPException(404, "Operation not found")
    data = row.metadata_json
    if datetime.fromisoformat(data["expires_at"]) <= datetime.now(timezone.utc):
        row.metadata_json = {
            key: data[key] for key in ("owner", "payload", "expires_at")
        }
        row.status = "expired"
        db.commit()
        raise failure("operation_expired", "Operation receipt expired", 410)
    results = [
        _receipt_result(db, token, result) if result["state"] == "succeeded" else result
        for result in data["results"]
    ]
    return {
        "operation_id": row.id,
        "state": row.status,
        "counts": counts(results),
        "results": results,
        "expires_at": data["expires_at"],
    }


def _receipt_result(
    db: Session, token: MCPAuthInfo, result: dict[str, Any]
) -> dict[str, Any]:
    from app.mcp_server.tools import wework_space as single

    target = result["target"]
    project = access.project(db, token, target["space"], item_id=target["item_id"])
    try:
        single._read_item(db, project, target["item_id"], token.user_id)
    except HTTPException as error:
        if error.status_code not in (403, 404):
            raise
        # Redact only the response; the durable commit snapshot remains unchanged.
        return {
            "request_id": result["request_id"],
            "state": result["state"],
            "committed": result["committed"],
            "error": {
                "code": "result_unavailable",
                "message": "Committed result is unavailable under current access",
                "retryable": False,
            },
        }
    return result


def read(
    db: Session,
    token: MCPAuthInfo,
    operation_id: str | None = None,
    operation_key: str | None = None,
) -> dict[str, Any]:
    if operation_key is not None:
        operation_id = digest([access.identity(db, token), operation_key])
    row = (
        db.query(LoopNode)
        .filter(LoopNode.id == operation_id, LoopNode.kind == "board_operation")
        .one_or_none()
    )
    if row is None:
        raise HTTPException(404, "Operation not found")
    return _view(db, token, row)


def _publish(
    db: Session,
    token: MCPAuthInfo,
    name: str,
    entry: dict[str, Any],
    outcome: dict[str, Any],
) -> None:
    if name == "batch_add_board_item_comments":
        from app.models.project_chat_message import ProjectChatMessage
        from app.services.project_chat.push import push_project_chat_message

        row = (
            db.query(ProjectChatMessage)
            .filter(ProjectChatMessage.message_id == outcome["result"]["id"])
            .one()
        )
        message = project_chat_service.to_view(row, db=db)
        push_project_chat_message(message.model_dump(mode="json", by_alias=True))
    if name == "batch_assign_board_items" and entry["assignee"]["type"] == "agent":
        from app.models.delivery import ProjectChatAgent
        from app.services.loop_item_executions.wake import wake_robot_creator

        agent = db.get(ProjectChatAgent, entry["assignee"]["id"])
        if agent and agent.created_by_user_id:
            wake_robot_creator(
                user_id=agent.created_by_user_id,
                project_id=entry["target"]["space"]["space_id"],
                agent_id=agent.id,
            )


def _claim(
    db: Session, token: MCPAuthInfo, name: str, values: dict[str, Any]
) -> tuple[LoopNode, bool]:
    owner = access.identity(db, token)
    expired = (
        db.query(LoopNode)
        .filter(
            LoopNode.kind == "board_operation",
            LoopNode.created_by_user_id == token.user_id,
            LoopNode.status != "expired",
            LoopNode.created_at < datetime.now(timezone.utc) - timedelta(days=30),
        )
        .all()
    )
    for old in expired:
        old.metadata_json = {
            key: old.metadata_json[key] for key in ("owner", "payload", "expires_at")
        }
        old.status = "expired"
    key = digest([owner, values["operation_key"]])
    payload = digest([name, values])
    row = db.get(LoopNode, key)
    if row is not None:
        if row.kind != "board_operation" or row.metadata_json["payload"] != payload:
            raise failure(
                "idempotency_conflict", "Operation key has different content", 409
            )
        return row, False
    results = [
        {
            "request_id": entry["request_id"],
            "target": entry.get("target"),
            "state": "not_executed",
            "committed": False,
        }
        for entry in values["items"]
    ]
    row = LoopNode(
        id=key,
        kind="board_operation",
        status="running",
        created_by_user_id=token.user_id,
        metadata_json={
            "owner": owner,
            "payload": payload,
            "request": values,
            "results": results,
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        },
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return _claim(db, token, name, values)
    return row, True


@trace_sync("board_tools.write_batch", tracer_name="backend")
def execute(
    db: Session, token: MCPAuthInfo, name: str, values: dict[str, Any]
) -> dict[str, Any]:
    if values.get("preview"):
        results = []
        for entry in values["items"]:
            try:
                _, current = _check(db, token, name, entry)
                if name == "batch_update_board_items":
                    _patch(entry, current or {})
                results.append(
                    {
                        "request_id": entry["request_id"],
                        "state": "validated",
                        "committed": False,
                        "observed_version": current.get("version") if current else None,
                        "business_validation": "revalidated_at_commit",
                        "requested_change": entry,
                    }
                )
            except Exception as error:
                results.append(error_result(entry, error))
        return {"preview": True, "results": results}
    row, claimed = _claim(db, token, name, values)
    if not claimed:
        return _view(db, token, row)
    operation_id = row.id
    blocked = set()
    started = time.monotonic()
    for index, entry in enumerate(values["items"]):
        target_key = digest(entry.get("target", ["create", entry["request_id"]]))
        if target_key in blocked or time.monotonic() - started >= 35:
            continue
        row = (
            db.query(LoopNode)
            .filter(LoopNode.id == operation_id)
            .with_for_update()
            .one()
        )
        try:
            project, current = _check(db, token, name, entry)
            result = _apply(
                db,
                token,
                name,
                entry,
                project,
                current,
                digest([operation_id, entry["request_id"]]),
            )
            outcome = {
                "request_id": entry["request_id"],
                "target": entry.get("target")
                or {"space": entry["space"], "item_id": result["id"]},
                "state": "succeeded",
                "committed": True,
                "item_version": result.get("version"),
                "result": result,
            }
            metadata = copy.deepcopy(row.metadata_json)
            metadata["results"][index] = outcome
            row.metadata_json = metadata
            project_chat_service._commit(db)
        except Exception as error:
            db.rollback()
            row = (
                db.query(LoopNode)
                .filter(LoopNode.id == operation_id)
                .with_for_update()
                .one()
            )
            if row.metadata_json["results"][index]["state"] == "succeeded":
                # Publication can fail after the transaction has committed.
                logger.exception(
                    "Batch post-commit publication failed",
                    extra={"operation_id": operation_id},
                )
                continue
            blocked.add(target_key)
            metadata = copy.deepcopy(row.metadata_json)
            metadata["results"][index] = error_result(entry, error)
            row.metadata_json = metadata
            db.commit()
            continue
        try:
            _publish(db, token, name, entry, outcome)
        except Exception:
            logger.exception(
                "Batch notification publication failed",
                extra={"operation_id": operation_id},
            )
    row = db.get(LoopNode, operation_id)
    row.status = "completed"
    db.commit()
    return _view(db, token, row)

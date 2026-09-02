# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Worker-owned database projection for native runtime events."""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy.orm import Session

from app.services.chat.storage.db import get_db_session
from app.services.issue_workflow_start import issue_workflow_start_service
from app.services.loop_item_events import publish_loop_item_changed
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_chat.service import project_chat_service
from app.services.project_workflow_projection import update_workflow_task_status

logger = logging.getLogger(__name__)


def _execution_item_version(db: Session, execution: object) -> int | None:
    loop_item_id = getattr(execution, "loop_item_id", None)
    if not isinstance(loop_item_id, str) or not loop_item_id:
        return None
    from app.models.delivery import LoopItem

    item = db.get(LoopItem, loop_item_id)
    return int(item.version) if item is not None else None


def _publish_execution_item_change(
    db: Session,
    *,
    execution: object,
    previous_version: int | None,
) -> None:
    if previous_version is None:
        return
    loop_item_id = getattr(execution, "loop_item_id", None)
    if not isinstance(loop_item_id, str) or not loop_item_id:
        return
    from app.models.delivery import LoopItem

    item = db.get(LoopItem, loop_item_id, populate_existing=True)
    if item is None or item.version == previous_version:
        return
    publish_loop_item_changed(
        db,
        item=item,
        reason="runtime_execution_status",
        actor_user_id=int(getattr(execution, "executor_owner_user_id", 0) or 0),
    )


def _project_execution_workflow_status(
    db: Session,
    *,
    execution: object,
    projected_status: str,
    ready_before: set[str],
) -> dict[str, Any] | None:
    """Project accepted runtime truth onto its bound workflow task."""

    from app.models.delivery import LoopItemTaskBinding, loop_datetime_is_unset

    user_id = int(getattr(execution, "executor_owner_user_id", 0) or 0)
    device_id = str(getattr(execution, "runtime_device_id", "") or "")
    task_id = str(getattr(execution, "runtime_task_id", "") or "")
    loop_item_id = str(getattr(execution, "loop_item_id", "") or "")
    if not all((user_id, device_id, task_id, loop_item_id, projected_status)):
        return None

    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.loop_item_id == loop_item_id,
            LoopItemTaskBinding.task_user_id == user_id,
            LoopItemTaskBinding.device_id == device_id,
            LoopItemTaskBinding.task_id == task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .first()
    )
    if binding is None or not binding.workflow_node_id:
        return None

    from app.models.delivery import LoopItem

    item = update_workflow_task_status(
        db,
        user_id=user_id,
        device_id=device_id,
        task_id=task_id,
        execution_status=projected_status,
    )
    if item is None:
        return None
    newly_ready = (
        issue_workflow_start_service.ready_robot_stage_ids(item) - ready_before
    )
    logger.info(
        "[IssueWorkflowContinuation] detected item=%s execution=%s event_status=%s "
        "ready_before=%s newly_ready=%s",
        item.id,
        getattr(execution, "id", None),
        projected_status,
        sorted(ready_before),
        sorted(newly_ready),
    )
    return {
        "item_id": str(item.id),
        "user_id": user_id,
        "stage_ids": sorted(newly_ready),
    }


def _workflow_status_for_runtime_event(
    event_name: str,
    payload: dict[str, Any],
) -> str | None:
    data = payload.get("data")
    data = data if isinstance(data, dict) else {}
    terminal_status = project_chat_service._project_chat_terminal_status(
        event_name,
        payload,
        data,
    )
    if terminal_status == "completed":
        return "succeeded"
    if terminal_status in {"failed", "cancelled"}:
        return terminal_status
    if event_name in {
        "response.created",
        "runtime.task.started",
        "runtime.task.status",
    }:
        return "running"
    return None


def _execution_ready_robot_stage_ids(
    db: Session,
    execution: object | None,
) -> set[str]:
    if execution is None:
        return set()
    loop_item_id = getattr(execution, "loop_item_id", None)
    if not isinstance(loop_item_id, str) or not loop_item_id:
        return set()
    from app.models.delivery import LoopItem

    item = db.get(LoopItem, loop_item_id)
    if item is None:
        return set()
    return issue_workflow_start_service.ready_robot_stage_ids(item)


def _project_bound_runtime_event_status(
    db: Session,
    *,
    user_id: int,
    device_id: str,
    task_id: str,
    event_name: str,
    payload: dict[str, Any],
) -> dict[str, Any] | None:
    """Project a manually bound Runtime task that has no execution row."""

    from app.models.delivery import (
        LoopItem,
        LoopItemTaskBinding,
        loop_datetime_is_unset,
    )

    projected_status = _workflow_status_for_runtime_event(event_name, payload)
    if projected_status is None:
        return None
    binding = (
        db.query(LoopItemTaskBinding)
        .filter(
            LoopItemTaskBinding.task_user_id == user_id,
            LoopItemTaskBinding.device_id == device_id,
            LoopItemTaskBinding.task_id == task_id,
            loop_datetime_is_unset(LoopItemTaskBinding.unlinked_at),
        )
        .first()
    )
    if binding is None or not binding.loop_item_id:
        logger.info(
            "[IssueTaskRuntimeSync] binding_miss user=%s device=%s task=%s " "event=%s",
            user_id,
            device_id,
            task_id,
            event_name,
        )
        return None
    item_before = db.get(LoopItem, binding.loop_item_id)
    if item_before is None:
        logger.warning(
            "[IssueTaskRuntimeSync] item_miss user=%s device=%s task=%s "
            "binding=%s item=%s",
            user_id,
            device_id,
            task_id,
            binding.id,
            binding.loop_item_id,
        )
        return None
    if not binding.workflow_node_id:
        raw_event_seq = payload.get("eventSeq", payload.get("event_seq"))
        if isinstance(raw_event_seq, bool):
            raw_event_seq = None
        try:
            event_seq = int(raw_event_seq)
        except (TypeError, ValueError):
            event_seq = 0
        binding_metadata = (
            dict(binding.metadata_json)
            if isinstance(binding.metadata_json, dict)
            else {}
        )
        raw_last_event_seq = binding_metadata.get("runtime_status_event_seq")
        try:
            last_event_seq = int(raw_last_event_seq)
        except (TypeError, ValueError):
            last_event_seq = 0
        if event_seq <= 0:
            logger.warning(
                "[IssueTaskRuntimeSync] rejected unsequenced direct binding event "
                "user=%s device=%s task=%s event=%s",
                user_id,
                device_id,
                task_id,
                event_name,
            )
            return None
        if event_seq <= last_event_seq:
            logger.info(
                "[IssueTaskRuntimeSync] ignored reordered direct binding event "
                "user=%s device=%s task=%s event=%s current_seq=%s incoming_seq=%s",
                user_id,
                device_id,
                task_id,
                event_name,
                last_event_seq,
                event_seq,
            )
            return None
        binding_metadata["runtime_status_event_seq"] = event_seq
        binding.metadata_json = binding_metadata
        next_status = (
            "in_progress"
            if projected_status == "running"
            else (
                "in_review"
                if projected_status in {"succeeded", "failed", "cancelled"}
                and item_before.status not in {"completed", "in_review"}
                else None
            )
        )
        if next_status is None or item_before.status == next_status:
            return None
        from app.models.delivery import CloudProject
        from app.services.loop_item_status_history import write_status_change

        project = db.get(CloudProject, item_before.cloud_project_id)
        metadata = (
            dict(item_before.metadata_json)
            if isinstance(item_before.metadata_json, dict)
            else {}
        )
        if project is not None:
            write_status_change(
                metadata,
                project=project,
                from_status=item_before.status,
                to_status=next_status,
                trigger=f"runtime_{projected_status}",
                by_user_id=None,
            )
        item_before.metadata_json = metadata
        item_before.status = next_status
        item_before.completed_at = project_chat_service._loop_unset_datetime(db)
        item_before.sort_order = 0
        item_before.version += 1
        db.flush()
        publish_loop_item_changed(
            db,
            item=item_before,
            reason="runtime_execution_status",
            actor_user_id=user_id,
        )
        logger.info(
            "[IssueTaskRuntimeSync] projected source=direct_binding user=%s "
            "device=%s task=%s event=%s status=%s item=%s",
            user_id,
            device_id,
            task_id,
            event_name,
            projected_status,
            item_before.id,
        )
        return {
            "item_id": str(item_before.id),
            "user_id": user_id,
            "stage_ids": [],
        }

    ready_before = issue_workflow_start_service.ready_robot_stage_ids(item_before)
    item = update_workflow_task_status(
        db,
        user_id=user_id,
        device_id=device_id,
        task_id=task_id,
        execution_status=projected_status,
    )
    if item is None:
        return None
    newly_ready = (
        issue_workflow_start_service.ready_robot_stage_ids(item) - ready_before
    )
    logger.info(
        "[IssueTaskRuntimeSync] projected source=binding user=%s device=%s "
        "task=%s event=%s status=%s item=%s node=%s newly_ready=%s",
        user_id,
        device_id,
        task_id,
        event_name,
        projected_status,
        item.id,
        binding.workflow_node_id,
        sorted(newly_ready),
    )
    return {
        "item_id": str(item.id),
        "user_id": user_id,
        "stage_ids": sorted(newly_ready),
    }


async def continue_projected_workflow(intent: dict[str, Any] | None) -> None:
    if not intent or not intent.get("stage_ids"):
        return
    item_id = str(intent["item_id"])
    user_id = int(intent["user_id"])
    stage_ids = {str(stage_id) for stage_id in intent["stage_ids"]}
    logger.info(
        "[IssueWorkflowContinuation] dispatching item=%s stages=%s user=%s",
        item_id,
        sorted(stage_ids),
        user_id,
    )
    try:
        started = await issue_workflow_start_service.continue_ready_stages_nonblocking(
            item_id=item_id,
            user_id=user_id,
            stage_ids=stage_ids,
        )
    except Exception:
        logger.exception(
            "[IssueWorkflowContinuation] failed item=%s stages=%s user=%s",
            item_id,
            sorted(stage_ids),
            user_id,
        )
        raise
    logger.info(
        "[IssueWorkflowContinuation] completed item=%s stages=%s started=%s",
        item_id,
        sorted(stage_ids),
        started,
    )


def project_chat_runtime_event_sync(
    device_id: str,
    event: dict[str, Any],
    user_id: int | None = None,
    trusted_terminal_snapshot: bool = False,
) -> dict[str, Any] | None:
    event_name = event.get("event")
    payload = event.get("payload")
    if not isinstance(event_name, str) or not isinstance(payload, dict):
        logger.info(
            "[ProjectChat] Runtime event projection skipped invalid payload: "
            "device_id=%s event=%s payload_type=%s",
            device_id,
            event_name,
            type(payload).__name__,
        )
        return None
    runtime_task_id = (
        payload.get("taskId")
        or payload.get("task_id")
        or payload.get("localTaskId")
        or payload.get("local_task_id")
    )
    if not isinstance(runtime_task_id, str) or not runtime_task_id:
        logger.info(
            "[ProjectChat] Runtime event projection skipped missing runtime task id: "
            "device_id=%s event=%s payload_keys=%s payload_status=%s",
            device_id,
            event_name,
            sorted(payload.keys()),
            payload.get("status"),
        )
        return None
    projected_status = _workflow_status_for_runtime_event(event_name, payload)
    log_runtime_event = logger.info if projected_status is not None else logger.debug
    log_runtime_event(
        "[IssueTaskRuntimeSync] received user=%s device=%s task=%s event=%s "
        "event_seq=%s workflow_status=%s",
        user_id,
        device_id,
        runtime_task_id,
        event_name,
        payload.get("eventSeq") or payload.get("event_seq"),
        projected_status,
    )
    with get_db_session() as db:
        # The LoopItemExecution is the aggregate root for Wework automation
        # outcomes. Elect its terminal state before projecting chat so a
        # concurrent complete/fail/cancel cannot leave the run and activity
        # disagreeing with the execution. Streaming events remain ordinary
        # chat projections after the lease write-back.
        execution = loop_item_execution_service.execution_for_runtime(
            db,
            runtime_device_id=device_id,
            runtime_task_id=runtime_task_id,
        )
        ready_before = (
            _execution_ready_robot_stage_ids(db, execution)
            if projected_status is not None
            else set()
        )
        previous_item_version = (
            _execution_item_version(db, execution) if execution is not None else None
        )
        matched_execution = loop_item_execution_service.handle_runtime_event(
            db,
            device_id=device_id,
            runtime_task_id=runtime_task_id,
            event_name=event_name,
            payload=payload,
            allow_unsequenced_terminal=trusted_terminal_snapshot,
        )
        if execution is not None and matched_execution is None:
            logger.info(
                "[ProjectChat] Runtime event projection rejected by execution truth: "
                "device_id=%s task_id=%s event=%s",
                device_id,
                runtime_task_id,
                event_name,
            )
            return None
        if matched_execution is not None:
            workflow_continuation = (
                _project_execution_workflow_status(
                    db,
                    execution=matched_execution,
                    projected_status=projected_status,
                    ready_before=ready_before,
                )
                if projected_status is not None
                else None
            )
            log_projection = (
                logger.info if projected_status is not None else logger.debug
            )
            log_projection(
                "[IssueTaskRuntimeSync] projected source=execution execution=%s "
                "user=%s device=%s task=%s event=%s execution_status=%s "
                "workflow_status=%s item=%s workflow_projected=%s",
                matched_execution.id,
                matched_execution.executor_owner_user_id,
                device_id,
                runtime_task_id,
                event_name,
                matched_execution.status,
                projected_status,
                matched_execution.loop_item_id,
                workflow_continuation is not None,
            )
            db.flush()
            _publish_execution_item_change(
                db,
                execution=matched_execution,
                previous_version=previous_item_version,
            )
        else:
            workflow_continuation = (
                _project_bound_runtime_event_status(
                    db,
                    user_id=user_id,
                    device_id=device_id,
                    task_id=runtime_task_id,
                    event_name=event_name,
                    payload=payload,
                )
                if user_id is not None
                else None
            )
            if user_id is None:
                logger.info(
                    "[IssueTaskRuntimeSync] skipped reason=no_execution_or_user "
                    "device=%s task=%s event=%s",
                    device_id,
                    runtime_task_id,
                    event_name,
                )
        projected = project_chat_service.project_runtime_event(
            db,
            device_id=device_id,
            runtime_task_id=runtime_task_id,
            event_name=event_name,
            payload=payload,
        )
        if projected is None:
            return {
                "message": None,
                "mode": None,
                "workflow_continuation": workflow_continuation,
            }
        message, mode = projected
        return {
            "message": message.model_dump(mode="json", by_alias=True),
            "mode": mode,
            "workflow_continuation": workflow_continuation,
        }


def execution_runtime_event_sync(
    device_id: str, task_id: object, event_name: str, payload: dict
) -> dict[str, Any] | None:
    """Project device runtime events onto the matching robot execution."""

    try:
        with get_db_session() as db:
            execution = loop_item_execution_service.execution_for_runtime(
                db,
                runtime_device_id=device_id,
                runtime_task_id=str(task_id),
            )
            projected_status = _workflow_status_for_runtime_event(event_name, payload)
            ready_before = (
                _execution_ready_robot_stage_ids(db, execution)
                if projected_status is not None
                else set()
            )
            previous_item_version = (
                _execution_item_version(db, execution)
                if execution is not None
                else None
            )
            matched = loop_item_execution_service.handle_runtime_event(
                db,
                device_id=device_id,
                runtime_task_id=str(task_id),
                event_name=event_name,
                payload=payload,
            )
            if matched is not None:
                workflow_continuation = (
                    _project_execution_workflow_status(
                        db,
                        execution=matched,
                        projected_status=projected_status,
                        ready_before=ready_before,
                    )
                    if projected_status is not None
                    else None
                )
                db.flush()
                _publish_execution_item_change(
                    db,
                    execution=matched,
                    previous_version=previous_item_version,
                )
                return workflow_continuation
            return None
    except Exception:
        logger.exception(
            "[RobotQueue] Execution runtime event write-back failed "
            "device=%s task=%s event=%s",
            device_id,
            task_id,
            event_name,
        )
        return None

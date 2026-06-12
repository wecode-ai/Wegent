# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Review and safely revert per-turn file change artifacts."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.subtask import Subtask, SubtaskRole
from app.schemas.turn_file_changes import (
    TurnFileChangesDiffResponse,
    TurnFileChangesRevertResponse,
    TurnFileChangesSummary,
)
from app.services.device.command_service import (
    DeviceCommandError,
    DeviceCommandNotFoundError,
    execute_configured_device_command,
)
from app.stores.tasks import subtask_store, task_store

MAX_DIFF_OUTPUT_BYTES = 5 * 1024 * 1024


def _error(status_code: int, code: str, message: str, **extra: Any) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, **extra},
    )


class TurnFileChangesService:
    """Load stored summaries and dispatch artifact commands to their device."""

    async def get_diff(
        self,
        *,
        db: Session,
        user_id: int,
        subtask_id: int,
    ) -> TurnFileChangesDiffResponse:
        subtask, summary = self._load_summary(db, user_id, subtask_id)
        if summary.status == "artifact_missing":
            raise self._artifact_missing_error()

        payload = await self._execute(
            db=db,
            user_id=user_id,
            summary=summary,
            command_key="turn_file_changes_review",
        )
        self._raise_for_artifact_status(db, subtask, payload)
        diff = payload.get("diff")
        if payload.get("success") is not True or not isinstance(diff, str):
            raise _error(
                422,
                "TURN_FILE_CHANGES_ARTIFACT_INVALID",
                str(payload.get("error") or "Device returned an invalid diff artifact"),
            )
        return TurnFileChangesDiffResponse(subtask_id=subtask.id, diff=diff)

    async def revert(
        self,
        *,
        db: Session,
        user_id: int,
        subtask_id: int,
    ) -> TurnFileChangesRevertResponse:
        subtask, summary = self._load_summary(db, user_id, subtask_id)
        if summary.status == "reverted":
            return TurnFileChangesRevertResponse(
                subtask_id=subtask.id,
                file_changes=summary,
            )
        if summary.status == "artifact_missing":
            raise self._artifact_missing_error()

        payload = await self._execute(
            db=db,
            user_id=user_id,
            summary=summary,
            command_key="turn_file_changes_revert",
        )
        self._raise_for_artifact_status(db, subtask, payload)
        if payload.get("success") is True and payload.get("status") == "reverted":
            updated = self._update_status(
                db,
                subtask,
                status="reverted",
                reverted_at=datetime.now(timezone.utc).isoformat(),
            )
            return TurnFileChangesRevertResponse(
                subtask_id=subtask.id,
                file_changes=updated,
            )
        if payload.get("status") == "conflicted":
            updated = self._update_status(db, subtask, status="conflicted")
            raise _error(
                409,
                "TURN_FILE_CHANGES_CONFLICT",
                str(payload.get("error") or "Patch does not apply"),
                file_changes=updated.model_dump(mode="json"),
            )
        raise _error(
            422,
            "TURN_FILE_CHANGES_ARTIFACT_INVALID",
            str(payload.get("error") or "Device returned an invalid revert result"),
        )

    def _load_summary(
        self,
        db: Session,
        user_id: int,
        subtask_id: int,
    ) -> tuple[Subtask, TurnFileChangesSummary]:
        subtask = subtask_store.get_by_id_and_role(
            db,
            subtask_id=subtask_id,
            role=SubtaskRole.ASSISTANT,
            owner_user_id=user_id,
        )
        if subtask is None or not task_store.get_active_task(
            db,
            task_id=subtask.task_id,
            owner_user_id=user_id,
        ):
            raise _error(
                404,
                "TURN_FILE_CHANGES_NOT_FOUND",
                "Assistant message file changes were not found",
            )

        result = subtask.result if isinstance(subtask.result, dict) else {}
        raw_summary = result.get("file_changes")
        try:
            summary = TurnFileChangesSummary.model_validate(raw_summary)
        except ValidationError as exc:
            raise _error(
                409,
                "TURN_FILE_CHANGES_INVALID_STATE",
                "Stored file changes summary is invalid",
            ) from exc

        task_json = task.json if isinstance(task.json, dict) else {}
        task_spec = task_json.get("spec")
        expected_device_id = (
            task_spec.get("device_id") if isinstance(task_spec, dict) else None
        )
        if expected_device_id and expected_device_id != summary.device_id:
            raise _error(
                409,
                "TURN_FILE_CHANGES_DEVICE_MISMATCH",
                "Stored artifact device does not match the task device",
            )
        return subtask, summary

    async def _execute(
        self,
        *,
        db: Session,
        user_id: int,
        summary: TurnFileChangesSummary,
        command_key: str,
    ) -> dict[str, Any]:
        try:
            result = await execute_configured_device_command(
                db=db,
                user_id=user_id,
                device_id=summary.device_id,
                command_key=command_key,
                path=summary.workspace_path,
                args=[summary.artifact_id],
                timeout_seconds=30,
                max_output_bytes=MAX_DIFF_OUTPUT_BYTES,
            )
        except DeviceCommandNotFoundError as exc:
            raise _error(
                409,
                "TURN_FILE_CHANGES_DEVICE_UNAVAILABLE",
                str(exc),
            ) from exc
        except DeviceCommandError as exc:
            code = (
                "TURN_FILE_CHANGES_DEVICE_OFFLINE"
                if "offline" in str(exc).lower()
                else "TURN_FILE_CHANGES_DEVICE_UNAVAILABLE"
            )
            raise _error(409, code, str(exc)) from exc

        if not isinstance(result, dict):
            raise _error(
                422,
                "TURN_FILE_CHANGES_ARTIFACT_INVALID",
                "Device returned an invalid command result",
            )
        if result.get("success") is not True:
            raise _error(
                422,
                "TURN_FILE_CHANGES_ARTIFACT_INVALID",
                str(
                    result.get("error")
                    or result.get("stderr")
                    or "Artifact command failed"
                ),
            )
        payload = result.get("stdout")
        if not isinstance(payload, dict):
            raise _error(
                422,
                "TURN_FILE_CHANGES_ARTIFACT_INVALID",
                "Device returned malformed artifact output",
            )
        return payload

    def _raise_for_artifact_status(
        self,
        db: Session,
        subtask: Subtask,
        payload: dict[str, Any],
    ) -> None:
        if payload.get("status") != "artifact_missing":
            return
        updated = self._update_status(db, subtask, status="artifact_missing")
        raise _error(
            410,
            "TURN_FILE_CHANGES_ARTIFACT_MISSING",
            str(payload.get("error") or "Turn file changes artifact is missing"),
            file_changes=updated.model_dump(mode="json"),
        )

    def _update_status(
        self,
        db: Session,
        subtask: Subtask,
        *,
        status: str,
        reverted_at: str | None = None,
    ) -> TurnFileChangesSummary:
        updated_result = dict(subtask.result or {})
        updated_file_changes = dict(updated_result["file_changes"])
        updated_file_changes["status"] = status
        if reverted_at is not None:
            updated_file_changes["reverted_at"] = reverted_at
        updated_result["file_changes"] = updated_file_changes
        subtask.result = updated_result
        flag_modified(subtask, "result")
        db.commit()
        return TurnFileChangesSummary.model_validate(updated_file_changes)

    @staticmethod
    def _artifact_missing_error() -> HTTPException:
        return _error(
            410,
            "TURN_FILE_CHANGES_ARTIFACT_MISSING",
            "Turn file changes artifact is missing",
        )


turn_file_changes_service = TurnFileChangesService()

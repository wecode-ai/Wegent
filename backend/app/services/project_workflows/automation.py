# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project automations that create tasks and start persisted workflows."""

from __future__ import annotations

import copy
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.webhook_secrets import encrypt_webhook_secret
from app.models.project_workflow import (
    EPOCH_TIME,
    ProjectWorkflowAutomation,
    ProjectWorkflowAutomationRun,
)
from app.schemas.base_role import BaseRole
from app.schemas.delivery import LoopItemCreate
from app.schemas.project_workflow import (
    ExecutionTargetRef,
    ProjectWorkflowAutomationCreate,
    ProjectWorkflowAutomationRunRequest,
    ProjectWorkflowAutomationRunView,
    ProjectWorkflowAutomationSecretView,
    ProjectWorkflowAutomationUpdate,
    ProjectWorkflowAutomationView,
    TaskExecutionBindingUpsert,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.service import loop_item_service
from app.services.project_workflows.state import WorkflowStatus

SUPPORTED_TASK_FIELDS = {
    "title",
    "description",
    "status",
    "assignee_user_id",
    "priority",
    "due_at",
    "parent_id",
    "tags",
}


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _iso(value: datetime) -> str:
    return value.replace(tzinfo=UTC).isoformat()


def _optional_iso(value: datetime) -> str | None:
    return None if value == EPOCH_TIME else _iso(value)


def _row_version(row: object, expected: int) -> None:
    if int(getattr(row, "version", 0)) != expected:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Resource was modified; reload it before saving",
        )


class AutomationWorkflowMixin:
    """Own project workflow trigger configuration and run history."""

    def list_automations(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
    ) -> list[ProjectWorkflowAutomationView]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        rows = (
            db.query(ProjectWorkflowAutomation)
            .filter(ProjectWorkflowAutomation.cloud_project_id == str(project_id))
            .order_by(ProjectWorkflowAutomation.created_at.asc())
            .all()
        )
        return [self._automation_view(row) for row in rows]

    def create_automation(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        request: ProjectWorkflowAutomationCreate,
    ) -> ProjectWorkflowAutomationView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        self._validate_automation_configuration(
            db,
            project_id=project_id,
            user_id=user_id,
            workflow_id=request.workflow_id,
            repository_binding_id=request.repository_binding_id,
            execution_target=request.execution_target,
            trigger_type=request.trigger_type,
            trigger_config=request.trigger_config,
            task_template=request.task_template,
        )
        now = _now()
        secret = secrets.token_urlsafe(32)
        row = ProjectWorkflowAutomation(
            id=_id(),
            cloud_project_id=str(project_id),
            name=request.name,
            description=request.description,
            trigger_type=request.trigger_type,
            trigger_config_json=copy.deepcopy(request.trigger_config),
            workflow_definition_id=request.workflow_id,
            repository_binding_id=request.repository_binding_id or "",
            execution_target_type=request.execution_target.type,
            execution_target_id=request.execution_target.id or "",
            workspace_mode=request.workspace_mode,
            task_template_json=copy.deepcopy(request.task_template),
            payload_mapping_json=copy.deepcopy(request.payload_mapping),
            webhook_token=secrets.token_urlsafe(24),
            webhook_secret_ciphertext=encrypt_webhook_secret(secret),
            enabled=int(request.enabled),
            next_run_at=(
                self._next_run_at(
                    request.trigger_type,
                    request.trigger_config,
                    after=now,
                )
                if request.enabled
                else EPOCH_TIME
            ),
            created_by_user_id=user_id,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return self._automation_view(row)

    def update_automation(
        self,
        db: Session,
        *,
        project_id: int,
        automation_id: str,
        user_id: int,
        request: ProjectWorkflowAutomationUpdate,
    ) -> ProjectWorkflowAutomationView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        row = self._get_automation(db, project_id, automation_id)
        _row_version(row, request.version)
        values = request.model_dump(exclude_unset=True, exclude={"version"})
        target = values.pop("execution_target", None)
        workflow_id = str(values.pop("workflow_id", row.workflow_definition_id))
        repository_id = values.pop(
            "repository_binding_id",
            row.repository_binding_id or None,
        )
        trigger_type = str(values.get("trigger_type", row.trigger_type))
        trigger_config = values.get("trigger_config", row.trigger_config_json)
        task_template = values.get("task_template", row.task_template_json)
        resolved_target = target or ExecutionTargetRef(
            type=row.execution_target_type,
            id=row.execution_target_id or None,
        )
        self._validate_automation_configuration(
            db,
            project_id=project_id,
            user_id=user_id,
            workflow_id=workflow_id,
            repository_binding_id=repository_id,
            execution_target=resolved_target,
            trigger_type=trigger_type,
            trigger_config=trigger_config,
            task_template=task_template,
        )
        mappings = {
            "trigger_config": "trigger_config_json",
            "task_template": "task_template_json",
            "payload_mapping": "payload_mapping_json",
        }
        for key, value in values.items():
            setattr(row, mappings.get(key, key), copy.deepcopy(value))
        row.workflow_definition_id = workflow_id
        row.repository_binding_id = repository_id or ""
        if target is not None:
            row.execution_target_type = target.type
            row.execution_target_id = target.id or ""
        if "enabled" in values:
            row.enabled = int(bool(values["enabled"]))
        row.next_run_at = (
            self._next_run_at(
                row.trigger_type,
                row.trigger_config_json,
                after=_now(),
            )
            if row.enabled
            else EPOCH_TIME
        )
        row.version += 1
        db.commit()
        db.refresh(row)
        return self._automation_view(row)

    def rotate_automation_webhook_secret(
        self,
        db: Session,
        *,
        project_id: int,
        automation_id: str,
        user_id: int,
    ) -> ProjectWorkflowAutomationSecretView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._get_automation(db, project_id, automation_id)
        secret = secrets.token_urlsafe(32)
        row.webhook_token = secrets.token_urlsafe(24)
        row.webhook_secret_ciphertext = encrypt_webhook_secret(secret)
        row.version += 1
        db.commit()
        return ProjectWorkflowAutomationSecretView(
            automation_id=row.id,
            webhook_token=row.webhook_token,
            webhook_secret=secret,
        )

    def list_automation_runs(
        self,
        db: Session,
        *,
        project_id: int,
        automation_id: str,
        user_id: int,
    ) -> list[ProjectWorkflowAutomationRunView]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
        self._get_automation(db, project_id, automation_id)
        rows = (
            db.query(ProjectWorkflowAutomationRun)
            .filter(ProjectWorkflowAutomationRun.automation_id == automation_id)
            .order_by(ProjectWorkflowAutomationRun.created_at.desc())
            .limit(100)
            .all()
        )
        return [self._automation_run_view(row) for row in rows]

    def run_automation(
        self,
        db: Session,
        *,
        project_id: int,
        automation_id: str,
        user_id: int,
        request: ProjectWorkflowAutomationRunRequest,
        trigger_type: str = "manual",
        scheduled_for: datetime | None = None,
    ) -> ProjectWorkflowAutomationRunView:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        automation = self._get_automation(db, project_id, automation_id)
        return self._execute_automation(
            db,
            automation=automation,
            user_id=user_id,
            request=request,
            trigger_type=trigger_type,
            scheduled_for=scheduled_for or _now(),
        )

    def run_due_automations(self, db: Session, *, limit: int = 20) -> int:
        now = _now()
        rows = (
            db.query(ProjectWorkflowAutomation)
            .filter(
                ProjectWorkflowAutomation.enabled == 1,
                ProjectWorkflowAutomation.next_run_at > EPOCH_TIME,
                ProjectWorkflowAutomation.next_run_at <= now,
            )
            .order_by(ProjectWorkflowAutomation.next_run_at.asc())
            .limit(limit)
            .all()
        )
        completed = 0
        for automation in rows:
            scheduled_for = automation.next_run_at
            key = f"schedule:{_iso(scheduled_for)}"
            try:
                self._execute_automation(
                    db,
                    automation=automation,
                    user_id=automation.created_by_user_id,
                    request=ProjectWorkflowAutomationRunRequest(
                        idempotency_key=key,
                    ),
                    trigger_type=automation.trigger_type,
                    scheduled_for=scheduled_for,
                )
                completed += 1
            except Exception:
                db.rollback()
            finally:
                current = db.get(ProjectWorkflowAutomation, automation.id)
                if current is not None:
                    current.next_run_at = self._next_run_at(
                        current.trigger_type,
                        current.trigger_config_json,
                        after=max(now, scheduled_for),
                    )
                    if current.trigger_type == "one_time":
                        current.enabled = 0
                    current.version += 1
                    db.commit()
        return completed

    def trigger_webhook_automation(
        self,
        db: Session,
        *,
        automation: ProjectWorkflowAutomation,
        delivery_id: str,
        payload: dict,
    ) -> ProjectWorkflowAutomationRunView:
        if automation.trigger_type != "webhook" or not automation.enabled:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Workflow automation webhook is disabled",
            )
        return self._execute_automation(
            db,
            automation=automation,
            user_id=automation.created_by_user_id,
            request=ProjectWorkflowAutomationRunRequest(
                idempotency_key=f"webhook:{delivery_id}",
                payload=payload,
            ),
            trigger_type="webhook",
            scheduled_for=_now(),
        )

    def _execute_automation(
        self,
        db: Session,
        *,
        automation: ProjectWorkflowAutomation,
        user_id: int,
        request: ProjectWorkflowAutomationRunRequest,
        trigger_type: str,
        scheduled_for: datetime,
    ) -> ProjectWorkflowAutomationRunView:
        idempotency_key = request.idempotency_key or f"manual:{uuid.uuid4().hex}"
        existing = (
            db.query(ProjectWorkflowAutomationRun)
            .filter(
                ProjectWorkflowAutomationRun.automation_id == automation.id,
                ProjectWorkflowAutomationRun.idempotency_key == idempotency_key,
            )
            .first()
        )
        if existing:
            return self._automation_run_view(existing)
        run = ProjectWorkflowAutomationRun(
            id=_id(),
            automation_id=automation.id,
            trigger_type=trigger_type,
            idempotency_key=idempotency_key,
            payload_json=copy.deepcopy(request.payload),
            status="running",
            scheduled_for=scheduled_for,
            started_at=_now(),
        )
        db.add(run)
        db.commit()
        try:
            task_values = self._mapped_task_values(automation, request.payload)
            task = loop_item_service.create(
                db,
                int(automation.cloud_project_id),
                user_id,
                LoopItemCreate.model_validate(task_values),
            )
            binding = self.upsert_task_binding(
                db,
                project_id=int(automation.cloud_project_id),
                item_id=task.id,
                user_id=user_id,
                request=TaskExecutionBindingUpsert(
                    workflow_id=automation.workflow_definition_id,
                    repository_binding_id=automation.repository_binding_id or None,
                    execution_target=ExecutionTargetRef(
                        type=automation.execution_target_type,
                        id=automation.execution_target_id or None,
                    ),
                    workspace_mode=automation.workspace_mode,
                ),
            )
            workflow_run = self.start_task_workflow(
                db,
                project_id=int(automation.cloud_project_id),
                item_id=task.id,
                user_id=user_id,
                idempotency_key=f"automation:{automation.id}:{run.id}",
            )
            run.loop_item_id = task.id
            run.workflow_run_id = workflow_run.id
            run.status = "succeeded"
            run.completed_at = _now()
            automation.last_run_at = run.completed_at
            automation.version += 1
            db.commit()
            db.refresh(run)
            return self._automation_run_view(run)
        except Exception as exc:
            db.rollback()
            failed = db.get(ProjectWorkflowAutomationRun, run.id)
            if failed is not None:
                failed.status = "failed"
                failed.error_message = str(exc)[:20_000]
                failed.completed_at = _now()
                db.commit()
                db.refresh(failed)
            raise

    def _validate_automation_configuration(
        self,
        db: Session,
        *,
        project_id: int,
        user_id: int,
        workflow_id: str,
        repository_binding_id: str | None,
        execution_target: ExecutionTargetRef,
        trigger_type: str,
        trigger_config: dict,
        task_template: dict,
    ) -> None:
        self._get_workflow(db, project_id, workflow_id)
        if repository_binding_id:
            self._get_repository(db, project_id, repository_binding_id)
        self.resolve_execution_target(
            db,
            user_id=user_id,
            target=execution_target,
        )
        unknown = set(task_template) - SUPPORTED_TASK_FIELDS
        if unknown:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"Unsupported automation task fields: {', '.join(sorted(unknown))}",
            )
        self._next_run_at(trigger_type, trigger_config, after=_now())

    @staticmethod
    def _mapped_task_values(
        automation: ProjectWorkflowAutomation,
        payload: dict,
    ) -> dict:
        values = copy.deepcopy(automation.task_template_json or {})
        for field, path in (automation.payload_mapping_json or {}).items():
            if field not in SUPPORTED_TASK_FIELDS:
                continue
            value = AutomationWorkflowMixin._payload_value(payload, str(path))
            if value is not None:
                values[field] = value
        values.setdefault("title", automation.name)
        values.setdefault("description", automation.description)
        return values

    @staticmethod
    def _payload_value(payload: dict, path: str) -> object | None:
        current: object = payload
        for part in path.split("."):
            if not isinstance(current, dict) or part not in current:
                return None
            current = current[part]
        return current

    @staticmethod
    def _next_run_at(
        trigger_type: str,
        config: dict,
        *,
        after: datetime,
    ) -> datetime:
        if trigger_type in {"manual", "webhook"}:
            return EPOCH_TIME
        if trigger_type == "one_time":
            raw = str(config.get("executeAt") or config.get("execute_at") or "")
            try:
                value = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "one_time trigger requires a valid executeAt",
                ) from exc
            if value.tzinfo is not None:
                value = value.astimezone(UTC).replace(tzinfo=None)
            return value
        if trigger_type == "interval":
            value = int(config.get("value") or 0)
            unit = str(config.get("unit") or "")
            seconds = {
                "minutes": 60,
                "hours": 3600,
                "days": 86_400,
            }.get(unit)
            if value <= 0 or seconds is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "interval trigger requires a positive value and valid unit",
                )
            return after + timedelta(seconds=value * seconds)
        if trigger_type == "cron":
            expression = str(config.get("expression") or "")
            timezone_name = str(config.get("timezone") or "UTC")
            try:
                timezone = ZoneInfo(timezone_name)
                base = after.replace(tzinfo=UTC).astimezone(timezone)
                value = croniter(expression, base).get_next(datetime)
            except (ValueError, ZoneInfoNotFoundError) as exc:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "cron trigger requires a valid expression and IANA timezone",
                ) from exc
            return value.astimezone(UTC).replace(tzinfo=None)
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Unsupported automation trigger type: {trigger_type}",
        )

    @staticmethod
    def _get_automation(
        db: Session,
        project_id: int,
        automation_id: str,
    ) -> ProjectWorkflowAutomation:
        row = (
            db.query(ProjectWorkflowAutomation)
            .filter(
                ProjectWorkflowAutomation.id == automation_id,
                ProjectWorkflowAutomation.cloud_project_id == str(project_id),
            )
            .first()
        )
        if row is None:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                "Project workflow automation not found",
            )
        return row

    @staticmethod
    def _automation_view(
        row: ProjectWorkflowAutomation,
    ) -> ProjectWorkflowAutomationView:
        return ProjectWorkflowAutomationView(
            id=row.id,
            project_id=row.cloud_project_id,
            name=row.name,
            description=row.description,
            trigger_type=row.trigger_type,
            trigger_config=row.trigger_config_json,
            workflow_id=row.workflow_definition_id,
            repository_binding_id=row.repository_binding_id or None,
            execution_target=ExecutionTargetRef(
                type=row.execution_target_type,
                id=row.execution_target_id or None,
            ),
            workspace_mode=row.workspace_mode,
            task_template=row.task_template_json,
            payload_mapping=row.payload_mapping_json,
            webhook_configured=bool(row.webhook_secret_ciphertext),
            enabled=bool(row.enabled),
            next_run_at=_optional_iso(row.next_run_at),
            last_run_at=_optional_iso(row.last_run_at),
            created_by_user_id=row.created_by_user_id,
            version=row.version,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

    @staticmethod
    def _automation_run_view(
        row: ProjectWorkflowAutomationRun,
    ) -> ProjectWorkflowAutomationRunView:
        return ProjectWorkflowAutomationRunView(
            id=row.id,
            automation_id=row.automation_id,
            trigger_type=row.trigger_type,
            status=row.status,
            loop_item_id=row.loop_item_id or None,
            workflow_run_id=row.workflow_run_id or None,
            scheduled_for=_optional_iso(row.scheduled_for),
            started_at=_optional_iso(row.started_at),
            completed_at=_optional_iso(row.completed_at),
            error_message=row.error_message or None,
            created_at=_iso(row.created_at),
            updated_at=_iso(row.updated_at),
        )

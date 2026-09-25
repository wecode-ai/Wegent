# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project automation rule CRUD, run records, and schedule scanning."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, aliased

from app.db.timezone import database_datetime_timezone
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectIncomingHook,
    loop_datetime_is_unset,
    loop_datetime_value_is_unset,
    loop_unset_datetime_for_connection,
)
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole
from app.schemas.project_automation import (
    ProjectAutomationCreate,
    ProjectAutomationUpdate,
    ProjectAutomationWorkflowMigration,
)
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_item_executions.service import (
    ACTIVE_STATUSES,
    loop_item_execution_service,
)
from app.services.project_automation_domain import (
    ACTIVE_RUN_STATUSES,
    ProjectAutomationEvent,
    integer,
)
from app.services.project_automation_domain import metadata as _metadata
from app.services.project_automation_domain import next_run as _next_run
from app.services.project_automation_domain import (
    project_agent,
    text,
)
from app.services.project_automation_domain import utc_aware as _utc_aware
from app.services.project_automation_domain import (
    utcnow,
    validate_trigger,
)
from app.services.project_automation_execution import (
    AutomationRunNotRetryable,
    ProjectAutomationProcessor,
    project_automation_execution,
)
from app.services.project_event_sources import EXECUTION_TARGETS, event_source

logger = logging.getLogger(__name__)


def _canonical_event_config(
    event_type: str | None,
    event_config: object,
) -> dict:
    config = dict(event_config) if isinstance(event_config, dict) else {}
    config.pop("statuses", None)
    if event_type == "task.status_changed":
        config["transition"] = "entered_processing"
    else:
        config.pop("transition", None)
    if event_type in {"task.created", "task.tag_added", "task.status_changed"}:
        config["execution_target"] = "existing_issue"
    elif event_type and not config.get("execution_target"):
        config["execution_target"] = "create_issue"
    return config


class ProjectAutomationService:
    """Own project automation rules, schedules, and persisted run records."""

    def list(self, db: Session, project_id: str, user_id: int) -> list[dict]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Viewer)
        rows = (
            db.query(ProjectAutomationRule)
            .filter(
                ProjectAutomationRule.cloud_project_id == project_id,
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .order_by(ProjectAutomationRule.updated_at.desc())
            .all()
        )
        return [self._rule_view(db, row) for row in rows]

    def create(
        self,
        db: Session,
        project_id: str,
        user_id: int,
        values: ProjectAutomationCreate,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        db.query(CloudProject).filter(
            CloudProject.id == project_id
        ).with_for_update().one()
        row = self._create_rule(
            db,
            project_id=project_id,
            user_id=user_id,
            values=values,
        )
        db.commit()
        db.refresh(row)
        return self._rule_view(db, row)

    def migrate_workflow(
        self,
        db: Session,
        project_id: str,
        user_id: int,
        values: ProjectAutomationWorkflowMigration,
    ) -> dict:
        """Promote one legacy Issue workflow into canonical automation storage."""

        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        project = (
            db.query(CloudProject)
            .filter(CloudProject.id == project_id)
            .with_for_update()
            .one_or_none()
        )
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        if project.version != values.project_version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Cloud project changed")
        project_metadata = dict(project.metadata_json or {})
        existing_id = text(project_metadata.get("workflow_automation_id"))
        if existing_id:
            existing = db.get(ProjectAutomationRule, existing_id)
            if existing is not None and loop_datetime_value_is_unset(
                existing.deleted_at
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Project workflow has already been promoted",
                )

        automation_values = values.automation.model_copy(deep=True)
        automation_values.event_config = {
            **automation_values.event_config,
            "runtime_workflow_definition": values.workflow_definition.model_dump(
                mode="json"
            ),
        }
        row = self._create_rule(
            db,
            project_id=project_id,
            user_id=user_id,
            values=automation_values,
        )
        project_metadata["workflow_automation_id"] = str(row.id)
        project_metadata["workflow_definition"] = {
            "version": values.workflow_definition.version,
            "stage_mode": "none",
            "advancement_policy": "manual",
            "coordinator_prompt": "",
            "approval_policy": "required",
            "ai_automation_rule_id": None,
            "execution_config": None,
            "nodes": [],
        }
        project.metadata_json = project_metadata
        project.version += 1
        db.commit()
        db.refresh(row)
        db.refresh(project)
        return {
            "automation": self._rule_view(db, row),
            "project_version": project.version,
            "workflow_automation_id": str(row.id),
        }

    def _create_rule(
        self,
        db: Session,
        *,
        project_id: str,
        user_id: int,
        values: ProjectAutomationCreate,
    ) -> ProjectAutomationRule:
        dispatch_target = self._validate_dispatch_target(
            db,
            project_id=project_id,
            user_id=user_id,
            target_kind=values.target_kind,
            target_id=values.target_id,
        )
        dispatch_target["execution_device_id"] = values.execution_device_id
        validate_trigger(values.trigger_type, values.event_type, values.cron_expression)
        event_config = _canonical_event_config(
            values.event_type if values.trigger_type == "event" else None,
            values.event_config,
        )
        self._validate_event_config(
            db,
            project_id=project_id,
            trigger_type=values.trigger_type,
            event_type=values.event_type,
            event_config=event_config,
        )
        now = utcnow()
        next_run_at = (
            _next_run(str(values.cron_expression), values.timezone, now)
            if values.trigger_type == "schedule"
            else None
        )
        row = ProjectAutomationRule(
            cloud_project_id=project_id,
            title=values.name,
            description=values.prompt,
            assignee_agent_id="",
            status="enabled" if values.enabled else "disabled",
            due_at=next_run_at if values.enabled else None,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json={
                "trigger_type": values.trigger_type,
                "event_type": (
                    values.event_type if values.trigger_type == "event" else None
                ),
                "event_config": event_config,
                "cron_expression": (
                    values.cron_expression
                    if values.trigger_type == "schedule"
                    else None
                ),
                "timezone": values.timezone,
                "last_run_at": None,
                "dispatch_target": dispatch_target,
            },
        )
        db.add(row)
        db.flush()
        row.metadata_json = self._bind_self_managed_workflow(
            _metadata(row),
            automation_id=str(row.id),
        )
        self._validate_workflow_definition(
            _metadata(row).get("event_config"),
        )
        return row

    @staticmethod
    def _bind_self_managed_workflow(
        rule_metadata: dict,
        *,
        automation_id: str,
    ) -> dict:
        event_config = rule_metadata.get("event_config")
        if not isinstance(event_config, dict):
            return rule_metadata
        raw_definition = event_config.get("runtime_workflow_definition")
        if not isinstance(raw_definition, dict):
            return rule_metadata
        if raw_definition.get("advancement_policy") != "ai" or raw_definition.get(
            "ai_automation_rule_id"
        ):
            return rule_metadata
        next_definition = {
            **raw_definition,
            "ai_automation_rule_id": automation_id,
        }
        next_event_config = {
            **event_config,
            "runtime_workflow_definition": next_definition,
        }
        return {**rule_metadata, "event_config": next_event_config}

    @staticmethod
    def _validate_workflow_definition(event_config: object) -> None:
        if not isinstance(event_config, dict):
            return
        raw_definition = event_config.get("runtime_workflow_definition")
        if raw_definition is None:
            return
        if not isinstance(raw_definition, dict):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Automation workflow definition must be an object",
            )
        try:
            from app.schemas.issue_workflow import ProjectWorkflowDefinition

            ProjectWorkflowDefinition.model_validate(raw_definition)
        except ValueError as exc:
            errors = exc.errors() if hasattr(exc, "errors") else []
            error_detail = errors[0].get("msg", str(exc)) if errors else str(exc)
            error_detail = str(error_detail).removeprefix("Value error, ").strip()
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"自动化流程配置无效：{error_detail}",
            ) from exc

    @staticmethod
    def _validate_event_config(
        db: Session,
        *,
        project_id: str,
        trigger_type: str,
        event_type: str | None,
        event_config: dict,
    ) -> None:
        if trigger_type != "event":
            return
        target = str(event_config.get("execution_target") or "")
        if target not in EXECUTION_TARGETS:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Event automation requires a supported execution_target",
            )
        if event_type in {"task.created", "task.tag_added", "task.status_changed"}:
            if target != "existing_issue":
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT,
                    "Wework task events run on the existing Issue",
                )
            return
        subscription_id = str(event_config.get("subscription_id") or "")
        if not subscription_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "External event automation requires subscription_id",
            )
        subscription = db.get(ProjectIncomingHook, subscription_id)
        if (
            subscription is None
            or str(subscription.cloud_project_id) != str(project_id)
            or not loop_datetime_value_is_unset(subscription.deleted_at)
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Event subscription is unavailable",
            )
        subscription_metadata = _metadata(subscription)
        source_type = str(
            subscription_metadata.get("source_type") or subscription.source or ""
        )
        definition = event_source(source_type)
        if event_type not in definition.event_types:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{source_type} does not support {event_type}",
            )
        if target not in definition.execution_targets:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"{source_type} does not support execution target {target}",
            )

    def update(
        self,
        db: Session,
        project_id: str,
        automation_id: str,
        user_id: int,
        values: ProjectAutomationUpdate,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        db.query(CloudProject).filter(
            CloudProject.id == project_id
        ).with_for_update().one()
        row = self._rule(db, project_id, automation_id, for_update=True)
        if row.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Automation version conflict")

        rule_metadata = _metadata(row)
        trigger_type = values.trigger_type or str(
            rule_metadata.get("trigger_type") or "schedule"
        )
        event_type = (
            values.event_type
            if values.event_type is not None
            else rule_metadata.get("event_type")
        )
        expression = (
            values.cron_expression
            if values.cron_expression is not None
            else rule_metadata.get("cron_expression")
        )
        timezone_name = values.timezone or str(
            rule_metadata.get("timezone") or "Asia/Shanghai"
        )
        if trigger_type == "schedule":
            event_type = None
        elif trigger_type == "event":
            expression = None
        else:
            event_type = None
            expression = None
        validate_trigger(trigger_type, event_type, expression)

        current_target = rule_metadata.get("dispatch_target")
        current_target = (
            dict(current_target) if isinstance(current_target, dict) else None
        )
        target_changed = "target_kind" in values.model_fields_set
        dispatch_target = (
            self._validate_dispatch_target(
                db,
                project_id=project_id,
                user_id=user_id,
                target_kind=values.target_kind,
                target_id=values.target_id,
            )
            if target_changed
            else current_target
        )
        if dispatch_target is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Automation dispatch target is required",
            )
        device_id = (
            values.execution_device_id
            if "execution_device_id" in values.model_fields_set
            else text(dispatch_target.get("execution_device_id"))
        )
        if dispatch_target["kind"] == "human" and device_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Human targets do not use an execution device",
            )
        row.assignee_agent_id = ""
        if values.name is not None:
            row.title = values.name
        if values.prompt is not None:
            row.description = values.prompt
        if values.enabled is not None:
            row.status = "enabled" if values.enabled else "disabled"

        event_config = _canonical_event_config(
            event_type,
            (
                values.event_config
                if values.event_config is not None
                else rule_metadata.get("event_config", {})
            ),
        )
        self._validate_event_config(
            db,
            project_id=project_id,
            trigger_type=trigger_type,
            event_type=str(event_type) if event_type else None,
            event_config=event_config,
        )
        rule_metadata.update(
            {
                "trigger_type": trigger_type,
                "event_type": event_type,
                "event_config": event_config,
                "cron_expression": expression,
                "timezone": timezone_name,
                "dispatch_target": (
                    {
                        **dispatch_target,
                        "execution_device_id": device_id,
                    }
                    if dispatch_target
                    else None
                ),
            }
        )
        row.metadata_json = self._bind_self_managed_workflow(
            rule_metadata,
            automation_id=str(row.id),
        )
        self._validate_workflow_definition(
            _metadata(row).get("event_config"),
        )
        row.due_at = (
            _next_run(str(expression), timezone_name, utcnow())
            if row.status == "enabled" and trigger_type == "schedule"
            else loop_unset_datetime_for_connection(db.connection(), "due_at")
        )
        row.updated_by_user_id = user_id
        row.version += 1
        db.commit()
        db.refresh(row)
        return self._rule_view(db, row)

    def delete(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        project = (
            db.query(CloudProject)
            .filter(CloudProject.id == project_id)
            .with_for_update()
            .one_or_none()
        )
        if project is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Cloud project not found")
        row = self._rule(db, project_id, automation_id, for_update=True)
        self._mark_deleted(db, row, user_id=user_id, deleted_at=utcnow())
        project_metadata = dict(project.metadata_json or {})
        if text(project_metadata.get("workflow_automation_id")) == automation_id:
            project_metadata.pop("workflow_automation_id", None)
            project.metadata_json = project_metadata
            project.version += 1
        db.commit()
        logger.info(
            "[ProjectAutomation] Deleted rule=%s project=%s user=%s",
            automation_id,
            project_id,
            user_id,
        )
        return {
            "project_version": project.version,
            "workflow_automation_id": text(
                (project.metadata_json or {}).get("workflow_automation_id")
            )
            or None,
        }

    def delete_project_rules(self, db: Session, project_id: str, user_id: int) -> int:
        """Delete every automation rule while its parent project is archived."""

        rows = (
            db.query(ProjectAutomationRule)
            .filter(
                ProjectAutomationRule.cloud_project_id == project_id,
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .with_for_update()
            .all()
        )
        deleted_at = utcnow()
        for row in rows:
            self._mark_deleted(
                db,
                row,
                user_id=user_id,
                deleted_at=deleted_at,
            )
        logger.info(
            "[ProjectAutomation] Deleted project rules project=%s count=%s user=%s",
            project_id,
            len(rows),
            user_id,
        )
        return len(rows)

    async def run_now(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        rule = self._rule(db, project_id, automation_id)
        trigger_type = _metadata(rule).get("trigger_type")
        if trigger_type == "workflow":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Workflow automations can only run from a workflow stage",
            )
        definition = project_automation_execution._workflow_definition(rule)
        if definition is not None and definition.advancement_policy == "ai":
            from app.services.issue_execution_configuration import (
                project_automation_execution_config,
                require_coordinator_execution_config,
            )

            config = definition.execution_config
            if config is None or not config.is_complete():
                config = project_automation_execution_config(
                    db,
                    rule,
                    issue_creator_user_id=int(rule.created_by_user_id or user_id),
                )
            require_coordinator_execution_config(config)
        run = self._create_run(db, rule, "manual", utcnow())
        await project_automation_execution.dispatch(db, rule, run)
        return self._run_view(
            run,
            str(_metadata(rule).get("timezone") or "Asia/Shanghai"),
            _metadata(rule),
        )

    async def retry_run(
        self, db: Session, project_id: str, run_id: str, user_id: int
    ) -> dict:
        """Re-dispatch the same failed processor record for its existing task."""

        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or str(run.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation run not found")

        # A previous process may have written only the execution outcome. Repair
        # the aggregate before deciding whether this run is retryable.
        loop_item_execution_service.reconcile_automation_run_projection(
            db, run_id=run_id
        )
        db.expire_all()
        run = db.get(ProjectAutomationRun, run_id)
        if run is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation run not found")
        rule = self._rule(db, project_id, str(run.parent_id))
        try:
            run = await project_automation_processor.retry(
                db,
                run_id=str(run.id),
                requested_by_user_id=user_id,
            )
        except AutomationRunNotRetryable as exc:
            raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
        return self._run_view(
            run,
            str(_metadata(rule).get("timezone") or "Asia/Shanghai"),
            _metadata(rule),
        )

    def list_runs(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> list[dict]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Viewer)
        rule = self._rule(db, project_id, automation_id)
        timezone_name = str(_metadata(rule).get("timezone") or "Asia/Shanghai")
        rows = (
            db.query(ProjectAutomationRun)
            .filter(
                ProjectAutomationRun.parent_id == automation_id,
                loop_datetime_is_unset(ProjectAutomationRun.deleted_at),
            )
            .order_by(ProjectAutomationRun.created_at.desc())
            .limit(200)
            .all()
        )
        visible_rows = [row for row in rows if self._is_visible_run(row)][:100]
        repaired = (
            loop_item_execution_service.reconcile_terminal_automation_projections(
                db,
                run_ids=[str(row.id) for row in visible_rows],
                limit=len(visible_rows),
            )
        )
        if repaired:
            rows = (
                db.query(ProjectAutomationRun)
                .filter(
                    ProjectAutomationRun.parent_id == automation_id,
                    loop_datetime_is_unset(ProjectAutomationRun.deleted_at),
                )
                .order_by(ProjectAutomationRun.created_at.desc())
                .limit(200)
                .all()
            )
            visible_rows = [row for row in rows if self._is_visible_run(row)][:100]
        rule_metadata = _metadata(rule)
        return [
            self._run_view(row, timezone_name, rule_metadata) for row in visible_rows
        ]

    async def cancel_run(
        self, db: Session, project_id: str, run_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or str(run.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation run not found")
        return await self._cancel_single_run(db, run)

    async def _cancel_single_run(
        self,
        db: Session,
        run: ProjectAutomationRun,
    ) -> dict:
        run_id = str(run.id)
        if loop_item_execution_service.reconcile_automation_run_projection(
            db, run_id=run_id
        ):
            db.expire_all()
            run = db.get(ProjectAutomationRun, run_id)
            if run is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "Automation run not found"
                )
            return self._run_view_from_db(db, run)
        if run.status not in ACTIVE_RUN_STATUSES:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Automation run cannot be cancelled"
            )

        # An AI-managed run may retain the manager's Backend Task id after the
        # manager has selected a project robot. The selected robot is then the
        # only active executor, so always stop the active Wework execution
        # before considering the (already terminal) manager Task.
        execution = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.automation_run_id == str(run.id),
                LoopItemExecution.status.in_(ACTIVE_STATUSES),
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )
        if execution is not None:
            execution = loop_item_execution_service.cancel(
                db,
                execution_id=execution.id,
                note="Automation run cancelled by user",
            )
            if execution.status == "cancel_requested":
                from app.tasks.robot_queue_tasks import emit_runtime_cancels

                execution_id = execution.id
                db.expunge(execution)
                db.rollback()
                confirmed_execution_ids = await asyncio.to_thread(
                    emit_runtime_cancels,
                    [execution],
                )
                if execution_id not in confirmed_execution_ids:
                    raise HTTPException(
                        status.HTTP_502_BAD_GATEWAY,
                        "Runtime did not confirm cancellation",
                    )
            db.refresh(run)
            return self._run_view_from_db(db, run)

        if run.backend_task_id:
            from app.services.project_automation_managed_execution import (
                project_automation_managed_execution_service,
            )

            cancelled = await project_automation_managed_execution_service.cancel(
                task_id=int(run.backend_task_id),
                # Project authorization belongs to the requester, while the
                # canonical Wegent Task is owned by the rule creator. Runtime
                # cancellation must use that durable owner identity.
                user_id=run.created_by_user_id,
            )
            if not cancelled:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Managed automation execution could not be cancelled",
                )
            # Managed execution owns its durable Task lifecycle in independent
            # sessions. End this request session's read transaction before
            # loading the projection it just committed; expiring objects alone
            # still reads from the old MySQL REPEATABLE READ snapshot.
            db.rollback()
            run = db.get(ProjectAutomationRun, run_id)
            if run is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "Automation run not found"
                )
            return self._run_view_from_db(db, run)

        self._finish_cancelled_run(db, run)
        return self._run_view_from_db(db, run)

    @staticmethod
    def _run_timezone(db: Session, run: ProjectAutomationRun) -> str:
        rule = (
            db.get(ProjectAutomationRule, run.parent_id)
            if run.parent_id is not None
            else None
        )
        return (
            str(_metadata(rule).get("timezone") or "Asia/Shanghai")
            if rule is not None
            else "Asia/Shanghai"
        )

    @staticmethod
    def _finish_cancelled_run(db: Session, run: ProjectAutomationRun) -> None:
        if run.status == "cancelled":
            return
        run.status = "cancelled"
        run.version += 1
        project_automation_execution.finish_activity(
            db,
            run=run,
            status_value="cancelled",
            content="AI 托管任务已取消。",
        )
        db.commit()
        db.refresh(run)

    async def check_due(self, db: Session) -> int:
        now = utcnow()
        active_project = aliased(CloudProject)
        rule_ids = (
            db.query(ProjectAutomationRule.id)
            .join(
                active_project,
                active_project.id == ProjectAutomationRule.cloud_project_id,
            )
            .filter(
                active_project.status == "active",
                ProjectAutomationRule.status == "enabled",
                ProjectAutomationRule.due_at.isnot(None),
                ProjectAutomationRule.due_at <= now,
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .all()
        )
        dispatched = 0
        logger.info(
            "[ProjectAutomation] Due scan found %s candidate rule(s) at %s",
            len(rule_ids),
            now.isoformat(),
        )
        for (rule_id,) in rule_ids:
            rule = (
                db.query(ProjectAutomationRule)
                .filter(ProjectAutomationRule.id == rule_id)
                .with_for_update(skip_locked=True)
                .one_or_none()
            )
            if (
                rule is None
                or rule.status != "enabled"
                or rule.due_at is None
                or rule.due_at > now
                or not loop_datetime_value_is_unset(rule.deleted_at)
            ):
                continue
            rule_metadata = _metadata(rule)
            if rule_metadata.get("trigger_type") != "schedule":
                logger.info(
                    "[ProjectAutomation] Ignoring non-scheduled due rule=%s", rule.id
                )
                continue
            scheduled_for = rule.due_at
            try:
                next_at = _next_run(
                    str(rule_metadata.get("cron_expression") or ""),
                    str(rule_metadata.get("timezone") or "Asia/Shanghai"),
                    max(scheduled_for, now),
                )
            except HTTPException as exc:
                rule_metadata["schedule_error"] = str(exc.detail)
                rule.metadata_json = rule_metadata
                rule.status = "disabled"
                rule.version += 1
                db.commit()
                logger.error(
                    "[ProjectAutomation] Disabled invalid rule=%s error=%s",
                    rule.id,
                    exc.detail,
                )
                continue

            run = self._create_run(db, rule, "scheduled", scheduled_for, commit=False)
            rule.due_at = next_at
            rule_metadata["last_run_at"] = scheduled_for.isoformat()
            rule_metadata.pop("schedule_error", None)
            rule.metadata_json = rule_metadata
            rule.version += 1
            db.commit()
            db.refresh(run)
            await project_automation_execution.dispatch(db, rule, run)
            dispatched += 1
        return dispatched

    @staticmethod
    def _mark_deleted(
        db: Session,
        row: ProjectAutomationRule,
        *,
        user_id: int,
        deleted_at: datetime,
    ) -> None:
        row.deleted_at = deleted_at
        row.status = "disabled"
        row.due_at = loop_unset_datetime_for_connection(db.connection(), "due_at")
        row.updated_by_user_id = user_id
        row.version += 1

    @staticmethod
    def _rule(
        db: Session,
        project_id: str,
        automation_id: str,
        *,
        for_update: bool = False,
    ) -> ProjectAutomationRule:
        query = db.query(ProjectAutomationRule).filter(
            ProjectAutomationRule.id == automation_id
        )
        if for_update:
            query = query.with_for_update()
        row = query.one_or_none()
        if (
            row is None
            or str(row.cloud_project_id) != str(project_id)
            or not loop_datetime_value_is_unset(row.deleted_at)
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation not found")
        return row

    @staticmethod
    def _rule_view(
        db: Session,
        row: ProjectAutomationRule,
    ) -> dict:
        rule_metadata = _metadata(row)
        recent_run_rows = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.parent_id == row.id)
            .order_by(ProjectAutomationRun.created_at.desc())
            .limit(20)
            .all()
        )
        last_run_row = next(
            (
                run
                for run in recent_run_rows
                if ProjectAutomationService._is_visible_run(run)
            ),
            None,
        )
        last_run = rule_metadata.get("last_run_at")
        database_timezone = database_datetime_timezone(db)
        dispatch_target = rule_metadata.get("dispatch_target")
        if not isinstance(dispatch_target, dict):
            raise ValueError("Automation dispatch target is missing")
        return {
            "id": row.id,
            "project_id": str(row.cloud_project_id),
            "name": row.title or "",
            "prompt": row.description or "",
            "trigger_type": str(rule_metadata.get("trigger_type") or "schedule"),
            "event_type": rule_metadata.get("event_type"),
            "event_config": rule_metadata.get("event_config") or {},
            "cron_expression": rule_metadata.get("cron_expression"),
            "timezone": str(rule_metadata.get("timezone") or "Asia/Shanghai"),
            "execution_device_id": text(dispatch_target.get("execution_device_id")),
            "target_kind": str(dispatch_target["kind"]),
            "target_id": str(dispatch_target["id"]),
            "target_name": str(dispatch_target["name"]),
            "enabled": row.status == "enabled",
            "next_run_at": (
                None
                if loop_datetime_value_is_unset(row.due_at)
                else _utc_aware(row.due_at)
            ),
            "last_run_at": _utc_aware(
                datetime.fromisoformat(last_run) if last_run else None
            ),
            "last_run_status": last_run_row.status if last_run_row else None,
            "version": row.version,
            "created_at": _utc_aware(row.created_at, database_timezone),
            "updated_at": _utc_aware(row.updated_at, database_timezone),
        }

    @staticmethod
    def _validate_dispatch_target(
        db: Session,
        *,
        project_id: str,
        user_id: int,
        target_kind: str,
        target_id: str,
    ) -> dict[str, object]:
        if target_kind == "human":
            member = next(
                (
                    item
                    for item in cloud_project_service.list_members(
                        db, int(project_id), user_id
                    )
                    if str(item["user_id"]) == str(target_id)
                ),
                None,
            )
            if member is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Dispatch target is not a Project member",
                )
            return {
                "kind": "human",
                "id": str(target_id),
                "name": str(member["user_name"]),
            }
        if target_kind == "agent":
            agent = project_agent(db, project_id, target_id)
            return {
                "kind": "agent",
                "id": str(agent.id),
                "name": str(agent.title or agent.name or "AI"),
            }
        if target_kind == "collaboration_group":
            from app.services.workspaces import workspace_service

            group = next(
                (
                    item
                    for item in workspace_service.list_project_collaboration_groups(
                        db, int(project_id), user_id
                    )
                    if str(item["id"]) == str(target_id)
                ),
                None,
            )
            if group is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Collaboration group is not available in this Project",
                )
            return {
                "kind": "collaboration_group",
                "id": str(group["id"]),
                "name": str(group["name"]),
            }
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Unknown dispatch target kind",
        )

    @staticmethod
    def _run_view(
        row: ProjectAutomationRun,
        fallback_timezone: str = "Asia/Shanghai",
        rule_metadata: dict | None = None,
    ) -> dict:
        run_metadata = _metadata(row)
        automation_metadata = rule_metadata or {}
        trigger_type = text(automation_metadata.get("trigger_type")) or None
        event = run_metadata.get("event")
        event_type = (
            text(event.get("type"))
            if isinstance(event, dict)
            else text(automation_metadata.get("event_type"))
        )
        scheduled = run_metadata.get("scheduled_for")
        return {
            "id": row.id,
            "automation_id": row.parent_id,
            "project_id": str(row.cloud_project_id),
            "trigger": run_metadata.get("trigger") or row.source or "scheduled",
            "status": row.status,
            "timezone": str(run_metadata.get("timezone") or fallback_timezone),
            "scheduled_for": _utc_aware(
                datetime.fromisoformat(scheduled) if scheduled else row.created_at
            ),
            "expires_at": None,
            "task_id": row.task_id,
            "task_title": getattr(row, "task_title", None) or None,
            "backend_task_id": row.backend_task_id or None,
            "device_id": row.device_id or None,
            "error": (
                row.description if row.status == "failed" and row.description else None
            ),
            "created_at": _utc_aware(row.created_at),
            "updated_at": _utc_aware(row.updated_at),
            "completed_at": _utc_aware(row.completed_at),
            "retryable": row.status == "failed",
            "trigger_type": trigger_type,
            "event_type": event_type or None,
            "event_config": (
                automation_metadata.get("event_config")
                if trigger_type == "event"
                else None
            ),
        }

    @classmethod
    def _run_view_from_db(
        cls,
        db: Session,
        row: ProjectAutomationRun,
    ) -> dict:
        rule = (
            db.get(ProjectAutomationRule, row.parent_id)
            if row.parent_id is not None
            else None
        )
        return cls._run_view(
            row,
            cls._run_timezone(db, row),
            _metadata(rule) if rule is not None else None,
        )

    @staticmethod
    def _is_visible_run(row: ProjectAutomationRun) -> bool:
        return not text(_metadata(row).get("workflow_parent_run_id"))

    @staticmethod
    def _create_run(
        db: Session,
        rule: ProjectAutomationRule,
        trigger: str,
        scheduled_for: datetime,
        *,
        public_id: str | None = None,
        commit: bool = True,
    ) -> ProjectAutomationRun:
        row = ProjectAutomationRun(
            public_id=public_id,
            cloud_project_id=rule.cloud_project_id,
            parent_id=rule.id,
            assignee_agent_id=rule.assignee_agent_id,
            source=trigger,
            status="pending",
            due_at=None,
            created_by_user_id=rule.created_by_user_id,
            metadata_json={
                "trigger": trigger,
                "timezone": str(_metadata(rule).get("timezone") or "Asia/Shanghai"),
                "scheduled_for": scheduled_for.isoformat(),
                "error": None,
            },
        )
        db.add(row)
        if commit:
            db.commit()
            db.refresh(row)
        else:
            db.flush()
        return row


project_automation_service = ProjectAutomationService()
project_automation_processor = ProjectAutomationProcessor(
    project_automation_service._create_run
)

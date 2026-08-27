# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project automation rule CRUD, run records, and schedule scanning."""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, aliased

from app.core.project_automation_secrets import encrypt_webhook_secret
from app.db.timezone import database_datetime_timezone
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
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
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.project_automation_domain import (
    ProjectAutomationEvent,
    assignment_mode,
    integer,
    manager_type,
)
from app.services.project_automation_domain import metadata as _metadata
from app.services.project_automation_domain import next_run as _next_run
from app.services.project_automation_domain import (
    role_config,
    runtime_config,
    text,
)
from app.services.project_automation_domain import utc_aware as _utc_aware
from app.services.project_automation_domain import (
    utcnow,
    validate_assignment,
    validate_trigger,
)
from app.services.project_automation_execution import (
    AutomationRunNotRetryable,
    ProjectAutomationProcessor,
    project_automation_execution,
)
from app.services.project_chat.service import bot_config
from app.services.share import team_share_service
from app.services.workflow_stage_context import workflow_stage_context_resolver

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
    return config


class ProjectAutomationService:
    """Own project automation rules, schedules, and persisted run records."""

    def list(self, db: Session, project_id: str, user_id: int) -> list[dict]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
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
        row, webhook_secret = self._create_rule(
            db,
            project_id=project_id,
            user_id=user_id,
            values=values,
        )
        db.commit()
        db.refresh(row)
        return self._rule_view(db, row, webhook_secret=webhook_secret)

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
        row, webhook_secret = self._create_rule(
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
            "automation": self._rule_view(
                db,
                row,
                webhook_secret=webhook_secret,
            ),
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
    ) -> tuple[ProjectAutomationRule, str | None]:
        configured_mode = values.assignment_mode
        configured_manager = values.manager_type
        role_source = values.role_source
        validate_assignment(
            db,
            project_id=project_id,
            user_id=user_id,
            mode=configured_mode,
            manager=configured_manager,
            agent_id=values.agent_id,
            wegent_team_id=values.wegent_team_id,
            model=values.model,
            environment=values.execution_environment,
            device_id=values.execution_device_id,
            role_source=role_source,
        )
        self._validate_runtime_strategy(
            db,
            project_id=project_id,
            user_id=user_id,
            trigger_type=values.trigger_type,
            assignment_mode=configured_mode,
            manager_type=configured_manager,
            role_source=role_source,
            agent_id=values.agent_id,
            runtime_source=values.runtime_source,
            runtime_profile_id=values.runtime_profile_id,
            runtime_user_id=values.runtime_user_id,
        )
        validate_trigger(values.trigger_type, values.event_type, values.cron_expression)
        now = utcnow()
        next_run_at = (
            _next_run(str(values.cron_expression), values.timezone, now)
            if values.trigger_type == "schedule"
            else None
        )
        webhook_secret = (
            secrets.token_urlsafe(32) if values.trigger_type == "event" else None
        )
        row = ProjectAutomationRule(
            cloud_project_id=project_id,
            title=values.name,
            description=values.prompt,
            assignee_agent_id=(
                str(values.agent_id)
                if configured_mode == "manual" and values.agent_id
                else ""
            ),
            status="enabled" if values.enabled else "disabled",
            due_at=next_run_at if values.enabled else None,
            created_by_user_id=user_id,
            updated_by_user_id=user_id,
            metadata_json=self._assignment_metadata(
                assignment_mode=configured_mode,
                manager_type=configured_manager,
                wegent_team_id=values.wegent_team_id,
                model=values.model,
                environment=values.execution_environment,
                device_id=values.execution_device_id,
                agent_id=values.agent_id,
                role_source=role_source,
                runtime_source=values.runtime_source,
                runtime_profile_id=values.runtime_profile_id,
                runtime_user_id=values.runtime_user_id,
                base={
                    "trigger_type": values.trigger_type,
                    "event_type": (
                        values.event_type if values.trigger_type == "event" else None
                    ),
                    "event_config": _canonical_event_config(
                        values.event_type if values.trigger_type == "event" else None,
                        values.event_config,
                    ),
                    "webhook_secret_encrypted": None,
                    "cron_expression": (
                        values.cron_expression
                        if values.trigger_type == "schedule"
                        else None
                    ),
                    "timezone": values.timezone,
                    "last_run_at": None,
                },
            ),
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
        if webhook_secret:
            row_metadata = _metadata(row)
            row_metadata["webhook_secret_encrypted"] = encrypt_webhook_secret(
                webhook_secret,
                project_id=project_id,
                automation_id=str(row.id),
            )
            row.metadata_json = row_metadata
        return row, webhook_secret

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
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"Invalid automation workflow definition: {exc}",
            ) from exc

    def update(
        self,
        db: Session,
        project_id: str,
        automation_id: str,
        user_id: int,
        values: ProjectAutomationUpdate,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
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

        if values.assignment_mode is None:
            configured_mode = assignment_mode(rule_metadata)
            configured_manager = manager_type(rule_metadata)
            agent_id = row.assignee_agent_id or None
            manager = rule_metadata.get("manager")
            manager_config = dict(manager) if isinstance(manager, dict) else {}
            wegent_team_id = integer(manager_config.get("wegent_team_id"))
            model = None
            environment = None
            device_id = None
        else:
            configured_mode = values.assignment_mode
            configured_manager = values.manager_type
            agent_id = values.agent_id
            wegent_team_id = values.wegent_team_id
            model = values.model
            environment = values.execution_environment
            device_id = values.execution_device_id
        current_role = role_config(rule_metadata)
        current_runtime = runtime_config(rule_metadata)
        role_source = values.role_source or str(current_role.get("source") or "agent")
        runtime_source = values.runtime_source or str(
            current_runtime.get("source") or "agent_default"
        )
        runtime_profile_id = (
            values.runtime_profile_id
            if "runtime_profile_id" in values.model_fields_set
            else text(current_runtime.get("runtime_profile_id"))
        )
        runtime_user_id = (
            values.runtime_user_id
            if "runtime_user_id" in values.model_fields_set
            else integer(current_runtime.get("user_id"))
        )

        validate_assignment(
            db,
            project_id=project_id,
            user_id=row.created_by_user_id,
            mode=configured_mode,
            manager=configured_manager,
            agent_id=agent_id,
            wegent_team_id=wegent_team_id,
            model=model,
            environment=environment,
            device_id=device_id,
            role_source=role_source,
        )
        self._validate_runtime_strategy(
            db,
            project_id=project_id,
            user_id=row.created_by_user_id,
            trigger_type=trigger_type,
            assignment_mode=configured_mode,
            manager_type=configured_manager,
            role_source=role_source,
            agent_id=agent_id,
            runtime_source=runtime_source,
            runtime_profile_id=runtime_profile_id,
            runtime_user_id=runtime_user_id,
        )
        row.assignee_agent_id = (
            str(agent_id) if configured_mode == "manual" and agent_id else ""
        )
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
        rule_metadata.update(
            {
                "trigger_type": trigger_type,
                "event_type": event_type,
                "event_config": event_config,
                "cron_expression": expression,
                "timezone": timezone_name,
            }
        )
        row.metadata_json = self._bind_self_managed_workflow(
            self._assignment_metadata(
                assignment_mode=configured_mode,
                manager_type=configured_manager,
                wegent_team_id=wegent_team_id,
                model=model,
                environment=environment,
                device_id=device_id,
                agent_id=agent_id,
                role_source=role_source,
                runtime_source=runtime_source,
                runtime_profile_id=runtime_profile_id,
                runtime_user_id=runtime_user_id,
                base=rule_metadata,
            ),
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

    def rotate_webhook_secret(
        self,
        db: Session,
        project_id: str,
        automation_id: str,
        user_id: int,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Maintainer)
        row = self._rule(db, project_id, automation_id, for_update=True)
        rule_metadata = _metadata(row)
        if rule_metadata.get("trigger_type") != "event":
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Only event automations have webhook secrets",
            )
        webhook_secret = secrets.token_urlsafe(32)
        rule_metadata["webhook_secret_encrypted"] = encrypt_webhook_secret(
            webhook_secret,
            project_id=project_id,
            automation_id=str(row.id),
        )
        row.metadata_json = rule_metadata
        row.updated_by_user_id = user_id
        row.version += 1
        db.commit()
        db.refresh(row)
        return self._rule_view(db, row, webhook_secret=webhook_secret)

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
        run = self._create_run(db, rule, "manual", utcnow())
        await project_automation_execution.dispatch(db, rule, run)
        return self._run_view(
            run, str(_metadata(rule).get("timezone") or "Asia/Shanghai")
        )

    async def run_for_workflow_node(
        self,
        db: Session,
        project_id: str,
        automation_id: str,
        item_id: str,
        workflow_node_id: str,
        user_id: int,
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        rule = self._rule(db, project_id, automation_id)
        item = (
            db.query(LoopItem).filter(LoopItem.id == item_id).with_for_update().first()
        )
        if item is None or str(item.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        workflow = (
            item.metadata_json.get("workflow")
            if isinstance(item.metadata_json, dict)
            else None
        )
        nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        node = next(
            (
                candidate
                for candidate in nodes or []
                if isinstance(candidate, dict)
                and candidate.get("id") == workflow_node_id
            ),
            None,
        )
        if node is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow node not found")
        if not node.get("automation_rule_id"):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Workflow stage has no automation",
            )
        if node.get("status") not in {"ready", "failed"}:
            raise HTTPException(status.HTTP_409_CONFLICT, "Workflow node is not ready")
        if node.get("automation_rule_id") != automation_id:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Workflow node automation does not match",
            )
        from app.schemas.issue_workflow import (
            IssueWorkflowInstance,
            WorkflowNodeInstance,
        )

        workflow_snapshot = IssueWorkflowInstance.model_validate(workflow)
        node_snapshot = WorkflowNodeInstance.model_validate(node)
        execution_config = workflow_snapshot.execution_config_for(node_snapshot)
        if execution_config is None or not execution_config.is_complete():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Workflow execution configuration is incomplete",
            )
        run = self._create_run(db, rule, "manual", utcnow(), commit=False)
        run.task_id = item.id
        run.task_title = item.title or ""
        run.metadata_json = {
            **(run.metadata_json or {}),
            "workflow_parent_run_id": self._workflow_parent_run_id(item),
            "workflow_node_id": workflow_node_id,
            "instruction_override": str(node.get("prompt") or ""),
            "dependency_context": node.get("dependency_context") or {},
            "workflow_execution_config": execution_config.model_dump(
                mode="json", by_alias=True
            ),
            "workflow_stage_input": workflow_stage_context_resolver.resolve(
                db,
                item=item,
                target_node_id=workflow_node_id,
            ),
        }
        from app.services.project_workflow_projection import update_workflow_node

        update_workflow_node(
            db,
            item_id=item.id,
            node_id=workflow_node_id,
            node_status="queued",
            automation_run_id=str(run.id),
        )
        db.commit()
        db.refresh(run)
        await project_automation_execution.dispatch(db, rule, run)
        return self._run_view(
            run, str(_metadata(rule).get("timezone") or "Asia/Shanghai")
        )

    async def run_ai_workflow_manager(
        self,
        db: Session,
        *,
        project_id: str,
        automation_id: str,
        item: LoopItem,
        workflow_run_id: str,
        workflow_plan_version: int | None,
        user_id: int,
        coordinator_prompt: str,
        execution_config: dict | None,
    ) -> dict:
        """Run one workflow manager without re-entering its parent flow."""

        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        rule = self._rule(db, project_id, automation_id)
        run = self._create_run(db, rule, "event", utcnow(), commit=False)
        run.task_id = item.id
        run.task_title = item.title or ""
        run.metadata_json = {
            **(run.metadata_json or {}),
            "bypass_workflow_definition": True,
            "workflow_parent_run_id": self._workflow_parent_run_id(item),
            "instruction_override": coordinator_prompt,
            "event": {
                "type": "task.created",
                "source": "workflow",
                "subject_id": str(item.id),
                "actor_user_id": user_id,
                "payload": {
                    "id": str(item.id),
                    "title": item.title,
                    "description": item.description,
                    "status": item.status,
                    "priority": item.priority,
                    "workflow_run_id": workflow_run_id,
                    "workflow_plan_version": workflow_plan_version,
                    "execution_config": execution_config,
                },
            },
            "workflow_execution_config": execution_config,
        }
        db.commit()
        db.refresh(run)
        await project_automation_execution.dispatch(db, rule, run)
        return self._run_view(
            run,
            str(_metadata(rule).get("timezone") or "Asia/Shanghai"),
        )

    @staticmethod
    def _workflow_parent_run_id(item: LoopItem) -> str | None:
        item_metadata = (
            item.metadata_json if isinstance(item.metadata_json, dict) else {}
        )
        binding = item_metadata.get("workflow_automation")
        if not isinstance(binding, dict):
            return None
        return text(binding.get("run_id")) or None

    async def run_direct_workflow_node(
        self,
        db: Session,
        project_id: str,
        item_id: str,
        workflow_node_id: str,
        user_id: int,
    ) -> dict:
        """Run a workflow stage from its snapshotted Runtime configuration."""

        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        item = (
            db.query(LoopItem).filter(LoopItem.id == item_id).with_for_update().first()
        )
        if item is None or str(item.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        workflow = (
            item.metadata_json.get("workflow")
            if isinstance(item.metadata_json, dict)
            else None
        )
        nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        node = next(
            (
                candidate
                for candidate in nodes or []
                if isinstance(candidate, dict)
                and candidate.get("id") == workflow_node_id
            ),
            None,
        )
        if node is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Workflow node not found")
        if node.get("automation_rule_id"):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Workflow stage is bound to an automation rule",
            )
        if node.get("status") not in {"ready", "failed"}:
            raise HTTPException(status.HTTP_409_CONFLICT, "Workflow node is not ready")

        from app.schemas.issue_workflow import (
            IssueWorkflowInstance,
            WorkflowNodeInstance,
        )

        workflow_snapshot = IssueWorkflowInstance.model_validate(workflow)
        node_snapshot = WorkflowNodeInstance.model_validate(node)
        execution_config = workflow_snapshot.execution_config_for(node_snapshot)
        if execution_config is None or not execution_config.is_complete():
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Workflow execution configuration is incomplete",
            )
        if execution_config.agent_id:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Robot preset workflow execution requires an automation rule",
            )

        scheduled_for = utcnow()
        run = ProjectAutomationRun(
            cloud_project_id=project_id,
            parent_id=item.id,
            task_id=item.id,
            task_title=item.title or "",
            source="workflow",
            status="pending",
            created_by_user_id=user_id,
            metadata_json={
                "trigger": "workflow",
                "scheduled_for": scheduled_for.isoformat(),
                "workflow_parent_run_id": self._workflow_parent_run_id(item),
                "workflow_node_id": workflow_node_id,
                "workflow_node_name": str(node.get("name") or ""),
                "instruction_override": str(node.get("prompt") or ""),
                "dependency_context": node.get("dependency_context") or {},
                "workflow_execution_config": execution_config.model_dump(
                    mode="json", by_alias=True
                ),
                "workflow_stage_input": workflow_stage_context_resolver.resolve(
                    db,
                    item=item,
                    target_node_id=workflow_node_id,
                ),
            },
        )
        db.add(run)
        db.flush()
        run_metadata = dict(run.metadata_json or {})
        workspace_binding = execution_config.workspace_binding
        runtime_subject_user_id = user_id
        runtime_profile = None
        if execution_config.runtime_profile_id:
            from app.services.runtime_profiles import runtime_profile_service

            runtime_profile = runtime_profile_service.require_owned(
                db,
                execution_config.runtime_profile_id,
                user_id,
            )
            runtime_subject_user_id = int(runtime_profile.user_id or user_id)
        context = {
            "run_id": str(run.id),
            "trigger": "workflow",
            "runtime_source": (
                "fixed_profile"
                if execution_config.runtime_profile_id
                else "runtime_user"
            ),
            "runtime_profile_id": execution_config.runtime_profile_id,
            "runtime_subject_user_id": runtime_subject_user_id,
            "execution_device_id": execution_config.execution_device_id,
            "model": execution_config.model,
            "model_type": execution_config.model_type,
            "model_options": execution_config.model_options,
            "workspace_binding": (
                workspace_binding.model_dump(mode="json", by_alias=True)
                if workspace_binding
                else None
            ),
            "workflow_stage_input": run_metadata.get("workflow_stage_input"),
            **execution_config.runtime_request_options(),
        }
        execution = loop_item_execution_service.enqueue_generic_robot(
            db,
            loop_item_id=str(item.id),
            cloud_project_id=str(project_id),
            runtime_subject_user_id=runtime_subject_user_id,
            runtime_profile=runtime_profile,
            execution_device_id=execution_config.execution_device_id,
            model=execution_config.model,
            model_type=execution_config.model_type,
            model_options=execution_config.model_options,
            assigner_user_id=user_id,
            priority=item.priority or "medium",
            automation_context=context,
        )
        run.device_id = execution.execution_device_id
        run.status = (
            "waiting_device" if execution.status == "waiting_runtime" else "queued"
        )
        run.version += 1
        from app.services.project_workflow_projection import update_workflow_node

        update_workflow_node(
            db,
            item_id=item.id,
            node_id=workflow_node_id,
            node_status="queued",
            automation_run_id=str(run.id),
        )
        db.commit()
        db.refresh(run)
        logger.info(
            "[ProjectAutomation] Queued direct workflow run=%s execution=%s "
            "item=%s node=%s device=%s",
            run.id,
            execution.id,
            item.id,
            workflow_node_id,
            execution.execution_device_id,
        )
        return {
            "id": str(run.id),
            "status": run.status,
            "execution_id": execution.id,
        }

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
            run, str(_metadata(rule).get("timezone") or "Asia/Shanghai")
        )

    def list_runs(
        self, db: Session, project_id: str, automation_id: str, user_id: int
    ) -> list[dict]:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Reporter)
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
        from app.services.project_workflow_projection import (
            reconcile_workflow_automation_run,
        )

        workflow_repaired = False
        for row in visible_rows:
            if reconcile_workflow_automation_run(db, row):
                workflow_repaired = True
        if workflow_repaired:
            db.commit()
            db.expire_all()
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
        return [self._run_view(row, timezone_name) for row in visible_rows]

    async def cancel_run(
        self, db: Session, project_id: str, run_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, project_id, user_id, BaseRole.Developer)
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or str(run.cloud_project_id) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Automation run not found")
        if loop_item_execution_service.reconcile_automation_run_projection(
            db, run_id=run_id
        ):
            db.expire_all()
            run = db.get(ProjectAutomationRun, run_id)
            if run is None:
                raise HTTPException(
                    status.HTTP_404_NOT_FOUND, "Automation run not found"
                )
            rule = (
                db.get(ProjectAutomationRule, run.parent_id)
                if run.parent_id is not None
                else None
            )
            timezone_name = (
                str(_metadata(rule).get("timezone") or "Asia/Shanghai")
                if rule is not None
                else "Asia/Shanghai"
            )
            return self._run_view(run, timezone_name)
        if run.status not in {"pending", "queued", "waiting_device", "running"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Automation run cannot be cancelled"
            )

        rule = (
            db.get(ProjectAutomationRule, run.parent_id)
            if run.parent_id is not None
            else None
        )
        timezone_name = (
            str(_metadata(rule).get("timezone") or "Asia/Shanghai")
            if rule is not None
            else "Asia/Shanghai"
        )
        # An AI-managed run may retain the manager's Backend Task id after the
        # manager has selected a project robot. The selected robot is then the
        # only active executor, so always stop the active Wework execution
        # before considering the (already terminal) manager Task.
        execution = (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.automation_run_id == str(run.id),
                LoopItemExecution.status.in_(
                    [
                        "pending_approval",
                        "queued",
                        "claimed",
                        "running",
                        "cancel_requested",
                    ]
                ),
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
            return self._run_view(run, timezone_name)

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
            return self._run_view(run, timezone_name)

        run.status = "cancelled"
        run.version += 1
        from app.services.project_workflow_projection import (
            sync_automation_workflow_node,
        )

        sync_automation_workflow_node(db, run)
        project_automation_execution.finish_activity(
            db,
            run=run,
            status_value="cancelled",
            content="AI 托管任务已取消。",
        )
        db.commit()
        db.refresh(run)
        return self._run_view(run, timezone_name)

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
    def _assignment_metadata(
        *,
        assignment_mode: str,
        manager_type: str | None,
        wegent_team_id: int | None,
        model: str | None,
        environment: str | None,
        device_id: str | None,
        agent_id: str | None,
        role_source: str,
        runtime_source: str,
        runtime_profile_id: str | None,
        runtime_user_id: int | None,
        base: dict,
    ) -> dict:
        rule_metadata = dict(base)
        for key in (
            "assignment_mode",
            "manager_type",
            "wegent_team_id",
            "role",
            "runtime",
            "action",
            "manager",
        ):
            rule_metadata.pop(key, None)
        rule_metadata["action"] = (
            "execute" if assignment_mode == "manual" else "ai_assign"
        )
        rule_metadata["role"] = {
            "source": role_source,
            "agent_id": agent_id if role_source == "agent" else None,
        }
        rule_metadata["runtime"] = {
            "source": runtime_source,
            "runtime_profile_id": (
                runtime_profile_id if runtime_source == "fixed_profile" else None
            ),
            "user_id": runtime_user_id if runtime_source == "runtime_user" else None,
        }
        if assignment_mode == "ai_managed" and manager_type == "custom":
            rule_metadata["manager"] = {"type": "custom"}
        elif assignment_mode == "ai_managed" and manager_type == "wegent":
            rule_metadata["manager"] = {
                "type": "wegent",
                "wegent_team_id": wegent_team_id,
            }
        return rule_metadata

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
        *,
        webhook_secret: str | None = None,
    ) -> dict:
        rule_metadata = _metadata(row)
        configured_mode = assignment_mode(rule_metadata)
        configured_manager = manager_type(rule_metadata)
        role = role_config(rule_metadata)
        runtime = runtime_config(rule_metadata)
        agent = (
            db.get(ProjectChatAgent, row.assignee_agent_id)
            if configured_mode == "manual" and row.assignee_agent_id
            else None
        )
        manager = rule_metadata.get("manager")
        team_id = integer(
            manager.get("wegent_team_id") if isinstance(manager, dict) else None
        )
        team = None
        if configured_manager == "wegent" and team_id is not None:
            team = team_share_service.get_resource(
                db, team_id, int(row.created_by_user_id or 0)
            )
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
        config = bot_config(agent) if agent else {}
        if configured_mode == "manual":
            display_name = str(agent.title or agent.name or "AI") if agent else "AI"
            environment = str(config.get("execution_environment") or "local")
            device_id = text(config.get("execution_device_id"))
            model = text(config.get("model"))
        elif configured_manager == "custom":
            display_name = "自定义 AI 调度员"
            environment = "local"
            device_id = None
            model = None
        else:
            display_name = (
                str(team.name or "Wegent 智能体") if team else "Wegent 智能体"
            )
            environment = "managed"
            device_id = None
            model = None
        last_run = rule_metadata.get("last_run_at")
        database_timezone = database_datetime_timezone(db)
        return {
            "id": row.id,
            "project_id": str(row.cloud_project_id),
            "name": row.title or "",
            "prompt": row.description or "",
            "trigger_type": str(rule_metadata.get("trigger_type") or "schedule"),
            "event_type": rule_metadata.get("event_type"),
            "event_config": rule_metadata.get("event_config") or {},
            "assignment_mode": configured_mode,
            "manager_type": configured_manager,
            "webhook_event_id": (
                row.id if rule_metadata.get("trigger_type") == "event" else None
            ),
            "webhook_secret": webhook_secret,
            "cron_expression": rule_metadata.get("cron_expression"),
            "timezone": str(rule_metadata.get("timezone") or "Asia/Shanghai"),
            "agent_id": row.assignee_agent_id or None,
            "wegent_team_id": team_id,
            "model": model,
            "agent_name": display_name,
            "execution_environment": environment,
            "execution_device_id": device_id,
            "role_source": str(role.get("source") or "agent"),
            "runtime_source": str(runtime.get("source") or "agent_default"),
            "runtime_profile_id": text(runtime.get("runtime_profile_id")),
            "runtime_user_id": integer(runtime.get("user_id")),
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
    def _validate_runtime_strategy(
        db: Session,
        *,
        project_id: str,
        user_id: int,
        trigger_type: str,
        assignment_mode: str,
        manager_type: str | None,
        role_source: str,
        agent_id: str | None,
        runtime_source: str,
        runtime_profile_id: str | None,
        runtime_user_id: int | None,
    ) -> None:
        if assignment_mode == "ai_managed" and manager_type == "wegent":
            return
        if runtime_source == "issue_creator":
            if trigger_type == "schedule":
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Scheduled automation cannot use the Issue creator Runtime",
                )
            return
        if runtime_source == "agent_default":
            if role_source != "agent" or not agent_id:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Agent default Runtime requires a robot role",
                )
            return
        if runtime_source == "fixed_profile":
            if not runtime_profile_id:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Fixed Runtime profile is required",
                )
            from app.services.runtime_profiles import runtime_profile_service

            runtime_profile_service.require_owned(db, runtime_profile_id, user_id)
            return
        if runtime_source == "runtime_user":
            member_ids = {
                int(member["user_id"])
                for member in cloud_project_service.list_members(
                    db, int(project_id), user_id
                )
            }
            if runtime_user_id not in member_ids:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Runtime user is not a project member",
                )
            return
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Unknown Runtime source",
        )

    @staticmethod
    def _run_view(
        row: ProjectAutomationRun,
        fallback_timezone: str = "Asia/Shanghai",
    ) -> dict:
        run_metadata = _metadata(row)
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
        }

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
        commit: bool = True,
    ) -> ProjectAutomationRun:
        row = ProjectAutomationRun(
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

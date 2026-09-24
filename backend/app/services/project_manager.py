# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Configuration and dispatch for a project-scoped AI manager."""

from __future__ import annotations

import uuid

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    loop_datetime_is_unset,
)
from app.models.loop_item_execution import LoopItemExecution
from app.schemas.base_role import BaseRole, has_permission
from app.schemas.delivery import LoopItemUpdate
from app.schemas.project_automation import ProjectAutomationCreate
from app.schemas.project_chat import LoopItemAssign
from app.schemas.project_manager import ProjectManagerConfig, ProjectManagerTrigger
from app.services.cloud_projects.access import require_cloud_project_role
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_domain import metadata, utcnow
from app.services.project_automations import project_automation_service

CONFIG_KEY = "project_manager"


def _config(project: CloudProject) -> dict:
    project_metadata = project.metadata_json or {}
    value = project_metadata.get(CONFIG_KEY)
    return dict(value) if isinstance(value, dict) else {}


def is_project_manager_rule(rule: ProjectAutomationRule) -> bool:
    return metadata(rule).get("project_manager") is True


def _tags_overlap(left: list[str], right: list[str]) -> bool:
    return not left or not right or bool(set(left).intersection(right))


class ProjectManagerService:
    @staticmethod
    def lock_run(db: Session, run: ProjectAutomationRun) -> ProjectAutomationRun:
        return (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.id == run.id)
            .populate_existing()
            .with_for_update()
            .one()
        )

    def check_automation_conflict(
        self,
        db: Session,
        project_id: str,
        event_type: str | None,
        event_config: dict,
    ) -> None:
        if event_type not in {"task.created", "task.tag_added", "task.status_changed"}:
            return
        project = db.get(CloudProject, int(project_id))
        config = _config(project) if project else {}
        if not config.get("enabled"):
            return
        tags = event_config.get("tags") or []
        for trigger in config.get("triggers") or []:
            if (
                trigger.get("enabled", True)
                and trigger.get("kind") == "event"
                and trigger.get("event_type") == event_type
                and _tags_overlap(trigger.get("tags") or [], tags)
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Automation overlaps a project manager trigger",
                )

    def require_run(
        self, db: Session, project_id: str, run_id: str, user_id: int
    ) -> ProjectAutomationRun:
        run = db.get(ProjectAutomationRun, run_id)
        rule = db.get(ProjectAutomationRule, run.parent_id) if run else None
        project = db.get(CloudProject, int(project_id))
        config = _config(project) if project else {}
        if (
            run is None
            or rule is None
            or not is_project_manager_rule(rule)
            or str(run.cloud_project_id) != str(project_id)
            or run.created_by_user_id != user_id
            or not config.get("enabled")
            or str(rule.id) not in (config.get("automation_ids") or [])
            or run.status
            not in {"pending", "queued", "running", "waiting_runtime", "waiting_device"}
        ):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Project manager run is unavailable"
            )
        return run

    @staticmethod
    def require_write(run: ProjectAutomationRun | None) -> None:
        if run is not None and metadata(run).get("read_only"):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "This manager conversation is read-only"
            )

    @staticmethod
    def record_action(
        db: Session,
        run: ProjectAutomationRun,
        *,
        kind: str,
        item_id: str,
        before: dict | None,
        after: dict | None,
    ) -> dict:
        run = ProjectManagerService.lock_run(db, run)
        action = {
            "id": str(uuid.uuid4()),
            "kind": kind,
            "item_id": item_id,
            "status": "executed",
            "before": before,
            "after": after,
            "created_at": utcnow().isoformat(),
        }
        values = metadata(run)
        values["manager_actions"] = [*values.get("manager_actions", []), action]
        run.metadata_json = values
        run.version += 1
        db.commit()
        return action

    @staticmethod
    def propose_change(
        db: Session,
        run: ProjectAutomationRun,
        *,
        kind: str,
        item_id: str,
        item_version: int,
        approver_user_id: int | None,
        payload: dict,
    ) -> dict:
        run = ProjectManagerService.lock_run(db, run)
        action = {
            "id": str(uuid.uuid4()),
            "kind": kind,
            "item_id": item_id,
            "item_version": item_version,
            "approver_user_id": approver_user_id,
            "status": "pending_confirmation",
            "payload": payload,
            "created_at": utcnow().isoformat(),
        }
        values = metadata(run)
        values["manager_actions"] = [*values.get("manager_actions", []), action]
        run.metadata_json = values
        run.version += 1
        db.commit()
        return action

    def decide_change(
        self,
        db: Session,
        *,
        project_id: str,
        run_id: str,
        action_id: str,
        user_id: int,
        approve: bool,
        version: int,
    ) -> dict:
        run = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.id == run_id)
            .with_for_update()
            .one_or_none()
        )
        rule = db.get(ProjectAutomationRule, run.parent_id) if run else None
        if (
            run is None
            or rule is None
            or not is_project_manager_rule(rule)
            or str(run.cloud_project_id) != str(project_id)
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Manager action not found")
        actions = list(metadata(run).get("manager_actions") or [])
        index = next(
            (
                position
                for position, action in enumerate(actions)
                if action.get("id") == action_id
            ),
            None,
        )
        if index is None or actions[index].get("status") != "pending_confirmation":
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Manager action is not pending"
            )
        action = dict(actions[index])
        if not approve:
            approver_id = action.get("approver_user_id")
            if action["kind"] == "assign" or approver_id is None:
                require_cloud_project_role(
                    db, int(project_id), user_id, BaseRole.Maintainer
                )
            elif int(approver_id) != user_id:
                raise HTTPException(
                    status.HTTP_403_FORBIDDEN, "Issue owner must confirm"
                )
            action["status"] = "rejected"
            action["decided_by_user_id"] = user_id
            action["decided_at"] = utcnow().isoformat()
            actions[index] = action
            run.metadata_json = {**metadata(run), "manager_actions": actions}
            run.version += 1
            db.commit()
            return action
        project = db.get(CloudProject, int(project_id))
        external = project is not None and project.task_provider in {"github", "gitlab"}
        item = None if external else db.get(LoopItem, action["item_id"])
        if external:
            current = external_loop_item_provider.get(db, action["item_id"], user_id)
        elif item is not None:
            current = {
                "id": item.id,
                "cloud_project_id": item.cloud_project_id,
                "version": item.version,
                "assignee_user_id": item.assignee_user_id,
            }
        else:
            current = None
        if current is None or str(current.get("cloud_project_id")) != str(project_id):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Issue not found")
        if int(current["version"]) != version or version != action["item_version"]:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Issue changed since proposal"
            )
        assignee_id = current.get("assignee_user_id")
        if action["kind"] == "assign" or not assignee_id:
            require_cloud_project_role(
                db, int(project_id), user_id, BaseRole.Maintainer
            )
        elif int(assignee_id) != user_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Issue owner must confirm")
        if approve:
            if action["kind"] == "assign":
                assignment = LoopItemAssign(
                    version=version,
                    assignee_type=action["payload"]["assignee_type"],
                    assignee_id=action["payload"]["assignee_id"],
                    trigger="automation",
                )
                if external:
                    external_loop_item_provider.assign(
                        db, action["item_id"], user_id, assignment
                    )
                else:
                    loop_item_service.assign(
                        db,
                        project_id=int(project_id),
                        item_id=action["item_id"],
                        user_id=user_id,
                        values=assignment,
                        commit=False,
                    )
            else:
                update = LoopItemUpdate.model_validate(
                    {"version": version, **action["payload"]}
                )
                operator_user_id = int(run.created_by_user_id or user_id)
                if external:
                    external_loop_item_provider.update(
                        db, action["item_id"], operator_user_id, update
                    )
                else:
                    loop_item_service.update(
                        db,
                        action["item_id"],
                        operator_user_id,
                        update,
                        commit=False,
                    )
        action["status"] = "executed" if approve else "rejected"
        action["decided_by_user_id"] = user_id
        action["decided_at"] = utcnow().isoformat()
        actions[index] = action
        run.metadata_json = {**metadata(run), "manager_actions": actions}
        run.version += 1
        db.commit()
        if approve and action["kind"] == "assign" and not external and item is not None:
            if action["payload"]["assignee_type"] == "agent":
                from app.services.board_team_execution import (
                    schedule_board_robot_execution,
                )
                from app.services.loop_item_executions.wake import wake_robot_creator

                agent = db.get(ProjectChatAgent, item.assignee_agent_id)
                if agent is not None:
                    execution = (
                        db.query(LoopItemExecution)
                        .filter(
                            LoopItemExecution.loop_item_id == item.id,
                            LoopItemExecution.agent_id == agent.id,
                            LoopItemExecution.status == "queued",
                        )
                        .order_by(LoopItemExecution.id.desc())
                        .first()
                    )
                    if execution is not None:
                        schedule_board_robot_execution(db, execution)
                    if agent.created_by_user_id:
                        wake_robot_creator(
                            user_id=agent.created_by_user_id,
                            project_id=str(project_id),
                            agent_id=agent.id,
                        )
        return action

    def get(self, db: Session, project_id: str, user_id: int) -> dict:
        project = require_cloud_project_role(
            db, int(project_id), user_id, BaseRole.Reporter
        ).project
        config = _config(project)
        return {
            "project_id": str(project.id),
            "version": project.version,
            "enabled": bool(config.get("enabled")),
            "agent_id": str(config.get("agent_id") or ""),
            "prompt": str(config.get("prompt") or ""),
            "triggers": config.get("triggers") or [],
        }

    def save(
        self, db: Session, project_id: str, user_id: int, values: ProjectManagerConfig
    ) -> dict:
        require_cloud_project_role(db, int(project_id), user_id, BaseRole.Maintainer)
        project = (
            db.query(CloudProject)
            .filter(CloudProject.id == int(project_id))
            .with_for_update()
            .one()
        )
        if project.version != values.version:
            raise HTTPException(status.HTTP_409_CONFLICT, "Project changed")
        agent = db.get(ProjectChatAgent, values.agent_id) if values.agent_id else None
        if values.enabled and (
            agent is None
            or str(agent.cloud_project_id) != str(project.id)
            or agent.status != "active"
            or not isinstance(agent.metadata_json, dict)
            or agent.metadata_json.get("runtime") != "wegent"
            or not agent.metadata_json.get("wegent_team_id")
        ):
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "Project manager requires an active Wegent project Agent",
            )
        if values.enabled:
            self._check_conflicts(db, project, values.triggers)
        previous = _config(project)
        for rule_id in previous.get("automation_ids") or []:
            rule = db.get(ProjectAutomationRule, rule_id)
            if rule is not None and is_project_manager_rule(rule):
                project_automation_service._mark_deleted(
                    db, rule, user_id=user_id, deleted_at=utcnow()
                )
        created_ids = []
        if values.enabled and agent is not None:
            team_id = int(agent.metadata_json["wegent_team_id"])
            for trigger in [None, *[item for item in values.triggers if item.enabled]]:
                rule = self._create_rule(
                    db,
                    project_id=project_id,
                    user_id=user_id,
                    values=values,
                    trigger=trigger,
                    team_id=team_id,
                )
                created_ids.append(str(rule.id))
        project_metadata = dict(project.metadata_json or {})
        project_metadata[CONFIG_KEY] = {
            **values.model_dump(exclude={"version"}),
            "automation_ids": created_ids,
            "configured_by_user_id": user_id,
        }
        project.metadata_json = project_metadata
        project.version += 1
        db.commit()
        return self.get(db, project_id, user_id)

    @staticmethod
    def _check_conflicts(
        db: Session, project: CloudProject, triggers: list[ProjectManagerTrigger]
    ) -> None:
        for index, trigger in enumerate(triggers):
            if not trigger.enabled or trigger.kind != "event":
                continue
            for other in triggers[index + 1 :]:
                if (
                    other.enabled
                    and other.kind == "event"
                    and other.event_type == trigger.event_type
                    and _tags_overlap(trigger.tags, other.tags)
                ):
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        "Project manager triggers overlap",
                    )
        rules = (
            db.query(ProjectAutomationRule)
            .filter(
                ProjectAutomationRule.cloud_project_id == project.id,
                ProjectAutomationRule.status == "enabled",
                loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
            )
            .all()
        )
        for trigger in triggers:
            if not trigger.enabled or trigger.kind != "event":
                continue
            for rule in rules:
                config = metadata(rule)
                if is_project_manager_rule(rule):
                    continue
                if config.get("trigger_type") != "event":
                    continue
                if config.get("event_type") != trigger.event_type:
                    continue
                event_config = config.get("event_config") or {}
                tags = event_config.get("tags") or []
                if _tags_overlap(trigger.tags, tags):
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        f"Trigger overlaps enabled automation {rule.id}",
                    )

    @staticmethod
    def _create_rule(
        db: Session,
        *,
        project_id: str,
        user_id: int,
        values: ProjectManagerConfig,
        trigger: ProjectManagerTrigger | None,
        team_id: int,
    ) -> ProjectAutomationRule:
        rule = project_automation_service._create_rule(
            db,
            project_id=project_id,
            user_id=user_id,
            values=ProjectAutomationCreate(
                name=f"Project manager · {trigger.id if trigger else 'manual'}",
                prompt=values.prompt,
                trigger_type=trigger.kind if trigger else "manual",
                event_type=trigger.event_type if trigger else None,
                event_config=(
                    {
                        "tags": trigger.tags,
                        "execution_target": "existing_issue",
                    }
                    if trigger and trigger.kind == "event"
                    else {}
                ),
                cron_expression=trigger.cron_expression if trigger else None,
                timezone=trigger.timezone if trigger else "Asia/Shanghai",
                assignment_mode="ai_managed",
                manager_type="wegent",
                wegent_team_id=team_id,
            ),
        )
        rule_metadata = metadata(rule)
        rule_metadata["project_manager"] = True
        rule_metadata["project_manager_trigger_id"] = (
            trigger.id if trigger else "manual"
        )
        event_config = dict(rule_metadata.get("event_config") or {})
        if trigger and trigger.event_type == "task.status_changed":
            event_config["transition"] = "any"
        rule_metadata["event_config"] = event_config
        rule.metadata_json = rule_metadata
        return rule

    async def run_now(
        self, db: Session, project_id: str, user_id: int, message: str
    ) -> dict:
        access = require_cloud_project_role(
            db, int(project_id), user_id, BaseRole.Reporter
        )
        project = db.get(CloudProject, int(project_id))
        config = _config(project)
        if not config.get("enabled"):
            raise HTTPException(status.HTTP_409_CONFLICT, "Project manager is disabled")
        rule_ids = config.get("automation_ids") or []
        rule = db.get(ProjectAutomationRule, rule_ids[0]) if rule_ids else None
        if rule is None or not is_project_manager_rule(rule):
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Project manager has no active rule"
            )
        run = project_automation_service._create_run(db, rule, "manual", utcnow())
        run.task_id = str(project.id)
        run.task_title = project.title or project.name or ""
        run.metadata_json = {
            **metadata(run),
            "instruction_override": message,
            "read_only": not has_permission(access.role, BaseRole.Maintainer),
            "requested_by_user_id": user_id,
        }
        db.commit()
        from app.services.project_automation_execution import (
            project_automation_execution,
        )

        await project_automation_execution.dispatch(db, rule, run)
        return {
            **project_automation_service._run_view(
                run,
                str(metadata(rule).get("timezone") or "Asia/Shanghai"),
                metadata(rule),
            ),
            "instruction": message,
        }

    def list_runs(self, db: Session, project_id: str, user_id: int) -> list[dict]:
        require_cloud_project_role(db, int(project_id), user_id, BaseRole.Reporter)
        rules = (
            db.query(ProjectAutomationRule)
            .filter(ProjectAutomationRule.cloud_project_id == project_id)
            .all()
        )
        rule_ids = {str(rule.id) for rule in rules if is_project_manager_rule(rule)}
        if not rule_ids:
            return []
        rows = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.parent_id.in_(rule_ids))
            .order_by(ProjectAutomationRun.created_at.desc())
            .limit(100)
            .all()
        )
        return [
            {
                **project_automation_service._run_view(row, rule_metadata={}),
                "instruction": metadata(row).get("instruction_override"),
            }
            for row in rows
        ]

    def run_detail(
        self, db: Session, project_id: str, run_id: str, user_id: int
    ) -> dict:
        require_cloud_project_role(db, int(project_id), user_id, BaseRole.Reporter)
        run = db.get(ProjectAutomationRun, run_id)
        rule = db.get(ProjectAutomationRule, run.parent_id) if run else None
        if (
            run is None
            or rule is None
            or str(run.cloud_project_id) != str(project_id)
            or not is_project_manager_rule(rule)
        ):
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "Project manager run not found"
            )
        from app.services.project_automation_execution import (
            project_automation_execution,
        )

        activity = project_automation_execution._activity(db, run)
        return {
            **project_automation_service._run_view(run, rule_metadata=metadata(rule)),
            "actions": metadata(run).get("manager_actions") or [],
            "instruction": metadata(run).get("instruction_override"),
            "response": (
                activity.content if activity and run.status == "succeeded" else None
            ),
        }


project_manager_service = ProjectManagerService()

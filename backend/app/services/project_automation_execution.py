# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Execution orchestration and event processing for project automations."""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.delivery import (
    CloudProject,
    LoopItem,
    ProjectAutomationRule,
    ProjectAutomationRun,
    ProjectChatAgent,
    ProjectWorkflowPlanItem,
    ProjectWorkflowRun,
    loop_datetime_is_unset,
    loop_unset_datetime_for_connection,
)
from app.models.loop_item_execution import LoopItemExecution
from app.models.project_chat_message import ProjectChatMessage
from app.models.user import User
from app.schemas.delivery import LoopItemCreate
from app.schemas.issue_workflow import (
    IssueWorkflowInstance,
    ProjectWorkflowDefinition,
    instantiate_workflow,
)
from app.schemas.project_chat import LoopItemAssign
from app.services.cloud_projects.service import cloud_project_service
from app.services.loop_item_executions.service import loop_item_execution_service
from app.services.loop_item_status_history import project_status_transition
from app.services.loop_items.external_provider import external_loop_item_provider
from app.services.loop_items.provider_router import loop_item_provider_router
from app.services.loop_items.service import loop_item_service
from app.services.project_automation_domain import (
    TERMINAL_RUN_STATUSES,
    ProjectAutomationEvent,
    assignment_mode,
    integer,
    manager_config,
    manager_type,
    metadata,
    project_agent,
    role_config,
    runnable_wegent_team,
    runtime_config,
    text,
    utcnow,
    wegent_team,
)
from app.services.project_chat.push import push_project_chat_message
from app.services.project_chat.service import project_chat_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
MISSING_MANAGER_PLAN_ERROR = "AI manager finished without submitting a workflow plan."

if TYPE_CHECKING:
    from app.schemas.issue_workflow import WorkflowPlanSubmit, WorkflowPlanView


class AutomationRunNotRetryable(RuntimeError):
    """The persisted run is not a failed, idle processor record."""


class AutomationRunFactory(Protocol):
    def __call__(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        trigger: str,
        scheduled_for: datetime,
        *,
        commit: bool = True,
    ) -> ProjectAutomationRun: ...


class ProjectAutomationExecution:
    """Turn one persisted automation run into one concrete executor run."""

    @trace_async(
        span_name="project_automation.execution.dispatch",
        tracer_name="backend.project_automation",
        extract_attributes=lambda self, db, rule, run: {
            "automation.rule.id": str(rule.id),
            "automation.run.id": str(run.id),
            "automation.assignment.mode": assignment_mode(metadata(rule)),
        },
    )
    async def dispatch(
        self, db: Session, rule: ProjectAutomationRule, run: ProjectAutomationRun
    ) -> None:
        if run.status not in {"pending", "queued"}:
            return
        try:
            owner = db.get(User, rule.created_by_user_id)
            project = db.get(CloudProject, rule.cloud_project_id)
            if owner is None or project is None:
                raise RuntimeError("Automation owner or project is unavailable")
            run_metadata = metadata(run)
            if not text(run_metadata.get("task_origin")):
                run_metadata["task_origin"] = (
                    "existing_issue" if run.task_id else "automation_created"
                )
                run.metadata_json = run_metadata
            workflow_definition = (
                None
                if run_metadata.get("bypass_workflow_definition")
                else self._workflow_definition(rule)
            )
            self._ensure_run_task(db, project=project, owner=owner, rule=rule, run=run)
            if workflow_definition is not None:
                await self._dispatch_workflow(
                    db,
                    owner=owner,
                    project=project,
                    rule=rule,
                    run=run,
                    definition=workflow_definition,
                )
                return
            context = self._automation_context(db, rule, run)
            instruction = self._run_instruction(rule, run)
            configured_mode = assignment_mode(metadata(rule))
            if configured_mode == "manual":
                configured_agent_id = str(context.get("agent_id") or "")
                if not configured_agent_id and (
                    "workspace_binding" in context
                    or role_config(metadata(rule)).get("source") == "generic"
                ):
                    self._dispatch_generic_robot(
                        db,
                        owner=owner,
                        rule=rule,
                        run=run,
                        context=context,
                    )
                else:
                    self._assign_project_robot(
                        db,
                        owner=owner,
                        rule=rule,
                        run=run,
                        agent_id=configured_agent_id or rule.assignee_agent_id,
                        context=context,
                        instruction=instruction,
                    )
            else:
                configured_manager = manager_type(metadata(rule))
                activity = self._create_manager_activity(
                    db,
                    rule=rule,
                    run=run,
                    configured_manager=configured_manager,
                )
                context["activity_message_id"] = activity.message_id
                if configured_manager == "custom":
                    self._dispatch_custom_manager(
                        db, owner=owner, rule=rule, run=run, context=context
                    )
                elif configured_manager == "wegent":
                    await self._dispatch_wegent_manager(
                        db,
                        owner=owner,
                        project=project,
                        rule=rule,
                        run=run,
                        activity=activity,
                        context=context,
                    )
                else:
                    raise RuntimeError("AI manager configuration is incomplete")
        except Exception as exc:
            db.rollback()
            logger.exception(
                "[ProjectAutomation] Dispatch failed rule=%s run=%s",
                rule.id,
                run.id,
            )
            self._fail_run(db, run_id=str(run.id), error=str(exc) or "Dispatch failed")

    @staticmethod
    def _workflow_definition(
        rule: ProjectAutomationRule,
    ) -> ProjectWorkflowDefinition | None:
        event_config = metadata(rule).get("event_config")
        if not isinstance(event_config, dict):
            return None
        raw_definition = event_config.get("runtime_workflow_definition")
        if not isinstance(raw_definition, dict):
            return None
        return ProjectWorkflowDefinition.model_validate(raw_definition)

    async def _dispatch_workflow(
        self,
        db: Session,
        *,
        owner: User,
        project: CloudProject,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        definition: ProjectWorkflowDefinition,
    ) -> None:
        if not run.task_id:
            raise RuntimeError("Workflow automation task is unavailable")
        item = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == run.task_id,
                LoopItem.cloud_project_id == project.id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .with_for_update()
            .one_or_none()
        )
        if item is None:
            raise RuntimeError("Workflow automation requires a local Issue")

        item_metadata = dict(item.metadata_json or {})
        existing_binding = item_metadata.get("workflow_automation")
        if isinstance(existing_binding, dict) and existing_binding.get("run_id") == str(
            run.id
        ):
            return
        existing_workflow = item_metadata.get("workflow")
        run_metadata = metadata(run)
        adopt_existing_workflow = (
            text(run_metadata.get("task_origin")) == "existing_issue"
            and isinstance(existing_workflow, dict)
            and not isinstance(existing_binding, dict)
        )
        workflow = (
            IssueWorkflowInstance.model_validate(existing_workflow)
            if adopt_existing_workflow
            else instantiate_workflow(definition)
        )
        item_metadata["workflow"] = workflow.model_dump(mode="json")
        item_metadata["workflow_automation"] = {
            "rule_id": str(rule.id),
            "run_id": str(run.id),
        }
        item.metadata_json = item_metadata
        item.version += 1
        run.status = "running"
        run_metadata["workflow_definition_version"] = definition.version
        run.metadata_json = run_metadata
        run.version += 1
        db.commit()
        db.refresh(item)
        db.refresh(run)

        from app.services.issue_workflow_start import issue_workflow_start_service

        started = await issue_workflow_start_service.start(
            db,
            item=item,
            project=project,
            user_id=owner.id,
        )
        from app.services.project_workflow_projection import (
            sync_workflow_automation_nodes,
            sync_workflow_automation_status,
        )

        current_metadata = (
            item.metadata_json if isinstance(item.metadata_json, dict) else {}
        )
        current_workflow = current_metadata.get("workflow")
        orchestration_status = (
            str(current_workflow.get("orchestration_status") or "")
            if isinstance(current_workflow, dict)
            else ""
        )
        if workflow.advancement_policy == "manual":
            current_nodes = (
                current_workflow.get("nodes")
                if isinstance(current_workflow, dict)
                else None
            )
            sync_workflow_automation_nodes(
                db,
                item,
                [dict(node) for node in current_nodes or [] if isinstance(node, dict)],
            )
        elif orchestration_status == "failed":
            sync_workflow_automation_status(
                db,
                item,
                run_status="failed",
                description="Issue workflow failed",
            )
        elif orchestration_status == "completed":
            sync_workflow_automation_status(
                db,
                item,
                run_status="succeeded",
            )
        else:
            sync_workflow_automation_status(
                db,
                item,
                run_status="running",
            )
        db.commit()
        logger.info(
            "[ProjectAutomation] Workflow dispatched rule=%s run=%s item=%s "
            "nodes=%s started=%s adopted=%s",
            rule.id,
            run.id,
            item.id,
            len(workflow.nodes),
            started,
            adopt_existing_workflow,
        )

    def _ensure_run_task(
        self,
        db: Session,
        *,
        project: CloudProject,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
    ) -> None:
        if run.task_id:
            task = loop_item_execution_service.resolve_task_context(
                db,
                execution=LoopItemExecution(
                    loop_item_id=str(run.task_id),
                    cloud_project_id=str(project.id),
                ),
                user_id=owner.id,
            )
            if task is None:
                raise RuntimeError("Automation event task is unavailable")
            return

        scheduled_for = self._scheduled_for(run)
        timezone_name = str(metadata(rule).get("timezone") or "Asia/Shanghai")
        try:
            local_time = scheduled_for.replace(tzinfo=timezone.utc).astimezone(
                ZoneInfo(timezone_name)
            )
        except ZoneInfoNotFoundError:
            local_time = scheduled_for
        context = self._automation_context(db, rule, run)
        instruction = self._run_instruction(rule, run)
        routed = loop_item_provider_router.create(
            db,
            project,
            owner,
            LoopItemCreate(
                title=f"{rule.title} · {local_time:%Y-%m-%d %H:%M}",
                description=instruction,
                priority="medium",
                tags=["automation"],
            ),
            automation_context=context,
            instruction=instruction,
            assign_creator_if_unassigned=False,
        )
        item_id = routed.values.get("id")
        if not item_id:
            raise RuntimeError("Automation task carrier was not created")
        run.task_id = str(item_id)
        item_title = routed.values.get("title")
        run.task_title = str(item_title) if item_title else ""
        run.version += 1
        db.commit()
        db.refresh(run)

    def _assign_project_robot(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        agent_id: str | None,
        context: dict,
        instruction: str,
    ) -> None:
        agent = project_agent(db, str(rule.cloud_project_id), agent_id)
        if not run.task_id:
            raise RuntimeError("Automation task carrier is unavailable")
        uses_workflow_snapshot = "workspace_binding" in context
        robot_context = {
            **context,
            "runtime_source": (
                context.get("runtime_source")
                if uses_workflow_snapshot
                else "agent_default"
            )
            or "agent_default",
            "runtime_profile_id": (
                context.get("runtime_profile_id") if uses_workflow_snapshot else None
            ),
            "runtime_subject_user_id": int(
                (
                    context.get("runtime_subject_user_id")
                    if uses_workflow_snapshot
                    else None
                )
                or agent.created_by_user_id
                or owner.id
            ),
        }
        item = db.get(LoopItem, run.task_id)
        if item is not None:
            loop_item_service.assign(
                db,
                project_id=int(str(rule.cloud_project_id)),
                item_id=item.id,
                user_id=owner.id,
                values=LoopItemAssign(
                    assignee_type="agent",
                    assignee_id=agent.id,
                    version=item.version,
                ),
                automation_context=robot_context,
                instruction=instruction,
            )
        elif external_loop_item_provider.is_external_item(db, run.task_id):
            external_loop_item_provider.assign(
                db,
                run.task_id,
                owner.id,
                LoopItemAssign(assignee_type="agent", assignee_id=agent.id, version=1),
                automation_context=robot_context,
                instruction=instruction,
            )
        else:
            raise RuntimeError("Automation task carrier is unavailable")
        execution = self._project_robot_execution_for_run(db, str(run.id))
        if execution is None:
            raise RuntimeError("Project robot execution was not created")
        run.assignee_agent_id = agent.id
        run.device_id = execution.execution_device_id
        run.status = "queued"
        run.version += 1
        db.commit()
        if execution.team_id:
            from app.services.board_team_execution import (
                schedule_board_robot_execution,
            )

            schedule_board_robot_execution(db, execution)
        logger.info(
            "[ProjectAutomation] Queued project robot run=%s execution=%s device=%s",
            run.id,
            execution.id,
            execution.execution_device_id,
        )

    def _dispatch_generic_robot(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        context: dict,
    ) -> None:
        if not run.task_id:
            raise RuntimeError("Automation task carrier is unavailable")
        from app.services.runtime_profiles import runtime_profile_service

        runtime_source = str(context.get("runtime_source") or "")
        profile = None
        profile_id = context.get("runtime_profile_id")
        runtime_subject_user_id = int(
            context.get("runtime_subject_user_id") or owner.id
        )
        if runtime_source == "fixed_profile" and isinstance(profile_id, str):
            profile = runtime_profile_service.require_owned(
                db, profile_id, runtime_subject_user_id
            )
        elif runtime_source in {"issue_creator", "runtime_user"}:
            profile = runtime_profile_service.resolve_project_default(
                db,
                str(rule.cloud_project_id),
                runtime_subject_user_id,
            )
        execution = loop_item_execution_service.enqueue_generic_robot(
            db,
            loop_item_id=str(run.task_id),
            cloud_project_id=str(rule.cloud_project_id),
            runtime_subject_user_id=runtime_subject_user_id,
            runtime_profile=profile,
            execution_device_id=str(context.get("execution_device_id") or "") or None,
            model=str(context.get("model") or "") or None,
            model_type=(
                str(context.get("model_type"))
                if context.get("model_type") is not None
                else None
            ),
            model_options=dict(context.get("model_options") or {}),
            assigner_user_id=owner.id,
            priority="medium",
            automation_context=context,
        )
        run.device_id = execution.execution_device_id
        run.status = (
            "waiting_runtime" if execution.status == "waiting_runtime" else "queued"
        )
        run.version += 1
        db.commit()

    def _dispatch_custom_manager(
        self,
        db: Session,
        *,
        owner: User,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        context: dict,
    ) -> None:
        rule_metadata = metadata(rule)
        if not run.task_id:
            raise RuntimeError("Custom AI manager configuration is incomplete")
        from app.services.runtime_profiles import runtime_profile_service

        runtime_source = str(context.get("runtime_source") or "")
        runtime_subject_user_id = int(
            context.get("runtime_subject_user_id") or owner.id
        )
        runtime_profile = None
        if runtime_source == "fixed_profile" and context.get("runtime_profile_id"):
            runtime_profile = runtime_profile_service.require_owned(
                db,
                str(context["runtime_profile_id"]),
                runtime_subject_user_id,
            )
        elif runtime_source in {"issue_creator", "runtime_user"}:
            runtime_profile = runtime_profile_service.resolve_project_default(
                db,
                str(rule.cloud_project_id),
                runtime_subject_user_id,
            )
        profile_metadata = (
            dict(runtime_profile.metadata_json or {}) if runtime_profile else {}
        )
        model = text(context.get("model") or profile_metadata.get("model"))
        environment = text(profile_metadata.get("execution_environment"))
        device_id = text(
            context.get("execution_device_id")
            or (runtime_profile.device_id if runtime_profile is not None else None)
        )
        if device_id and (
            runtime_profile is None or device_id != str(runtime_profile.device_id or "")
        ):
            from app.services.loop_item_executions.profile import (
                wework_execution_environment,
            )

            environment = wework_execution_environment(
                db,
                user_id=runtime_subject_user_id,
                execution_device_id=device_id,
            )
        waiting_runtime = not model or not environment or not device_id
        execution = loop_item_execution_service.enqueue_automation_manager(
            db,
            loop_item_id=str(run.task_id),
            cloud_project_id=str(rule.cloud_project_id),
            owner_user_id=runtime_subject_user_id,
            assigner_user_id=owner.id,
            environment=environment or "local",
            execution_device_id=device_id,
            priority="medium",
            automation_context=context,
            runtime_selection={
                "runtime_source": runtime_source,
                "runtime_profile_id": (runtime_profile.id if runtime_profile else None),
                "runtime_profile_version": (
                    runtime_profile.version if runtime_profile else None
                ),
                "model": model or None,
                "model_type": (
                    context.get("model_type") or profile_metadata.get("model_type")
                ),
                "model_options": dict(
                    context.get("model_options")
                    or profile_metadata.get("model_options")
                    or {}
                ),
                "workspace_policy": (
                    profile_metadata.get("workspace_policy") or "project"
                ),
            },
            waiting_runtime=waiting_runtime,
        )
        run.device_id = device_id
        run.status = "waiting_runtime" if waiting_runtime else "queued"
        run.version += 1
        self._bind_activity_to_execution(db, run=run, execution=execution)
        self._commit_and_push_activity(db, run)
        logger.info(
            "[ProjectAutomation] Queued custom manager run=%s execution=%s device=%s",
            run.id,
            execution.id,
            device_id,
        )

    async def _dispatch_wegent_manager(
        self,
        db: Session,
        *,
        owner: User,
        project: CloudProject,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        activity: ProjectChatMessage,
        context: dict,
    ) -> None:
        team = runnable_wegent_team(
            db,
            owner.id,
            integer(manager_config(metadata(rule)).get("wegent_team_id")),
        )
        if not run.task_id:
            raise RuntimeError("Automation task carrier is unavailable")
        prompt = self._managed_prompt(
            db,
            owner=owner,
            project=project,
            rule=rule,
            run=run,
            context=context,
        )
        from app.services.project_automation_managed_execution import (
            project_automation_managed_execution_service,
        )

        handle = await project_automation_managed_execution_service.dispatch(
            db=db,
            owner=owner,
            team=team,
            prompt=prompt,
            title=rule.title or "AI managed automation",
            project_id=str(project.id),
            loop_item_id=str(run.task_id),
            automation_run_id=str(run.id),
            project_chat_message_id=activity.message_id,
        )
        db.expire_all()
        refreshed_run = db.get(ProjectAutomationRun, run.id)
        refreshed_activity = (
            db.query(ProjectChatMessage)
            .filter(ProjectChatMessage.message_id == activity.message_id)
            .one()
        )
        if refreshed_run is None:
            raise RuntimeError("Automation run disappeared after dispatch")
        refreshed_run.backend_task_id = handle.task_id
        if refreshed_run.status not in TERMINAL_RUN_STATUSES | {"running"}:
            refreshed_run.status = "queued"
            refreshed_run.version += 1
        activity_metadata = dict(refreshed_activity.metadata_json or {})
        activity_metadata.update(
            {
                "backend_task_id": handle.task_id,
                "backend_subtask_id": handle.subtask_id,
                "execution_url": (
                    f"{settings.FRONTEND_URL.rstrip('/')}/tasks?taskId={handle.task_id}"
                ),
                "run_status": (
                    refreshed_activity.status
                    if refreshed_activity.status in {"completed", "failed", "cancelled"}
                    else refreshed_run.status
                ),
            }
        )
        refreshed_activity.metadata_json = activity_metadata
        db.commit()
        db.refresh(refreshed_activity)
        push_project_chat_message(
            project_chat_service.to_view(refreshed_activity).model_dump(by_alias=True)
        )
        logger.info(
            "[ProjectAutomation] Queued Wegent run=%s backend_task=%s team=%s",
            refreshed_run.id,
            handle.task_id,
            team.id,
        )

    @staticmethod
    def _managed_prompt(
        db: Session,
        *,
        owner: User,
        project: CloudProject,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        context: dict,
    ) -> str:
        del db, owner, context
        task_id = run.task_id or ""
        sections = [
            (
                f"project_id: {project.id}\n"
                f"task_id: {task_id}\n"
                f"automation_run_id: {run.id}"
            ),
            (
                f"看板任务数据位于 cloud://projects/{project.id}/todos/{task_id}，"
                "请通过看板工具自行查看。"
            ),
            (
                "你是看板的 AI 管家，只负责编排，不执行具体任务。"
                "请读取当前 Issue 和候选执行者，将工作拆成可独立验收的子任务，"
                "然后调用 submit_workflow_plan 提交结构化方案。"
                "方案项不需要提供 stage_id，平台会绑定当前活动规划范围；"
                "不要查询、猜测或伪造阶段标识。"
                "不要直接修改原 Issue 的负责人。"
            ),
        ]
        instruction = ProjectAutomationExecution._run_instruction(rule, run).strip()
        if instruction:
            sections.append(instruction)
        return "\n\n".join(sections)

    @staticmethod
    def _run_instruction(rule: ProjectAutomationRule, run: ProjectAutomationRun) -> str:
        override = metadata(run).get("instruction_override")
        return str(override) if isinstance(override, str) else (rule.description or "")

    def _create_manager_activity(
        self,
        db: Session,
        *,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
        configured_manager: str | None,
    ) -> ProjectChatMessage:
        rule_metadata = metadata(rule)
        manager_ref = str(rule.id)
        model = ""
        if configured_manager == "custom":
            sender_name = "自定义 AI 调度员"
            sender_id = f"automation_manager:{rule.id}"
        elif configured_manager == "wegent":
            configured_manager_values = manager_config(rule_metadata)
            team = wegent_team(
                db,
                int(rule.created_by_user_id or 0),
                integer(configured_manager_values.get("wegent_team_id")),
            )
            sender_name = str(team.name or "Wegent 智能体")
            sender_id = f"wegent_team:{team.id}"
            manager_ref = str(team.id)
        else:
            raise RuntimeError("AI manager configuration is incomplete")

        message_id = str(uuid.uuid7()) if hasattr(uuid, "uuid7") else str(uuid.uuid4())
        message_metadata = {
            "kind": "project_automation_run",
            "automation_rule_id": str(rule.id),
            "automation_run_id": str(run.id),
            "automation_rule_name": rule.title or "AI managed automation",
            "assignment_mode": "ai_managed",
            "manager_type": configured_manager,
            "manager_ref": manager_ref,
            "run_id": str(run.id),
            "run_status": "queued",
        }
        if model:
            message_metadata["model"] = model
        row = ProjectChatMessage(
            message_id=message_id,
            client_message_id=message_id,
            project_id=str(rule.cloud_project_id),
            task_id=str(run.task_id or ""),
            sender_type="agent",
            sender_id=sender_id,
            sender_name=sender_name,
            message_type="agent_status",
            content="",
            metadata_json=message_metadata,
            agent_id="",
            runtime_device_id="",
            runtime_task_id="",
            status="pending",
        )
        db.add(row)
        db.flush()
        run_metadata = metadata(run)
        run_metadata["activity_message_id"] = message_id
        run.metadata_json = run_metadata
        db.commit()
        db.refresh(row)
        push_project_chat_message(
            project_chat_service.to_view(row).model_dump(by_alias=True)
        )
        return row

    def assign_from_manager(
        self,
        db: Session,
        *,
        run_id: str,
        user_id: int,
        project_id: str,
        task_id: str,
        assignee_type: str,
        assignee_id: str,
    ) -> LoopItem | dict[str, object]:
        """Apply an MCP manager assignment through the shipped task path."""

        run = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.id == run_id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if run is None:
            raise RuntimeError("AI-managed automation run is not active")
        rule = db.get(ProjectAutomationRule, run.parent_id)
        owner = db.get(User, run.created_by_user_id)
        if rule is None or owner is None:
            raise RuntimeError("Automation rule or owner is unavailable")
        if owner.id != user_id:
            raise RuntimeError("AI manager does not own this automation run")
        rule_metadata = metadata(rule)
        if assignment_mode(rule_metadata) != "ai_managed":
            raise RuntimeError("Automation is no longer AI-managed")
        if str(rule.cloud_project_id) != str(project_id):
            raise RuntimeError("AI manager project does not match the automation run")
        if str(run.task_id or "") != str(task_id):
            raise RuntimeError("AI manager task does not match the automation run")
        if assignee_type not in {"user", "agent"}:
            raise RuntimeError("AI manager assignee type must be user or agent")
        robot_execution = self._project_robot_execution_for_run(db, run_id)
        current_task = self._task_values(
            db, project_id=project_id, task_id=task_id, user_id=user_id
        )
        current_agent_id = str(current_task.get("assignee_agent_id") or "")
        current_user_id = str(current_task.get("assignee_user_id") or "")
        activity = self._activity(db, run)
        activity_metadata = dict(activity.metadata_json or {}) if activity else {}
        selected_type = str(activity_metadata.get("selected_assignee_type") or "")
        selected_id = str(activity_metadata.get("selected_assignee_id") or "")
        if selected_type or selected_id:
            if selected_type != assignee_type or selected_id != assignee_id:
                raise RuntimeError("AI manager has already selected another assignee")
            task_matches = (
                assignee_type == "agent" and current_agent_id == assignee_id
            ) or (assignee_type == "user" and current_user_id == assignee_id)
            if not task_matches:
                raise RuntimeError("AI manager assignment no longer matches the task")
            if assignee_type == "agent" and robot_execution is None:
                raise RuntimeError("AI manager robot execution is unavailable")
            return current_task
        if run.status in TERMINAL_RUN_STATUSES:
            raise RuntimeError("AI-managed automation run is not active")
        if robot_execution is not None:
            raise RuntimeError("AI manager has already assigned this task to a robot")

        context = self._automation_context(db, rule, run)
        if assignee_type == "agent":
            self._assign_project_robot(
                db,
                owner=owner,
                rule=rule,
                run=run,
                agent_id=assignee_id,
                context=context,
                instruction="",
            )
        else:
            member_ids = {
                str(member["user_id"])
                for member in cloud_project_service.list_members(
                    db, int(project_id), owner.id
                )
            }
            if assignee_id not in member_ids:
                raise RuntimeError("AI manager selected an unavailable project member")
            item = db.get(LoopItem, task_id)
            if item is not None:
                loop_item_service.assign(
                    db,
                    project_id=int(project_id),
                    item_id=item.id,
                    user_id=owner.id,
                    values=LoopItemAssign(
                        assignee_type="user",
                        assignee_id=assignee_id,
                        version=item.version,
                    ),
                    automation_context=context,
                    instruction="",
                )
            elif external_loop_item_provider.is_external_item(db, task_id):
                current = external_loop_item_provider.get(db, task_id, owner.id)
                external_loop_item_provider.assign(
                    db,
                    task_id,
                    owner.id,
                    LoopItemAssign(
                        assignee_type="user",
                        assignee_id=assignee_id,
                        version=int(current.get("version") or 0),
                    ),
                    automation_context=context,
                    instruction="",
                )
            else:
                raise RuntimeError("Automation task carrier is unavailable")
            run.assignee_agent_id = ""

        activity = self._activity(db, run)
        if activity is not None:
            activity_metadata = dict(activity.metadata_json or {})
            activity.metadata_json = {
                **activity_metadata,
                "selected_assignee_type": assignee_type,
                "selected_assignee_id": assignee_id,
            }
            db.commit()
        return self._task_values(
            db, project_id=project_id, task_id=task_id, user_id=user_id
        )

    def has_recorded_manager_assignment(self, db: Session, *, run_id: str) -> bool:
        """Return whether the manager durably completed its assignment action."""

        run = db.get(ProjectAutomationRun, run_id)
        if run is None:
            return False
        activity = self._activity(db, run)
        metadata = dict(activity.metadata_json or {}) if activity else {}
        if metadata.get("workflow_plan_run_id"):
            return True
        selected_type = str(metadata.get("selected_assignee_type") or "")
        selected_id = str(metadata.get("selected_assignee_id") or "")
        if selected_type == "user":
            return bool(selected_id)
        if selected_type == "agent" and selected_id:
            execution = self._project_robot_execution_for_run(db, run_id)
            return execution is not None and execution.agent_id == selected_id
        return False

    def record_manager_plan_submission(
        self,
        db: Session,
        *,
        run_id: str,
        user_id: int,
        workflow_run_id: str,
        plan_version: int,
        commit: bool = True,
    ) -> None:
        """Record the manager's durable orchestration action."""

        run = db.get(ProjectAutomationRun, run_id)
        if run is None or run.status in TERMINAL_RUN_STATUSES:
            raise RuntimeError("AI-managed automation run is not active")
        if run.created_by_user_id != user_id:
            raise RuntimeError("AI manager does not own this automation run")
        activity = self._activity(db, run)
        if activity is None:
            raise RuntimeError("AI manager activity is unavailable")
        workflow_run = db.get(ProjectWorkflowRun, workflow_run_id)
        if workflow_run is None or workflow_run.parent_id != run.task_id:
            raise RuntimeError("AI manager workflow plan does not match its Issue")
        run_metadata = run.metadata_json if isinstance(run.metadata_json, dict) else {}
        event = run_metadata.get("event")
        payload = event.get("payload") if isinstance(event, dict) else None
        expected_workflow_run_id = (
            payload.get("workflow_run_id") if isinstance(payload, dict) else None
        )
        if expected_workflow_run_id != workflow_run_id:
            raise RuntimeError("AI manager workflow plan is no longer active")
        workflow_run.metadata_json = {
            **(workflow_run.metadata_json or {}),
            "project_automation_run_id": run.id,
        }
        activity.metadata_json = {
            **(activity.metadata_json or {}),
            "workflow_plan_run_id": workflow_run_id,
            "workflow_plan_version": plan_version,
        }
        if commit:
            db.commit()
        else:
            db.flush()

    def submit_manager_workflow_plan(
        self,
        db: Session,
        *,
        run_id: str,
        issue_id: str,
        user_id: int,
        values: WorkflowPlanSubmit,
    ) -> WorkflowPlanView:
        """Persist one manager plan and its audit binding atomically."""

        from app.schemas.issue_workflow import WorkflowPlanSubmit
        from app.services.issue_workflow_planning import (
            issue_workflow_planning_service,
        )

        validated = WorkflowPlanSubmit.model_validate(values)
        try:
            view = issue_workflow_planning_service.submit(
                db,
                issue_id=issue_id,
                user_id=user_id,
                values=validated,
                commit=False,
            )
            self.record_manager_plan_submission(
                db,
                run_id=run_id,
                user_id=user_id,
                workflow_run_id=view.run_id,
                plan_version=view.plan_version,
                commit=False,
            )
            db.commit()
            return view
        except Exception:
            db.rollback()
            raise

    def finalize_manager_result(
        self,
        db: Session,
        *,
        run_id: str,
        content: str | None,
        backend_task_id: int | None = None,
        activity_message_id: str | None = None,
        push_activity: bool = True,
    ) -> bool:
        """Project manager output as audit text; assignment state is authoritative."""

        run = db.get(ProjectAutomationRun, run_id)
        if run is None:
            return False
        rule = db.get(ProjectAutomationRule, run.parent_id)
        owner = db.get(User, run.created_by_user_id)
        if rule is None or owner is None:
            return False
        task = self._task_values(
            db,
            project_id=str(rule.cloud_project_id),
            task_id=str(run.task_id or ""),
            user_id=owner.id,
        )
        assignee_agent_id = task.get("assignee_agent_id")
        assignee_user_id = task.get("assignee_user_id")
        activity = self._activity(db, run)
        if activity is None and activity_message_id:
            activity = (
                db.query(ProjectChatMessage)
                .filter(ProjectChatMessage.message_id == activity_message_id)
                .one_or_none()
            )
        activity_metadata = dict(activity.metadata_json or {}) if activity else {}
        workflow_plan_run_id = str(activity_metadata.get("workflow_plan_run_id") or "")
        if not workflow_plan_run_id:
            workflow_plan = self._workflow_plan_for_manager_run(db, run)
            if workflow_plan is not None:
                workflow_plan_run_id = str(workflow_plan.id)
                workflow_metadata = dict(workflow_plan.metadata_json or {})
                workflow_metadata["project_automation_run_id"] = run.id
                workflow_plan.metadata_json = workflow_metadata
                if activity is not None:
                    activity_metadata["workflow_plan_run_id"] = workflow_plan_run_id
                    activity_metadata["workflow_plan_version"] = int(
                        workflow_metadata.get("plan_version") or 0
                    )
                    activity.metadata_json = activity_metadata
        selected_type = str(activity_metadata.get("selected_assignee_type") or "")
        selected_id = str(activity_metadata.get("selected_assignee_id") or "")
        selected_agent_id = (
            selected_id
            if selected_type == "agent" and str(assignee_agent_id or "") == selected_id
            else ""
        )
        selected_user_id = (
            selected_id
            if selected_type == "user" and str(assignee_user_id or "") == selected_id
            else ""
        )
        manager_action_recorded = bool(
            workflow_plan_run_id or selected_agent_id or selected_user_id
        )
        if (selected_type or selected_id) and not (
            selected_agent_id or selected_user_id
        ):
            raise RuntimeError("AI manager assignment no longer matches the task")
        expected_activity_status = "completed" if manager_action_recorded else "failed"
        projection_already_completed = bool(
            activity is not None
            and activity.status == expected_activity_status
            and (
                backend_task_id is None
                or activity_metadata.get("backend_task_id") == backend_task_id
            )
        )
        audit = (content or "").strip()
        if selected_agent_id:
            if self._project_robot_execution_for_run(db, run_id) is None:
                raise RuntimeError(
                    "AI manager assignment did not create a robot execution"
                )
        run_changed = False
        if manager_action_recorded:
            if run.status not in TERMINAL_RUN_STATUSES or (
                run.status == "failed" and run.description == MISSING_MANAGER_PLAN_ERROR
            ):
                run.status = "succeeded"
                run.completed_at = utcnow()
                run.version += 1
                run_changed = True
        elif run.status not in TERMINAL_RUN_STATUSES:
            run.status = "failed"
            run.description = MISSING_MANAGER_PLAN_ERROR
            run.completed_at = utcnow()
            run.version += 1
            run_changed = True
        if run_changed:
            from app.services.project_workflow_projection import (
                sync_automation_workflow_node,
            )

            sync_automation_workflow_node(db, run)

        if backend_task_id is not None and run.backend_task_id != backend_task_id:
            run.backend_task_id = backend_task_id
            run_changed = True
        if projection_already_completed:
            if run_changed:
                self._commit_and_push_activity(
                    db,
                    run,
                    push_activity=push_activity,
                )
            return run_changed
        if activity is not None:
            activity.status = expected_activity_status
            activity.message_type = "text"
            activity.content = audit or (
                "AI 管家已提交编排方案。"
                if workflow_plan_run_id
                else (
                    "AI 调度员已完成分派。"
                    if selected_agent_id or selected_user_id
                    else "AI 管家未提交编排方案，本次运行已失败。"
                )
            )
            activity.metadata_json = {
                **activity_metadata,
                "run_status": activity.status,
                **(
                    {"backend_task_id": backend_task_id}
                    if backend_task_id is not None
                    else {}
                ),
            }
        self._commit_and_push_activity(db, run, push_activity=push_activity)
        return True

    @staticmethod
    def _task_values(
        db: Session, *, project_id: str, task_id: str, user_id: int
    ) -> dict[str, object]:
        item = db.get(LoopItem, task_id)
        if item is not None and str(item.cloud_project_id) == str(project_id):
            return dict(item.__dict__)
        values = external_loop_item_provider.get(db, task_id, user_id)
        if str(values.get("cloud_project_id")) != str(project_id):
            raise RuntimeError("Automation task carrier is unavailable")
        return values

    @staticmethod
    def _bind_activity_to_execution(
        db: Session,
        *,
        run: ProjectAutomationRun,
        execution: LoopItemExecution,
    ) -> None:
        row = ProjectAutomationExecution._activity(db, run)
        if row is None:
            return
        activity_metadata = dict(row.metadata_json or {})
        activity_metadata.update(
            {
                "execution_id": execution.id,
                "executor_type": execution.executor_type,
                "run_status": "queued",
                "execution_device_id": execution.execution_device_id,
                "runtime_task_id": execution.runtime_task_id,
            }
        )
        row.metadata_json = activity_metadata
        row.runtime_device_id = execution.execution_device_id or ""
        row.runtime_task_id = execution.runtime_task_id or ""

    @staticmethod
    def _activity_payload(
        db: Session, run: ProjectAutomationRun
    ) -> dict[str, Any] | None:
        db.flush()
        row = ProjectAutomationExecution._activity(db, run)
        if row is None:
            return None
        return project_chat_service.to_view(row).model_dump(by_alias=True)

    def _commit_and_push_activity(
        self,
        db: Session,
        run: ProjectAutomationRun,
        *,
        push_activity: bool = True,
    ) -> None:
        payload = self._activity_payload(db, run) if push_activity else None
        db.commit()
        self._push_activity(payload)

    @staticmethod
    def _push_activity(payload: dict[str, Any] | None) -> None:
        if payload is not None:
            push_project_chat_message(payload)

    def _fail_run(self, db: Session, *, run_id: str, error: str) -> None:
        run = db.get(ProjectAutomationRun, run_id)
        if run is None or run.status in TERMINAL_RUN_STATUSES:
            return
        run.status = "failed"
        run.description = error[:2000]
        run.version += 1
        from app.services.project_workflow_projection import (
            sync_automation_workflow_node,
        )

        sync_automation_workflow_node(db, run)
        self.finish_activity(
            db,
            run=run,
            status_value="failed",
            content=error or "AI 托管任务派发失败。",
        )
        self._commit_and_push_activity(db, run)

    @staticmethod
    def finish_activity(
        db: Session,
        *,
        run: ProjectAutomationRun,
        status_value: str,
        content: str,
    ) -> None:
        row = ProjectAutomationExecution._activity(db, run)
        if row is None:
            return
        row.status = status_value
        row.message_type = "text"
        row.content = content
        activity_metadata = dict(row.metadata_json or {})
        activity_metadata["run_status"] = status_value
        if status_value == "failed":
            activity_metadata["error"] = content
        row.metadata_json = activity_metadata
        # Manager activity is an audit record. It must never become the
        # original task's execution state or advance the task workflow.

    @staticmethod
    def _activity(db: Session, run: ProjectAutomationRun) -> ProjectChatMessage | None:
        message_id = metadata(run).get("activity_message_id")
        if not isinstance(message_id, str) or not message_id:
            return None
        return (
            db.query(ProjectChatMessage)
            .filter(ProjectChatMessage.message_id == message_id)
            .one_or_none()
        )

    def _automation_context(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        run: ProjectAutomationRun,
    ) -> dict:
        run_metadata = metadata(run)
        rule_metadata = metadata(rule)
        runtime = runtime_config(rule_metadata)
        runtime_source = str(runtime.get("source") or "agent_default")
        runtime_subject_user_id = int(rule.created_by_user_id or 0)
        runtime_profile_id = text(runtime.get("runtime_profile_id"))
        if runtime_source == "issue_creator" and run.task_id:
            task = self._task_values(
                db,
                project_id=str(rule.cloud_project_id),
                task_id=str(run.task_id),
                user_id=int(rule.created_by_user_id or 0),
            )
            runtime_subject_user_id = int(
                task.get("created_by_user_id") or runtime_subject_user_id
            )
        elif runtime_source == "runtime_user":
            runtime_subject_user_id = int(
                runtime.get("user_id") or runtime_subject_user_id
            )
        elif runtime_source == "fixed_profile" and runtime_profile_id:
            from app.models.delivery import RuntimeProfile

            profile = db.get(RuntimeProfile, runtime_profile_id)
            if profile is not None:
                runtime_subject_user_id = int(
                    profile.user_id or runtime_subject_user_id
                )
        workflow_config = run_metadata.get("workflow_execution_config")
        workflow_config = workflow_config if isinstance(workflow_config, dict) else {}
        configured_runtime_profile_id = workflow_config.get(
            "runtimeProfileId"
        ) or workflow_config.get("runtime_profile_id")
        if configured_runtime_profile_id:
            runtime_source = "fixed_profile"
            runtime_profile_id = str(configured_runtime_profile_id)
            from app.models.delivery import RuntimeProfile

            profile = db.get(RuntimeProfile, runtime_profile_id)
            if profile is not None:
                runtime_subject_user_id = int(
                    profile.user_id or runtime_subject_user_id
                )
        workspace_binding = workflow_config.get("workspaceBinding")
        if not isinstance(workspace_binding, dict):
            workspace_binding = workflow_config.get("workspace_binding")
        context = {
            "rule_id": str(rule.id),
            "run_id": str(run.id),
            "trigger": run_metadata.get("trigger") or run.source,
            "scheduled_for": run_metadata.get("scheduled_for"),
            "event": run_metadata.get("event") or {},
            "runtime_source": runtime_source,
            "runtime_profile_id": (configured_runtime_profile_id or runtime_profile_id),
            "runtime_subject_user_id": runtime_subject_user_id,
        }
        if workflow_config:
            from app.schemas.issue_workflow import WorkflowExecutionConfig

            execution_config = WorkflowExecutionConfig.model_validate(workflow_config)
            context.update(
                {
                    "agent_id": (
                        workflow_config.get("agentId")
                        or workflow_config.get("agent_id")
                    ),
                    "execution_device_id": (
                        workflow_config.get("executionDeviceId")
                        or workflow_config.get("execution_device_id")
                    ),
                    "model": workflow_config.get("model"),
                    "model_type": (
                        workflow_config.get("modelType")
                        or workflow_config.get("model_type")
                    ),
                    "model_options": (
                        workflow_config.get("modelOptions")
                        or workflow_config.get("model_options")
                        or {}
                    ),
                    "workspace_binding": workspace_binding,
                    **execution_config.runtime_request_options(),
                }
            )
        return context

    @staticmethod
    def _scheduled_for(run: ProjectAutomationRun) -> datetime:
        value = metadata(run).get("scheduled_for")
        if isinstance(value, str):
            try:
                return datetime.fromisoformat(value).replace(tzinfo=None)
            except ValueError:
                pass
        return run.created_at or utcnow()

    @staticmethod
    def _project_robot_execution_for_run(
        db: Session, run_id: str
    ) -> LoopItemExecution | None:
        run = db.get(ProjectAutomationRun, run_id)
        run_metadata = metadata(run) if run is not None else {}
        execution_floor_id = integer(run_metadata.get("retry_execution_floor_id")) or 0
        return (
            db.query(LoopItemExecution)
            .filter(
                LoopItemExecution.automation_run_id == run_id,
                LoopItemExecution.agent_id != "",
                LoopItemExecution.id > execution_floor_id,
            )
            .order_by(LoopItemExecution.id.desc())
            .first()
        )

    @staticmethod
    def _workflow_plan_for_manager_run(
        db: Session,
        run: ProjectAutomationRun,
    ) -> ProjectWorkflowRun | None:
        candidates = (
            db.query(ProjectWorkflowRun)
            .filter(ProjectWorkflowRun.parent_id == run.task_id)
            .order_by(ProjectWorkflowRun.created_at.desc())
            .all()
        )
        for candidate in candidates:
            candidate_metadata = (
                candidate.metadata_json
                if isinstance(candidate.metadata_json, dict)
                else {}
            )
            if str(candidate_metadata.get("project_automation_run_id") or "") == str(
                run.id
            ) and ProjectAutomationExecution._workflow_plan_has_items(db, candidate):
                return candidate
        run_metadata = metadata(run)
        event = run_metadata.get("event")
        payload = event.get("payload") if isinstance(event, dict) else None
        workflow_run_id = (
            str(payload.get("workflow_run_id") or "")
            if isinstance(payload, dict)
            else ""
        )
        if not workflow_run_id:
            return None
        candidate = db.get(ProjectWorkflowRun, workflow_run_id)
        if candidate is None or candidate.parent_id != run.task_id:
            return None
        return (
            candidate
            if ProjectAutomationExecution._workflow_plan_has_items(db, candidate)
            else None
        )

    @staticmethod
    def _workflow_plan_has_items(
        db: Session,
        run: ProjectWorkflowRun,
    ) -> bool:
        return (
            db.query(ProjectWorkflowPlanItem.id)
            .filter(
                ProjectWorkflowPlanItem.parent_id == run.id,
                ProjectWorkflowPlanItem.status != "superseded",
            )
            .first()
            is not None
        )


project_automation_execution = ProjectAutomationExecution()


class ProjectAutomationProcessor:
    """Translate supported project events into ordinary automation runs."""

    def __init__(self, run_factory: AutomationRunFactory | None = None) -> None:
        self._run_factory = run_factory

    def _create_run(
        self,
        db: Session,
        rule: ProjectAutomationRule,
        trigger: str,
        scheduled_for: datetime,
    ) -> ProjectAutomationRun:
        if self._run_factory is not None:
            return self._run_factory(db, rule, trigger, scheduled_for)
        from app.services.project_automations import project_automation_service

        return project_automation_service._create_run(db, rule, trigger, scheduled_for)

    def matching_rules(
        self,
        db: Session,
        event: ProjectAutomationEvent,
        *,
        automation_id: str | None = None,
    ) -> list[ProjectAutomationRule]:
        """Return enabled rules that match one supported project event."""

        if event.event_type not in {"task.created", "task.status_changed"}:
            return []
        query = db.query(ProjectAutomationRule).filter(
            ProjectAutomationRule.cloud_project_id == event.project_id,
            ProjectAutomationRule.status == "enabled",
            loop_datetime_is_unset(ProjectAutomationRule.deleted_at),
        )
        if automation_id:
            query = query.filter(ProjectAutomationRule.id == automation_id)
        project = db.get(CloudProject, event.project_id)
        if project is None:
            return []
        workflow = event.payload.get("workflow")
        deferred_automation_id = (
            str(workflow.get("ai_automation_rule_id") or "")
            if isinstance(workflow, dict) and workflow.get("advancement_policy") == "ai"
            else ""
        )
        candidate_rules = query.all()
        logger.info(
            "[ProjectAutomation] Evaluating event rules project=%s subject=%s "
            "event=%s previous_status=%s status=%s tags=%s candidates=%s",
            event.project_id,
            event.subject_id,
            event.event_type,
            event.payload.get("previous_status"),
            event.payload.get("status"),
            event.payload.get("tags"),
            [
                {
                    "id": str(rule.id),
                    "trigger_type": metadata(rule).get("trigger_type"),
                    "event_type": metadata(rule).get("event_type"),
                    "transition": (metadata(rule).get("event_config") or {}).get(
                        "transition"
                    ),
                    "tags": (metadata(rule).get("event_config") or {}).get("tags"),
                }
                for rule in candidate_rules
            ],
        )
        matches: list[ProjectAutomationRule] = []
        for rule in candidate_rules:
            if deferred_automation_id and str(rule.id) == deferred_automation_id:
                continue
            rule_metadata = metadata(rule)
            if rule_metadata.get("trigger_type") != "event":
                continue
            if rule_metadata.get("event_type") != event.event_type:
                continue
            if self._matches(rule_metadata.get("event_config"), event, project):
                matches.append(rule)
        return matches

    @staticmethod
    def _event_payload_for_rule(
        db: Session,
        event: ProjectAutomationEvent,
        rule: ProjectAutomationRule,
    ) -> dict[str, Any]:
        payload = dict(event.payload)
        workflow = payload.get("workflow")
        if (
            not isinstance(workflow, dict)
            or workflow.get("advancement_policy") != "ai"
            or str(workflow.get("ai_automation_rule_id") or "") != str(rule.id)
            or payload.get("workflow_run_id")
        ):
            return payload

        issue = (
            db.query(LoopItem)
            .filter(
                LoopItem.id == event.subject_id,
                LoopItem.cloud_project_id == event.project_id,
                loop_datetime_is_unset(LoopItem.deleted_at),
            )
            .one_or_none()
        )
        if issue is None:
            raise RuntimeError("AI manager Issue is unavailable")

        from app.services.issue_workflow_planning import (
            issue_workflow_planning_service,
        )

        planning_run = issue_workflow_planning_service.ensure_run(
            db,
            issue=issue,
            user_id=event.actor_user_id,
        )
        payload["workflow_run_id"] = planning_run.id
        payload["workflow_plan_version"] = (planning_run.metadata_json or {}).get(
            "plan_version"
        )
        return payload

    async def retry(
        self,
        db: Session,
        *,
        run_id: str,
        requested_by_user_id: int,
    ) -> ProjectAutomationRun:
        """Re-dispatch the same failed processor record and board task."""

        run = (
            db.query(ProjectAutomationRun)
            .filter(ProjectAutomationRun.id == run_id)
            .populate_existing()
            .with_for_update()
            .one_or_none()
        )
        if run is None:
            raise RuntimeError("Automation run is unavailable")
        if run.status != "failed":
            raise AutomationRunNotRetryable(
                "Only a failed automation run can be retried"
            )
        active_execution = (
            db.query(LoopItemExecution.id)
            .filter(
                LoopItemExecution.automation_run_id == run_id,
                LoopItemExecution.status.in_(
                    {"pending_approval", "queued", "claimed", "running"}
                ),
            )
            .first()
        )
        if active_execution is not None:
            raise AutomationRunNotRetryable(
                "Automation run already has an active execution"
            )
        latest_execution_id = (
            db.query(LoopItemExecution.id)
            .filter(LoopItemExecution.automation_run_id == run_id)
            .order_by(LoopItemExecution.id.desc())
            .limit(1)
            .scalar()
            or 0
        )
        rule = db.get(ProjectAutomationRule, run.parent_id)
        if rule is None or str(rule.cloud_project_id) != str(run.cloud_project_id):
            raise RuntimeError("Automation rule is unavailable")

        run_metadata = metadata(run)
        run_metadata.pop("activity_message_id", None)
        run_metadata.update(
            {
                "retry_count": (integer(run_metadata.get("retry_count")) or 0) + 1,
                "retry_execution_floor_id": int(latest_execution_id),
                "last_retried_at": utcnow().isoformat(),
                "last_retried_by_user_id": requested_by_user_id,
            }
        )
        run.metadata_json = run_metadata
        run.status = "pending"
        run.description = ""
        run.completed_at = loop_unset_datetime_for_connection(
            db.connection(), "completed_at"
        )
        run.backend_task_id = 0
        run.assignee_agent_id = ""
        run.device_id = ""
        run.version += 1
        from app.services.project_workflow_projection import (
            sync_automation_workflow_node,
        )

        sync_automation_workflow_node(db, run)
        db.commit()
        db.refresh(run)

        await project_automation_execution.dispatch(db, rule, run)
        db.refresh(run)
        return run

    @trace_async(
        span_name="project_automation.event.process",
        tracer_name="backend.project_automation",
        extract_attributes=lambda self, db, event, **kwargs: {
            "automation.event.type": event.event_type,
            "project.id": str(event.project_id),
            "task.id": str(event.subject_id),
        },
    )
    async def process(
        self,
        db: Session,
        event: ProjectAutomationEvent,
        *,
        automation_id: str | None = None,
    ) -> int:
        if event.event_type not in {"task.created", "task.status_changed"}:
            logger.info(
                "[ProjectAutomation] Ignoring unsupported event=%s", event.event_type
            )
            return 0
        matching_rules = self.matching_rules(db, event, automation_id=automation_id)
        logger.info(
            "[ProjectAutomation] Event matched project=%s subject=%s event=%s "
            "requested_rule=%s matching_rule_ids=%s",
            event.project_id,
            event.subject_id,
            event.event_type,
            automation_id,
            [str(rule.id) for rule in matching_rules],
        )
        if automation_id is None and matching_rules:
            issue = (
                db.query(LoopItem)
                .filter(
                    LoopItem.id == event.subject_id,
                    LoopItem.cloud_project_id == event.project_id,
                    loop_datetime_is_unset(LoopItem.deleted_at),
                )
                .one_or_none()
            )
            issue_metadata = (
                issue.metadata_json
                if issue is not None and isinstance(issue.metadata_json, dict)
                else {}
            )
            workflow_binding = issue_metadata.get("workflow_automation")
            bound_rule_id = (
                str(workflow_binding.get("rule_id") or "")
                if isinstance(workflow_binding, dict)
                else ""
            )
            if bound_rule_id:
                matching_rules = [
                    rule for rule in matching_rules if str(rule.id) == bound_rule_id
                ]
            elif len(matching_rules) > 1:
                logger.info(
                    "[ProjectAutomation] Selection required project=%s subject=%s "
                    "candidates=%s",
                    event.project_id,
                    event.subject_id,
                    [str(rule.id) for rule in matching_rules],
                )
                return 0

        dispatched = 0
        for rule in matching_rules:
            run_event_payload = self._event_payload_for_rule(db, event, rule)
            run = self._create_run(db, rule, "event", utcnow())
            run.task_id = event.subject_id
            event_title = event.payload.get("title")
            run.task_title = str(event_title) if event_title else ""
            run_metadata = metadata(run)
            run_metadata["event"] = {
                "type": event.event_type,
                "source": event.source,
                "subject_id": event.subject_id,
                "actor_user_id": event.actor_user_id,
                "payload": run_event_payload,
            }
            execution_config = run_event_payload.get("execution_config")
            if isinstance(execution_config, dict):
                run_metadata["workflow_execution_config"] = execution_config
            run.metadata_json = run_metadata
            db.commit()
            await project_automation_execution.dispatch(db, rule, run)
            dispatched += 1
        logger.info(
            "[ProjectAutomation] Event complete project=%s subject=%s dispatched=%s",
            event.project_id,
            event.subject_id,
            dispatched,
        )
        if dispatched:
            from app.tasks.robot_queue_tasks import consume_queues_background

            await consume_queues_background()
        return dispatched

    @staticmethod
    def _matches(
        config: object,
        event: ProjectAutomationEvent,
        project: CloudProject,
    ) -> bool:
        if not isinstance(config, dict):
            return True
        sources = config.get("sources")
        if isinstance(sources, list) and sources and event.source not in sources:
            return False
        if event.event_type == "task.status_changed":
            if config.get("transition") != "entered_processing":
                return False
            previous_status = event.payload.get("previous_status")
            current_status = event.payload.get("status")
            if not isinstance(previous_status, str) or not isinstance(
                current_status, str
            ):
                return False
            if not project_status_transition(
                project,
                previous_status=previous_status,
                current_status=current_status,
            ).entered_processing:
                return False
        expected_priorities = config.get("priorities")
        if (
            isinstance(expected_priorities, list)
            and expected_priorities
            and event.payload.get("priority") not in expected_priorities
        ):
            return False
        expected_tags = config.get("tags")
        actual_tags = event.payload.get("tags")
        if isinstance(expected_tags, list) and expected_tags:
            return bool(
                set(expected_tags).intersection(
                    actual_tags if isinstance(actual_tags, list) else []
                )
            )
        return True

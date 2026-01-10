# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Flow service layer for managing Flow configurations and executions.
"""
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy import and_, desc, func, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.flow import FlowExecution, FlowResource
from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.flow import (
    Flow,
    FlowCreate,
    FlowExecutionCreate,
    FlowExecutionInDB,
    FlowExecutionStatus,
    FlowInDB,
    FlowMetadata,
    FlowSpec,
    FlowStatus,
    FlowTaskType,
    FlowTriggerConfig,
    FlowTriggerType,
    FlowUpdate,
)

logger = logging.getLogger(__name__)


class FlowService:
    """Service class for AI Flow operations."""

    # Supported prompt template variables
    TEMPLATE_VARIABLES = {
        "date": lambda: datetime.utcnow().strftime("%Y-%m-%d"),
        "time": lambda: datetime.utcnow().strftime("%H:%M:%S"),
        "datetime": lambda: datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": lambda: str(int(datetime.utcnow().timestamp())),
    }

    def create_flow(
        self,
        db: Session,
        *,
        flow_in: FlowCreate,
        user_id: int,
    ) -> FlowInDB:
        """Create a new Flow configuration."""
        # Validate flow name uniqueness
        existing = (
            db.query(FlowResource)
            .filter(
                FlowResource.user_id == user_id,
                FlowResource.kind == "Flow",
                FlowResource.name == flow_in.name,
                FlowResource.namespace == flow_in.namespace,
                FlowResource.is_active == True,
            )
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Flow with name '{flow_in.name}' already exists",
            )

        # Validate team exists
        team = (
            db.query(Kind)
            .filter(
                Kind.id == flow_in.team_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=400,
                detail=f"Team with id {flow_in.team_id} not found",
            )

        # Validate workspace if provided
        workspace = None
        if flow_in.workspace_id:
            workspace = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == flow_in.workspace_id,
                    TaskResource.kind == "Workspace",
                    TaskResource.is_active == True,
                )
                .first()
            )

            if not workspace:
                raise HTTPException(
                    status_code=400,
                    detail=f"Workspace with id {flow_in.workspace_id} not found",
                )

        # Generate webhook token for event-type flows
        webhook_token = None
        if flow_in.trigger_type == FlowTriggerType.EVENT:
            webhook_token = secrets.token_urlsafe(32)

        # Build CRD JSON
        flow_crd = self._build_flow_crd(flow_in, team, workspace, webhook_token)

        # Calculate next execution time for scheduled flows
        next_execution_time = self._calculate_next_execution_time(
            flow_in.trigger_type, flow_in.trigger_config
        )

        # Create Flow resource
        flow = FlowResource(
            user_id=user_id,
            kind="Flow",
            name=flow_in.name,
            namespace=flow_in.namespace,
            json=flow_crd.model_dump(mode="json"),
            is_active=True,
            enabled=flow_in.enabled,
            trigger_type=flow_in.trigger_type.value,
            team_id=flow_in.team_id,
            workspace_id=flow_in.workspace_id,
            webhook_token=webhook_token,
            next_execution_time=next_execution_time,
        )

        db.add(flow)
        db.commit()
        db.refresh(flow)

        return self._convert_to_flow_in_db(flow)

    def get_flow(
        self,
        db: Session,
        *,
        flow_id: int,
        user_id: int,
    ) -> FlowInDB:
        """Get a Flow by ID."""
        flow = (
            db.query(FlowResource)
            .filter(
                FlowResource.id == flow_id,
                FlowResource.user_id == user_id,
                FlowResource.is_active == True,
            )
            .first()
        )

        if not flow:
            raise HTTPException(status_code=404, detail="Flow not found")

        return self._convert_to_flow_in_db(flow)

    def list_flows(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        enabled: Optional[bool] = None,
        trigger_type: Optional[FlowTriggerType] = None,
    ) -> tuple[List[FlowInDB], int]:
        """List user's Flows with pagination."""
        query = db.query(FlowResource).filter(
            FlowResource.user_id == user_id,
            FlowResource.is_active == True,
        )

        if enabled is not None:
            query = query.filter(FlowResource.enabled == enabled)

        if trigger_type is not None:
            query = query.filter(FlowResource.trigger_type == trigger_type.value)

        total = query.count()
        flows = (
            query.order_by(desc(FlowResource.updated_at))
            .offset(skip)
            .limit(limit)
            .all()
        )

        return [self._convert_to_flow_in_db(f) for f in flows], total

    def update_flow(
        self,
        db: Session,
        *,
        flow_id: int,
        flow_in: FlowUpdate,
        user_id: int,
    ) -> FlowInDB:
        """Update a Flow configuration."""
        flow = (
            db.query(FlowResource)
            .filter(
                FlowResource.id == flow_id,
                FlowResource.user_id == user_id,
                FlowResource.is_active == True,
            )
            .first()
        )

        if not flow:
            raise HTTPException(status_code=404, detail="Flow not found")

        flow_crd = Flow.model_validate(flow.json)
        update_data = flow_in.model_dump(exclude_unset=True)

        # Update team reference if changed
        if "team_id" in update_data:
            team = (
                db.query(Kind)
                .filter(
                    Kind.id == update_data["team_id"],
                    Kind.kind == "Team",
                    Kind.is_active == True,
                )
                .first()
            )
            if not team:
                raise HTTPException(
                    status_code=400,
                    detail=f"Team with id {update_data['team_id']} not found",
                )
            flow.team_id = update_data["team_id"]
            flow_crd.spec.teamRef.name = team.name
            flow_crd.spec.teamRef.namespace = team.namespace

        # Update workspace reference if changed
        if "workspace_id" in update_data:
            if update_data["workspace_id"]:
                workspace = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == update_data["workspace_id"],
                        TaskResource.kind == "Workspace",
                        TaskResource.is_active == True,
                    )
                    .first()
                )
                if not workspace:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Workspace with id {update_data['workspace_id']} not found",
                    )
                from app.schemas.flow import FlowWorkspaceRef

                flow_crd.spec.workspaceRef = FlowWorkspaceRef(
                    name=workspace.name, namespace=workspace.namespace
                )
            else:
                flow_crd.spec.workspaceRef = None
            flow.workspace_id = update_data["workspace_id"]

        # Update other fields
        if "display_name" in update_data:
            flow_crd.spec.displayName = update_data["display_name"]

        if "description" in update_data:
            flow_crd.spec.description = update_data["description"]

        if "task_type" in update_data:
            flow_crd.spec.taskType = update_data["task_type"]

        if "prompt_template" in update_data:
            flow_crd.spec.promptTemplate = update_data["prompt_template"]

        if "retry_count" in update_data:
            flow_crd.spec.retryCount = update_data["retry_count"]

        if "enabled" in update_data:
            flow_crd.spec.enabled = update_data["enabled"]
            flow.enabled = update_data["enabled"]

        # Update trigger configuration
        if "trigger_type" in update_data or "trigger_config" in update_data:
            trigger_type = update_data.get("trigger_type", flow.trigger_type)
            trigger_config = update_data.get(
                "trigger_config",
                self._extract_trigger_config(flow_crd.spec.trigger),
            )

            # Generate new webhook token if switching to event trigger
            if (
                trigger_type == FlowTriggerType.EVENT
                and flow.trigger_type != FlowTriggerType.EVENT.value
            ):
                flow.webhook_token = secrets.token_urlsafe(32)
            elif trigger_type != FlowTriggerType.EVENT:
                flow.webhook_token = None

            flow_crd.spec.trigger = self._build_trigger_config(
                trigger_type, trigger_config
            )
            flow.trigger_type = (
                trigger_type.value
                if isinstance(trigger_type, FlowTriggerType)
                else trigger_type
            )

            # Recalculate next execution time
            flow.next_execution_time = self._calculate_next_execution_time(
                trigger_type, trigger_config
            )

        # Update status with webhook URL
        if flow.webhook_token:
            if flow_crd.status is None:
                flow_crd.status = FlowStatus()
            flow_crd.status.webhookUrl = f"/api/flows/webhook/{flow.webhook_token}"

        # Save changes
        flow.json = flow_crd.model_dump(mode="json")
        flow.updated_at = datetime.utcnow()
        flag_modified(flow, "json")

        db.commit()
        db.refresh(flow)

        return self._convert_to_flow_in_db(flow)

    def delete_flow(
        self,
        db: Session,
        *,
        flow_id: int,
        user_id: int,
    ) -> None:
        """Delete a Flow (soft delete)."""
        flow = (
            db.query(FlowResource)
            .filter(
                FlowResource.id == flow_id,
                FlowResource.user_id == user_id,
                FlowResource.is_active == True,
            )
            .first()
        )

        if not flow:
            raise HTTPException(status_code=404, detail="Flow not found")

        # Soft delete
        flow.is_active = False
        flow.enabled = False
        flow.updated_at = datetime.utcnow()

        db.commit()

    def toggle_flow(
        self,
        db: Session,
        *,
        flow_id: int,
        user_id: int,
        enabled: bool,
    ) -> FlowInDB:
        """Enable or disable a Flow."""
        flow = (
            db.query(FlowResource)
            .filter(
                FlowResource.id == flow_id,
                FlowResource.user_id == user_id,
                FlowResource.is_active == True,
            )
            .first()
        )

        if not flow:
            raise HTTPException(status_code=404, detail="Flow not found")

        flow.enabled = enabled
        flow_crd = Flow.model_validate(flow.json)
        flow_crd.spec.enabled = enabled

        # Recalculate next execution time if enabling
        if enabled:
            flow.next_execution_time = self._calculate_next_execution_time(
                flow.trigger_type,
                self._extract_trigger_config(flow_crd.spec.trigger),
            )
        else:
            flow.next_execution_time = None

        flow.json = flow_crd.model_dump(mode="json")
        flow.updated_at = datetime.utcnow()
        flag_modified(flow, "json")

        db.commit()
        db.refresh(flow)

        return self._convert_to_flow_in_db(flow)

    def trigger_flow_manually(
        self,
        db: Session,
        *,
        flow_id: int,
        user_id: int,
    ) -> FlowExecutionInDB:
        """Manually trigger a Flow execution."""
        flow = (
            db.query(FlowResource)
            .filter(
                FlowResource.id == flow_id,
                FlowResource.user_id == user_id,
                FlowResource.is_active == True,
            )
            .first()
        )

        if not flow:
            raise HTTPException(status_code=404, detail="Flow not found")

        # Create execution record
        return self._create_execution(
            db,
            flow=flow,
            user_id=user_id,
            trigger_type="manual",
            trigger_reason="Manually triggered by user",
        )

    def get_flow_by_webhook_token(
        self,
        db: Session,
        *,
        webhook_token: str,
    ) -> Optional[FlowResource]:
        """Get a Flow by webhook token."""
        return (
            db.query(FlowResource)
            .filter(
                FlowResource.webhook_token == webhook_token,
                FlowResource.is_active == True,
                FlowResource.enabled == True,
            )
            .first()
        )

    def trigger_flow_by_webhook(
        self,
        db: Session,
        *,
        webhook_token: str,
        payload: Dict[str, Any],
    ) -> FlowExecutionInDB:
        """Trigger a Flow via webhook."""
        flow = self.get_flow_by_webhook_token(db, webhook_token=webhook_token)

        if not flow:
            raise HTTPException(status_code=404, detail="Flow not found or disabled")

        # Create execution with webhook data
        return self._create_execution(
            db,
            flow=flow,
            user_id=flow.user_id,
            trigger_type="webhook",
            trigger_reason="Triggered by webhook",
            extra_variables={"webhook_data": payload},
        )

    # ========== Execution Management ==========

    def list_executions(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
        flow_id: Optional[int] = None,
        status: Optional[List[FlowExecutionStatus]] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
    ) -> tuple[List[FlowExecutionInDB], int]:
        """List Flow executions (timeline view)."""
        query = db.query(FlowExecution).filter(FlowExecution.user_id == user_id)

        if flow_id:
            query = query.filter(FlowExecution.flow_id == flow_id)

        if status:
            query = query.filter(FlowExecution.status.in_([s.value for s in status]))

        if start_date:
            query = query.filter(FlowExecution.created_at >= start_date)

        if end_date:
            query = query.filter(FlowExecution.created_at <= end_date)

        total = query.count()
        executions = (
            query.order_by(desc(FlowExecution.created_at))
            .offset(skip)
            .limit(limit)
            .all()
        )

        # Enrich with flow details
        result = []
        flow_cache = {}
        for exec in executions:
            exec_dict = self._convert_execution_to_dict(exec)

            # Get flow details (cached)
            if exec.flow_id not in flow_cache:
                flow = db.query(FlowResource).filter(FlowResource.id == exec.flow_id).first()
                if flow:
                    flow_crd = Flow.model_validate(flow.json)
                    flow_cache[exec.flow_id] = {
                        "name": flow.name,
                        "display_name": flow_crd.spec.displayName,
                        "task_type": flow_crd.spec.taskType.value,
                    }

            flow_info = flow_cache.get(exec.flow_id, {})
            exec_dict["flow_name"] = flow_info.get("name")
            exec_dict["flow_display_name"] = flow_info.get("display_name")
            exec_dict["task_type"] = flow_info.get("task_type")

            # Get team name if available
            if exec.flow_id in flow_cache:
                flow = db.query(FlowResource).filter(FlowResource.id == exec.flow_id).first()
                if flow and flow.team_id:
                    team = db.query(Kind).filter(Kind.id == flow.team_id).first()
                    if team:
                        exec_dict["team_name"] = team.name

            result.append(FlowExecutionInDB(**exec_dict))

        return result, total

    def get_execution(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
    ) -> FlowExecutionInDB:
        """Get a specific Flow execution."""
        execution = (
            db.query(FlowExecution)
            .filter(
                FlowExecution.id == execution_id,
                FlowExecution.user_id == user_id,
            )
            .first()
        )

        if not execution:
            raise HTTPException(status_code=404, detail="Execution not found")

        exec_dict = self._convert_execution_to_dict(execution)

        # Get flow details
        flow = db.query(FlowResource).filter(FlowResource.id == execution.flow_id).first()
        if flow:
            flow_crd = Flow.model_validate(flow.json)
            exec_dict["flow_name"] = flow.name
            exec_dict["flow_display_name"] = flow_crd.spec.displayName
            exec_dict["task_type"] = flow_crd.spec.taskType.value

            if flow.team_id:
                team = db.query(Kind).filter(Kind.id == flow.team_id).first()
                if team:
                    exec_dict["team_name"] = team.name

        return FlowExecutionInDB(**exec_dict)

    def update_execution_status(
        self,
        db: Session,
        *,
        execution_id: int,
        status: FlowExecutionStatus,
        result_summary: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        """Update execution status (called by scheduler/task completion)."""
        execution = db.query(FlowExecution).filter(FlowExecution.id == execution_id).first()

        if not execution:
            return

        execution.status = status.value
        execution.updated_at = datetime.utcnow()

        if status == FlowExecutionStatus.RUNNING:
            execution.started_at = datetime.utcnow()
        elif status in (FlowExecutionStatus.COMPLETED, FlowExecutionStatus.FAILED):
            execution.completed_at = datetime.utcnow()

        if result_summary:
            execution.result_summary = result_summary

        if error_message:
            execution.error_message = error_message

        # Update flow statistics
        flow = db.query(FlowResource).filter(FlowResource.id == execution.flow_id).first()
        if flow:
            flow.last_execution_time = datetime.utcnow()
            flow.last_execution_status = status.value
            flow.execution_count += 1

            if status == FlowExecutionStatus.COMPLETED:
                flow.success_count += 1
            elif status == FlowExecutionStatus.FAILED:
                flow.failure_count += 1

            # Update CRD status
            flow_crd = Flow.model_validate(flow.json)
            if flow_crd.status is None:
                flow_crd.status = FlowStatus()
            flow_crd.status.lastExecutionTime = datetime.utcnow()
            flow_crd.status.lastExecutionStatus = status
            flow_crd.status.executionCount = flow.execution_count
            flow_crd.status.successCount = flow.success_count
            flow_crd.status.failureCount = flow.failure_count

            flow.json = flow_crd.model_dump(mode="json")
            flag_modified(flow, "json")

        db.commit()

    # ========== Helper Methods ==========

    def _create_execution(
        self,
        db: Session,
        *,
        flow: FlowResource,
        user_id: int,
        trigger_type: str,
        trigger_reason: str,
        extra_variables: Optional[Dict[str, Any]] = None,
    ) -> FlowExecutionInDB:
        """Create a new Flow execution record."""
        flow_crd = Flow.model_validate(flow.json)

        # Resolve prompt template
        resolved_prompt = self._resolve_prompt_template(
            flow_crd.spec.promptTemplate,
            flow_crd.spec.displayName,
            extra_variables,
        )

        execution = FlowExecution(
            user_id=user_id,
            flow_id=flow.id,
            trigger_type=trigger_type,
            trigger_reason=trigger_reason,
            prompt=resolved_prompt,
            status=FlowExecutionStatus.PENDING.value,
        )

        db.add(execution)
        db.commit()
        db.refresh(execution)

        exec_dict = self._convert_execution_to_dict(execution)
        exec_dict["flow_name"] = flow.name
        exec_dict["flow_display_name"] = flow_crd.spec.displayName
        exec_dict["task_type"] = flow_crd.spec.taskType.value

        return FlowExecutionInDB(**exec_dict)

    def _resolve_prompt_template(
        self,
        template: str,
        flow_name: str,
        extra_variables: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Resolve prompt template with variables."""
        result = template

        # Replace standard variables
        for var_name, var_func in self.TEMPLATE_VARIABLES.items():
            pattern = "{{" + var_name + "}}"
            if pattern in result:
                result = result.replace(pattern, var_func())

        # Replace flow_name
        result = result.replace("{{flow_name}}", flow_name)

        # Replace extra variables (like webhook_data)
        if extra_variables:
            for var_name, var_value in extra_variables.items():
                pattern = "{{" + var_name + "}}"
                if pattern in result:
                    if isinstance(var_value, (dict, list)):
                        import json

                        result = result.replace(pattern, json.dumps(var_value, ensure_ascii=False))
                    else:
                        result = result.replace(pattern, str(var_value))

        return result

    def _build_flow_crd(
        self,
        flow_in: FlowCreate,
        team: Kind,
        workspace: Optional[TaskResource],
        webhook_token: Optional[str],
    ) -> Flow:
        """Build Flow CRD JSON structure."""
        from app.schemas.flow import FlowTeamRef, FlowWorkspaceRef

        # Build trigger config
        trigger = self._build_trigger_config(
            flow_in.trigger_type, flow_in.trigger_config
        )

        spec = FlowSpec(
            displayName=flow_in.display_name,
            taskType=flow_in.task_type,
            trigger=trigger,
            teamRef=FlowTeamRef(name=team.name, namespace=team.namespace),
            workspaceRef=(
                FlowWorkspaceRef(name=workspace.name, namespace=workspace.namespace)
                if workspace
                else None
            ),
            promptTemplate=flow_in.prompt_template,
            retryCount=flow_in.retry_count,
            enabled=flow_in.enabled,
            description=flow_in.description,
        )

        status = FlowStatus()
        if webhook_token:
            status.webhookUrl = f"/api/flows/webhook/{webhook_token}"

        return Flow(
            metadata=FlowMetadata(
                name=flow_in.name,
                namespace=flow_in.namespace,
                displayName=flow_in.display_name,
            ),
            spec=spec,
            status=status,
        )

    def _build_trigger_config(
        self,
        trigger_type: FlowTriggerType,
        trigger_config: Dict[str, Any],
    ) -> FlowTriggerConfig:
        """Build FlowTriggerConfig from trigger type and config dict."""
        from app.schemas.flow import (
            CronTriggerConfig,
            EventTriggerConfig,
            FlowEventType,
            GitPushEventConfig,
            IntervalTriggerConfig,
            OneTimeTriggerConfig,
        )

        trigger_type_enum = (
            trigger_type
            if isinstance(trigger_type, FlowTriggerType)
            else FlowTriggerType(trigger_type)
        )

        if trigger_type_enum == FlowTriggerType.CRON:
            return FlowTriggerConfig(
                type=trigger_type_enum,
                cron=CronTriggerConfig(
                    expression=trigger_config.get("expression", "0 9 * * *"),
                    timezone=trigger_config.get("timezone", "UTC"),
                ),
            )
        elif trigger_type_enum == FlowTriggerType.INTERVAL:
            return FlowTriggerConfig(
                type=trigger_type_enum,
                interval=IntervalTriggerConfig(
                    value=trigger_config.get("value", 1),
                    unit=trigger_config.get("unit", "hours"),
                ),
            )
        elif trigger_type_enum == FlowTriggerType.ONE_TIME:
            return FlowTriggerConfig(
                type=trigger_type_enum,
                one_time=OneTimeTriggerConfig(
                    execute_at=datetime.fromisoformat(trigger_config.get("execute_at")),
                ),
            )
        elif trigger_type_enum == FlowTriggerType.EVENT:
            event_type = trigger_config.get("event_type", "webhook")
            git_push_config = None

            if event_type == "git_push":
                git_push_data = trigger_config.get("git_push", {})
                git_push_config = GitPushEventConfig(
                    repository=git_push_data.get("repository", ""),
                    branch=git_push_data.get("branch"),
                )

            return FlowTriggerConfig(
                type=trigger_type_enum,
                event=EventTriggerConfig(
                    event_type=FlowEventType(event_type),
                    git_push=git_push_config,
                ),
            )

        raise ValueError(f"Unknown trigger type: {trigger_type}")

    def _extract_trigger_config(self, trigger: FlowTriggerConfig) -> Dict[str, Any]:
        """Extract trigger config dict from FlowTriggerConfig."""
        if trigger.type == FlowTriggerType.CRON and trigger.cron:
            return {
                "expression": trigger.cron.expression,
                "timezone": trigger.cron.timezone,
            }
        elif trigger.type == FlowTriggerType.INTERVAL and trigger.interval:
            return {
                "value": trigger.interval.value,
                "unit": trigger.interval.unit,
            }
        elif trigger.type == FlowTriggerType.ONE_TIME and trigger.one_time:
            return {
                "execute_at": trigger.one_time.execute_at.isoformat(),
            }
        elif trigger.type == FlowTriggerType.EVENT and trigger.event:
            result = {"event_type": trigger.event.event_type.value}
            if trigger.event.git_push:
                result["git_push"] = {
                    "repository": trigger.event.git_push.repository,
                    "branch": trigger.event.git_push.branch,
                }
            return result

        return {}

    def _calculate_next_execution_time(
        self,
        trigger_type: FlowTriggerType,
        trigger_config: Dict[str, Any],
    ) -> Optional[datetime]:
        """Calculate the next execution time based on trigger configuration."""
        trigger_type_enum = (
            trigger_type
            if isinstance(trigger_type, FlowTriggerType)
            else FlowTriggerType(trigger_type)
        )

        now = datetime.utcnow()

        if trigger_type_enum == FlowTriggerType.CRON:
            # Use croniter to calculate next run
            try:
                from croniter import croniter

                cron_expr = trigger_config.get("expression", "0 9 * * *")
                iter = croniter(cron_expr, now)
                return iter.get_next(datetime)
            except Exception as e:
                logger.warning(f"Failed to parse cron expression: {e}")
                return None

        elif trigger_type_enum == FlowTriggerType.INTERVAL:
            value = trigger_config.get("value", 1)
            unit = trigger_config.get("unit", "hours")

            if unit == "minutes":
                return now + timedelta(minutes=value)
            elif unit == "hours":
                return now + timedelta(hours=value)
            elif unit == "days":
                return now + timedelta(days=value)

        elif trigger_type_enum == FlowTriggerType.ONE_TIME:
            execute_at = trigger_config.get("execute_at")
            if execute_at:
                if isinstance(execute_at, str):
                    return datetime.fromisoformat(execute_at.replace("Z", "+00:00"))
                return execute_at

        # Event triggers don't have scheduled next execution
        return None

    def _convert_to_flow_in_db(self, flow: FlowResource) -> FlowInDB:
        """Convert FlowResource to FlowInDB."""
        flow_crd = Flow.model_validate(flow.json)

        # Build webhook URL
        webhook_url = None
        if flow.webhook_token:
            webhook_url = f"/api/flows/webhook/{flow.webhook_token}"

        return FlowInDB(
            id=flow.id,
            user_id=flow.user_id,
            name=flow.name,
            namespace=flow.namespace,
            display_name=flow_crd.spec.displayName,
            description=flow_crd.spec.description,
            task_type=flow_crd.spec.taskType,
            trigger_type=FlowTriggerType(flow.trigger_type),
            trigger_config=self._extract_trigger_config(flow_crd.spec.trigger),
            team_id=flow.team_id,
            workspace_id=flow.workspace_id,
            prompt_template=flow_crd.spec.promptTemplate,
            retry_count=flow_crd.spec.retryCount,
            enabled=flow.enabled,
            webhook_url=webhook_url,
            last_execution_time=flow.last_execution_time,
            last_execution_status=flow.last_execution_status,
            next_execution_time=flow.next_execution_time,
            execution_count=flow.execution_count,
            success_count=flow.success_count,
            failure_count=flow.failure_count,
            created_at=flow.created_at,
            updated_at=flow.updated_at,
        )

    def _convert_execution_to_dict(self, execution: FlowExecution) -> Dict[str, Any]:
        """Convert FlowExecution to dict."""
        return {
            "id": execution.id,
            "user_id": execution.user_id,
            "flow_id": execution.flow_id,
            "task_id": execution.task_id,
            "trigger_type": execution.trigger_type,
            "trigger_reason": execution.trigger_reason,
            "prompt": execution.prompt,
            "status": FlowExecutionStatus(execution.status),
            "result_summary": execution.result_summary,
            "error_message": execution.error_message,
            "retry_attempt": execution.retry_attempt,
            "started_at": execution.started_at,
            "completed_at": execution.completed_at,
            "created_at": execution.created_at,
            "updated_at": execution.updated_at,
        }


flow_service = FlowService()

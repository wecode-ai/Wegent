# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
AI Flow service layer for managing Flow configurations and executions.
"""
import json
import logging
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Set

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


# ========== State Machine for FlowExecution ==========

# Valid state transitions for FlowExecution
# Key: current state, Value: set of valid next states
VALID_STATE_TRANSITIONS: Dict[FlowExecutionStatus, Set[FlowExecutionStatus]] = {
    FlowExecutionStatus.PENDING: {
        FlowExecutionStatus.RUNNING,
        FlowExecutionStatus.CANCELLED,
        FlowExecutionStatus.FAILED,  # Can fail before starting (e.g., validation error)
    },
    FlowExecutionStatus.RUNNING: {
        FlowExecutionStatus.COMPLETED,
        FlowExecutionStatus.FAILED,
        FlowExecutionStatus.RETRYING,
        FlowExecutionStatus.CANCELLED,  # Allow cancellation of running executions
    },
    FlowExecutionStatus.RETRYING: {
        FlowExecutionStatus.RUNNING,
        FlowExecutionStatus.FAILED,
        FlowExecutionStatus.CANCELLED,
    },
    FlowExecutionStatus.COMPLETED: set(),  # Terminal state
    FlowExecutionStatus.FAILED: set(),  # Terminal state
    FlowExecutionStatus.CANCELLED: set(),  # Terminal state
}


class InvalidStateTransitionError(Exception):
    """Raised when an invalid state transition is attempted."""

    def __init__(self, current_state: str, new_state: str, execution_id: int):
        self.current_state = current_state
        self.new_state = new_state
        self.execution_id = execution_id
        super().__init__(
            f"Invalid state transition for execution {execution_id}: "
            f"{current_state} -> {new_state}"
        )


class OptimisticLockError(Exception):
    """Raised when optimistic lock conflict is detected."""

    def __init__(self, execution_id: int, expected_version: int, actual_version: int):
        self.execution_id = execution_id
        self.expected_version = expected_version
        self.actual_version = actual_version
        super().__init__(
            f"Optimistic lock conflict for execution {execution_id}: "
            f"expected version {expected_version}, got {actual_version}"
        )


def validate_state_transition(
    current_state: FlowExecutionStatus, new_state: FlowExecutionStatus
) -> bool:
    """
    Validate if a state transition is allowed.

    Args:
        current_state: Current execution status
        new_state: Desired new status

    Returns:
        True if transition is valid, False otherwise
    """
    if current_state == new_state:
        return True  # No-op transitions are always valid

    valid_next_states = VALID_STATE_TRANSITIONS.get(current_state, set())
    return new_state in valid_next_states


class FlowService:
    """Service class for AI Flow operations."""

    # Supported prompt template variables
    TEMPLATE_VARIABLES = {
        "date": lambda: datetime.now().strftime("%Y-%m-%d"),
        "time": lambda: datetime.now().strftime("%H:%M:%S"),
        "datetime": lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": lambda: str(int(datetime.now().timestamp())),
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
        workspace_id = flow_in.workspace_id
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
        elif flow_in.git_repo:
            # Create workspace from git repo info if no workspace_id provided
            workspace_id = self._create_or_get_workspace(
                db,
                user_id=user_id,
                git_repo=flow_in.git_repo,
                git_repo_id=flow_in.git_repo_id,
                git_domain=flow_in.git_domain or "github.com",
                branch_name=flow_in.branch_name or "main",
            )

        # Generate webhook token and secret for event-type flows
        webhook_token = None
        webhook_secret = None
        if flow_in.trigger_type == FlowTriggerType.EVENT:
            webhook_token = secrets.token_urlsafe(32)
            webhook_secret = secrets.token_urlsafe(32)  # HMAC signing secret

        # Build CRD JSON
        flow_crd = self._build_flow_crd(flow_in, team, workspace, webhook_token)

        # Calculate next execution time for scheduled flows
        next_execution_time = self.calculate_next_execution_time(
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
            workspace_id=workspace_id,
            webhook_token=webhook_token,
            webhook_secret=webhook_secret,
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

        if "timeout_seconds" in update_data:
            flow_crd.spec.timeoutSeconds = update_data["timeout_seconds"]

        if "enabled" in update_data:
            flow_crd.spec.enabled = update_data["enabled"]
            flow.enabled = update_data["enabled"]

        # Update trigger configuration
        if "trigger_type" in update_data or "trigger_config" in update_data:
            trigger_type = update_data.get("trigger_type", flow.trigger_type)
            trigger_config = update_data.get(
                "trigger_config",
                self.extract_trigger_config(flow_crd.spec.trigger),
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
            flow.next_execution_time = self.calculate_next_execution_time(
                trigger_type, trigger_config
            )

        # Update status with webhook URL
        if flow.webhook_token:
            if flow_crd.status is None:
                flow_crd.status = FlowStatus()
            flow_crd.status.webhookUrl = f"/api/flows/webhook/{flow.webhook_token}"

        # Save changes
        flow.json = flow_crd.model_dump(mode="json")
        flow.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
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
        flow.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)

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
            flow.next_execution_time = self.calculate_next_execution_time(
                flow.trigger_type,
                self.extract_trigger_config(flow_crd.spec.trigger),
            )
        else:
            flow.next_execution_time = None

        flow.json = flow_crd.model_dump(mode="json")
        flow.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
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
        execution = self.create_execution(
            db,
            flow=flow,
            user_id=user_id,
            trigger_type="manual",
            trigger_reason="Manually triggered by user",
        )

        # Dispatch Celery task for execution
        self._dispatch_flow_execution(flow, execution)

        return execution

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
        execution = self.create_execution(
            db,
            flow=flow,
            user_id=flow.user_id,
            trigger_type="webhook",
            trigger_reason="Triggered by webhook",
            extra_variables={"webhook_data": payload},
        )

        # Dispatch Celery task for execution
        self._dispatch_flow_execution(flow, execution)

        return execution

    # ========== Execution Management ==========

    def cancel_execution(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
    ) -> FlowExecutionInDB:
        """
        Cancel a flow execution.

        This method allows users to manually cancel a running or pending execution.
        It will:
        1. Validate the execution exists and belongs to the user
        2. Check if the execution can be cancelled (not in terminal state)
        3. Update the status to CANCELLED
        4. Emit WebSocket event to notify frontend

        Args:
            db: Database session
            execution_id: ID of the execution to cancel
            user_id: ID of the user requesting cancellation

        Returns:
            Updated FlowExecutionInDB

        Raises:
            HTTPException: If execution not found or cannot be cancelled
        """
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

        current_status = FlowExecutionStatus(execution.status)

        # Check if execution is in a terminal state
        terminal_states = {
            FlowExecutionStatus.COMPLETED,
            FlowExecutionStatus.FAILED,
            FlowExecutionStatus.CANCELLED,
        }
        if current_status in terminal_states:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot cancel execution in {current_status.value} state",
            )

        # Validate state transition
        if not validate_state_transition(current_status, FlowExecutionStatus.CANCELLED):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot transition from {current_status.value} to CANCELLED",
            )

        # Update execution status
        now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
        execution.status = FlowExecutionStatus.CANCELLED.value
        execution.error_message = "Cancelled by user"
        execution.completed_at = now_utc
        execution.updated_at = now_utc

        # Calculate how long it's been running (if in RUNNING state)
        running_info = ""
        if current_status == FlowExecutionStatus.RUNNING and execution.started_at:
            running_duration = now_utc - execution.started_at
            running_hours = running_duration.total_seconds() / 3600
            running_info = f", running_hours={running_hours:.2f}h"

        db.commit()
        db.refresh(execution)

        logger.info(
            f"[Flow] Execution {execution_id} cancelled by user {user_id}: "
            f"flow_id={execution.flow_id}, task_id={execution.task_id}, "
            f"previous_status={current_status.value}{running_info}"
        )

        # Emit WebSocket event
        self._emit_flow_execution_update(
            db=db,
            execution=execution,
            status=FlowExecutionStatus.CANCELLED,
            error_message="Cancelled by user",
        )

        # Build response
        exec_dict = self._convert_execution_to_dict(execution)

        # Get flow details
        flow = (
            db.query(FlowResource).filter(FlowResource.id == execution.flow_id).first()
        )
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
        """List Flow executions (timeline view).

        Optimized to avoid N+1 queries by batch loading related flows and teams.
        """
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

        if not executions:
            return [], total

        # Batch load all related flows (fixes N+1 query issue)
        flow_ids = list(set(e.flow_id for e in executions))
        flows = db.query(FlowResource).filter(FlowResource.id.in_(flow_ids)).all()
        flow_map = {f.id: f for f in flows}

        # Build flow cache with parsed CRD data
        flow_cache = {}
        for flow in flows:
            flow_crd = Flow.model_validate(flow.json)
            flow_cache[flow.id] = {
                "name": flow.name,
                "display_name": flow_crd.spec.displayName,
                "task_type": flow_crd.spec.taskType.value,
                "team_id": flow.team_id,
            }

        # Batch load all related teams (fixes N+1 query issue)
        team_ids = list(
            set(fc["team_id"] for fc in flow_cache.values() if fc["team_id"])
        )
        team_map = {}
        if team_ids:
            teams = db.query(Kind).filter(Kind.id.in_(team_ids)).all()
            team_map = {t.id: t for t in teams}

        # Build result list (no additional queries)
        result = []
        for exec in executions:
            exec_dict = self._convert_execution_to_dict(exec)

            flow_info = flow_cache.get(exec.flow_id, {})
            exec_dict["flow_name"] = flow_info.get("name")
            exec_dict["flow_display_name"] = flow_info.get("display_name")
            exec_dict["task_type"] = flow_info.get("task_type")

            # Get team name from cache
            team_id = flow_info.get("team_id")
            if team_id and team_id in team_map:
                exec_dict["team_name"] = team_map[team_id].name

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
        flow = (
            db.query(FlowResource).filter(FlowResource.id == execution.flow_id).first()
        )
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
        expected_version: Optional[int] = None,
    ) -> bool:
        """
        Update execution status with atomic update and state machine validation.

        This method ensures:
        1. State transitions are valid (follows the state machine)
        2. Concurrent updates are handled atomically via WHERE clause
        3. Statistics are updated atomically

        Args:
            db: Database session
            execution_id: ID of the execution to update
            status: New status to set
            result_summary: Optional result summary
            error_message: Optional error message
            expected_version: Expected version for optimistic locking (optional)

        Returns:
            True if update was successful, False if skipped due to invalid transition

        Raises:
            OptimisticLockError: If version conflict detected and expected_version was provided
        """
        # Convert string status to enum if needed
        if isinstance(status, str):
            status = FlowExecutionStatus(status)

        # First, get the current status to validate state transition
        execution = (
            db.query(FlowExecution).filter(FlowExecution.id == execution_id).first()
        )

        if not execution:
            logger.warning(
                f"[Flow] Execution {execution_id} not found for status update"
            )
            return False

        current_status = FlowExecutionStatus(execution.status)
        current_version = getattr(execution, "version", 0) or 0

        # Validate state transition
        if not validate_state_transition(current_status, status):
            logger.warning(
                f"[Flow] Invalid state transition for execution {execution_id}: "
                f"{current_status.value} -> {status.value}, "
                f"flow_id={execution.flow_id}, task_id={execution.task_id}"
            )
            return False

        # Check optimistic lock if expected_version is provided
        if expected_version is not None and current_version != expected_version:
            raise OptimisticLockError(execution_id, expected_version, current_version)

        # Use UTC for all timestamps
        now_utc = datetime.now(timezone.utc).replace(tzinfo=None)

        # Build atomic update values
        update_values = {
            "status": status.value,
            "updated_at": now_utc,
            "version": current_version + 1,
        }

        if status == FlowExecutionStatus.RUNNING:
            update_values["started_at"] = now_utc
        elif status in (FlowExecutionStatus.COMPLETED, FlowExecutionStatus.FAILED):
            update_values["completed_at"] = now_utc

        if result_summary:
            update_values["result_summary"] = result_summary

        if error_message:
            update_values["error_message"] = error_message

        # Atomic update with WHERE clause to prevent race conditions
        # Only update if current status and version match what we read
        rows_updated = (
            db.query(FlowExecution)
            .filter(
                FlowExecution.id == execution_id,
                FlowExecution.status == current_status.value,
                FlowExecution.version == current_version,
            )
            .update(update_values, synchronize_session=False)
        )

        if rows_updated == 0:
            # Another process updated the execution, refresh and check
            db.refresh(execution)
            logger.warning(
                f"[Flow] Concurrent update detected for execution {execution_id}: "
                f"expected status={current_status.value}, version={current_version}, "
                f"actual status={execution.status}, version={execution.version}"
            )
            return False

        # Refresh the execution object after atomic update
        db.refresh(execution)

        # Update flow statistics (only for terminal states to avoid double counting)
        if status in (FlowExecutionStatus.COMPLETED, FlowExecutionStatus.FAILED):
            flow = (
                db.query(FlowResource)
                .filter(FlowResource.id == execution.flow_id)
                .first()
            )
            if flow:
                flow.last_execution_time = now_utc
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
                flow_crd.status.lastExecutionTime = now_utc
                flow_crd.status.lastExecutionStatus = status
                flow_crd.status.executionCount = flow.execution_count
                flow_crd.status.successCount = flow.success_count
                flow_crd.status.failureCount = flow.failure_count

                flow.json = flow_crd.model_dump(mode="json")
                flag_modified(flow, "json")

        db.commit()

        # Build detailed log message
        log_parts = [
            f"[Flow] Execution {execution_id} status changed: {current_status.value} -> {status.value}",
            f"flow_id={execution.flow_id}",
            f"task_id={execution.task_id}",
        ]
        if error_message:
            log_parts.append(f"error={error_message[:100]}")
        if result_summary:
            log_parts.append(f"summary={result_summary[:50]}")

        # Use info level for terminal states, debug for intermediate
        if status in (
            FlowExecutionStatus.COMPLETED,
            FlowExecutionStatus.FAILED,
            FlowExecutionStatus.CANCELLED,
        ):
            logger.info(", ".join(log_parts))
        else:
            logger.debug(", ".join(log_parts))

        # Emit WebSocket event to notify frontend of the status update
        logger.debug(
            f"[Flow] Emitting WS event for execution {execution_id}, user_id={execution.user_id}"
        )
        self._emit_flow_execution_update(
            db=db,
            execution=execution,
            status=status,
            result_summary=result_summary,
            error_message=error_message,
        )

        return True

    # ========== Helper Methods ==========

    def create_execution(
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

        # Validate resolved prompt is not empty
        if not resolved_prompt or not resolved_prompt.strip():
            raise ValueError(
                f"Prompt template resolved to empty string for flow {flow.id} ({flow.name}). "
                f"Template: '{flow_crd.spec.promptTemplate}'"
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

        logger.info(
            f"[Flow] Created execution {execution.id}: "
            f"flow_id={flow.id}, flow_name={flow.name}, "
            f"trigger_type={trigger_type}, trigger_reason={trigger_reason}, "
            f"user_id={user_id}, status=PENDING"
        )

        exec_dict = self._convert_execution_to_dict(execution)
        exec_dict["flow_name"] = flow.name
        exec_dict["flow_display_name"] = flow_crd.spec.displayName
        exec_dict["task_type"] = flow_crd.spec.taskType.value

        return FlowExecutionInDB(**exec_dict)

    def dispatch_flow_execution(
        self,
        flow: FlowResource,
        execution: FlowExecutionInDB,
        use_sync: bool = False,
    ) -> None:
        """
        Dispatch a Flow execution for async processing.

        This is the unified dispatch method used by all trigger paths:
        - Manual trigger (trigger_flow_manually)
        - Webhook trigger (trigger_flow_by_webhook)
        - Automatic trigger (check_due_flows / check_due_flows_sync)

        Args:
            flow: The Flow resource to execute
            execution: The execution record created by create_execution()
            use_sync: If True, use sync execution (for non-Celery backends)
        """
        from app.core.config import settings

        flow_crd = Flow.model_validate(flow.json)
        timeout_seconds = getattr(
            flow_crd.spec,
            "timeout_seconds",
            settings.FLOW_DEFAULT_TIMEOUT_SECONDS,
        )
        retry_count = flow_crd.spec.retryCount or settings.FLOW_DEFAULT_RETRY_COUNT

        if use_sync:
            # Sync execution for non-Celery backends (APScheduler, XXL-JOB)
            import threading

            from app.tasks.flow_tasks import execute_flow_task_sync

            logger.info(
                f"[Flow] Dispatching execution {execution.id} (sync): "
                f"flow_id={flow.id}, timeout={timeout_seconds}s, retry_count={retry_count}"
            )

            thread = threading.Thread(
                target=execute_flow_task_sync,
                args=(flow.id, execution.id, timeout_seconds),
                daemon=True,
            )
            thread.start()
        else:
            # Celery async execution (default)
            from app.tasks.flow_tasks import execute_flow_task

            logger.info(
                f"[Flow] Dispatching execution {execution.id} (celery): "
                f"flow_id={flow.id}, timeout={timeout_seconds}s, retry_count={retry_count}"
            )

            execute_flow_task.apply_async(
                args=[flow.id, execution.id],
                kwargs={"timeout_seconds": timeout_seconds},
                max_retries=retry_count,
            )

    # Keep the old name as alias for backward compatibility
    _dispatch_flow_execution = dispatch_flow_execution

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
                        result = result.replace(
                            pattern, json.dumps(var_value, ensure_ascii=False)
                        )
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
            timeoutSeconds=flow_in.timeout_seconds,
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

    def extract_trigger_config(self, trigger: FlowTriggerConfig) -> Dict[str, Any]:
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

    def calculate_next_execution_time(
        self,
        trigger_type: FlowTriggerType,
        trigger_config: Dict[str, Any],
    ) -> Optional[datetime]:
        """Calculate the next execution time based on trigger configuration.

        For cron triggers, the timezone from trigger_config is used to interpret
        the cron expression. The returned datetime is always in UTC for storage.

        For example, if cron is "0 9 * * *" with timezone "Asia/Shanghai",
        it means 9:00 AM Shanghai time, which is 1:00 AM UTC.

        All returned datetimes are naive UTC (no tzinfo) for database storage.
        """
        from zoneinfo import ZoneInfo

        trigger_type_enum = (
            trigger_type
            if isinstance(trigger_type, FlowTriggerType)
            else FlowTriggerType(trigger_type)
        )

        # Use UTC as the reference time
        utc_tz = ZoneInfo("UTC")
        now_utc = datetime.now(utc_tz)

        if trigger_type_enum == FlowTriggerType.CRON:
            # Use croniter to calculate next run with timezone support
            try:
                from croniter import croniter

                cron_expr = trigger_config.get("expression", "0 9 * * *")
                timezone_str = trigger_config.get("timezone", "UTC")

                # Get the user's timezone
                try:
                    user_tz = ZoneInfo(timezone_str)
                except Exception:
                    logger.warning(
                        f"Invalid timezone '{timezone_str}', falling back to UTC"
                    )
                    user_tz = utc_tz

                # Convert current UTC time to user's timezone
                now_user_tz = now_utc.astimezone(user_tz)

                # Calculate next execution in user's timezone
                iter = croniter(cron_expr, now_user_tz)
                next_user_tz = iter.get_next(datetime)

                # Ensure the result has timezone info
                if next_user_tz.tzinfo is None:
                    next_user_tz = next_user_tz.replace(tzinfo=user_tz)

                # Convert back to UTC
                next_utc = next_user_tz.astimezone(utc_tz)

                logger.debug(
                    f"Cron calculation: expr={cron_expr}, tz={timezone_str}, "
                    f"now_utc={now_utc}, now_user_tz={now_user_tz}, "
                    f"next_user_tz={next_user_tz}, next_utc={next_utc}"
                )

                # Return naive UTC datetime for database storage
                return next_utc.replace(tzinfo=None)
            except Exception as e:
                logger.warning(f"Failed to parse cron expression: {e}")
                return None

        elif trigger_type_enum == FlowTriggerType.INTERVAL:
            value = trigger_config.get("value", 1)
            unit = trigger_config.get("unit", "hours")

            # Calculate interval from UTC now
            now_naive_utc = now_utc.replace(tzinfo=None)
            if unit == "minutes":
                return now_naive_utc + timedelta(minutes=value)
            elif unit == "hours":
                return now_naive_utc + timedelta(hours=value)
            elif unit == "days":
                return now_naive_utc + timedelta(days=value)

        elif trigger_type_enum == FlowTriggerType.ONE_TIME:
            execute_at = trigger_config.get("execute_at")
            if execute_at:
                if isinstance(execute_at, str):
                    # Parse ISO format, handle both timezone-aware and naive
                    parsed = datetime.fromisoformat(execute_at.replace("Z", "+00:00"))
                    if parsed.tzinfo is not None:
                        # Convert to UTC and strip tzinfo
                        return parsed.astimezone(utc_tz).replace(tzinfo=None)
                    # Assume naive datetime is already UTC
                    return parsed
                elif hasattr(execute_at, "tzinfo") and execute_at.tzinfo is not None:
                    return execute_at.astimezone(utc_tz).replace(tzinfo=None)
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
            trigger_config=self.extract_trigger_config(flow_crd.spec.trigger),
            team_id=flow.team_id,
            workspace_id=flow.workspace_id,
            prompt_template=flow_crd.spec.promptTemplate,
            retry_count=flow_crd.spec.retryCount,
            timeout_seconds=flow_crd.spec.timeoutSeconds,
            enabled=flow.enabled,
            webhook_url=webhook_url,
            webhook_secret=flow.webhook_secret,
            last_execution_time=flow.last_execution_time,
            last_execution_status=flow.last_execution_status,
            next_execution_time=flow.next_execution_time,
            execution_count=flow.execution_count,
            success_count=flow.success_count,
            failure_count=flow.failure_count,
            created_at=flow.created_at,
            updated_at=flow.updated_at,
        )

    def _create_or_get_workspace(
        self,
        db: Session,
        *,
        user_id: int,
        git_repo: str,
        git_repo_id: Optional[int],
        git_domain: str,
        branch_name: str,
    ) -> int:
        """
        Create or get a workspace for the given git repository.

        This method checks if a workspace already exists for the given repo/branch,
        and creates one if it doesn't exist.

        Args:
            db: Database session
            user_id: User ID
            git_repo: Git repository name (e.g., 'owner/repo')
            git_repo_id: Git repository ID
            git_domain: Git domain (e.g., 'github.com')
            branch_name: Git branch name

        Returns:
            Workspace ID
        """
        from app.core.constants import KIND_WORKSPACE
        from app.models.task import TaskResource

        # Generate a unique workspace name based on repo and branch
        workspace_name = f"{git_repo.replace('/', '-')}-{branch_name}".lower()[:100]
        namespace = "default"

        # Check if workspace already exists
        existing = (
            db.query(TaskResource)
            .filter(
                TaskResource.user_id == user_id,
                TaskResource.kind == KIND_WORKSPACE,
                TaskResource.name == workspace_name,
                TaskResource.namespace == namespace,
                TaskResource.is_active == True,
            )
            .first()
        )

        if existing:
            return existing.id

        # Build git URL from domain and repo
        git_url = f"https://{git_domain}/{git_repo}.git"

        # Create workspace CRD JSON
        workspace_json = {
            "apiVersion": "wegent.io/v1",
            "kind": "Workspace",
            "metadata": {
                "name": workspace_name,
                "namespace": namespace,
            },
            "spec": {
                "repository": {
                    "gitUrl": git_url,
                    "gitRepo": git_repo,
                    "gitRepoId": git_repo_id or 0,
                    "gitDomain": git_domain,
                    "branchName": branch_name,
                }
            },
        }

        # Create new workspace
        workspace = TaskResource(
            user_id=user_id,
            kind=KIND_WORKSPACE,
            name=workspace_name,
            namespace=namespace,
            json=workspace_json,
            is_active=True,
        )

        db.add(workspace)
        db.flush()  # Get the ID without committing

        return workspace.id

    def _emit_flow_execution_update(
        self,
        db: Session,
        execution: FlowExecution,
        status: FlowExecutionStatus,
        result_summary: Optional[str] = None,
        error_message: Optional[str] = None,
    ) -> None:
        """
        Emit flow:execution_update WebSocket event to notify frontend.

        Uses sync Redis publish to Socket.IO's internal channel to avoid
        asyncio event loop conflicts in Celery workers.

        Args:
            db: Database session
            execution: The FlowExecution record
            status: New execution status
            result_summary: Optional result summary
            error_message: Optional error message
        """
        # Get flow details for the payload
        flow_name: Optional[str] = None
        flow_display_name: Optional[str] = None
        team_name: Optional[str] = None
        task_type: Optional[str] = None

        try:
            flow = (
                db.query(FlowResource)
                .filter(FlowResource.id == execution.flow_id)
                .first()
            )
            if flow:
                flow_crd = Flow.model_validate(flow.json)
                flow_name = flow.name
                flow_display_name = flow_crd.spec.displayName
                task_type = flow_crd.spec.taskType.value

                if flow.team_id:
                    team = db.query(Kind).filter(Kind.id == flow.team_id).first()
                    if team:
                        team_name = team.name
        except Exception as e:
            logger.warning(f"Failed to get flow details for WS event: {e}")

        # Build payload
        payload = {
            "execution_id": execution.id,
            "flow_id": execution.flow_id,
            "status": status.value,
            "task_id": execution.task_id,
            "prompt": execution.prompt,
            "result_summary": result_summary or execution.result_summary,
            "error_message": error_message or execution.error_message,
            "trigger_reason": execution.trigger_reason,
            "created_at": (
                execution.created_at.isoformat() if execution.created_at else None
            ),
            "updated_at": (
                execution.updated_at.isoformat() if execution.updated_at else None
            ),
        }

        # Add optional fields
        if flow_name:
            payload["flow_name"] = flow_name
        if flow_display_name:
            payload["flow_display_name"] = flow_display_name
        if team_name:
            payload["team_name"] = team_name
        if task_type:
            payload["task_type"] = task_type

        # Publish to Socket.IO via sync Redis (works in Celery workers)
        try:
            import redis

            from app.core.config import settings

            # Use sync Redis client to publish to Socket.IO's internal channel
            redis_client = redis.from_url(settings.REDIS_URL, decode_responses=False)

            # Socket.IO AsyncRedisManager uses this channel format
            socketio_channel = "socketio"

            # Build Socket.IO internal message format
            socketio_message = {
                "method": "emit",
                "event": "flow:execution_update",
                "data": [payload],
                "namespace": "/chat",
                "room": f"user:{execution.user_id}",
            }

            # Publish to Redis
            redis_client.publish(socketio_channel, json.dumps(socketio_message))
            redis_client.close()

            logger.debug(
                f"[WS] Published flow:execution_update to Redis for execution={execution.id} "
                f"status={status.value} user_id={execution.user_id}"
            )
        except Exception as e:
            logger.error(
                f"[WS] Failed to publish flow:execution_update to Redis: {e}",
                exc_info=True,
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

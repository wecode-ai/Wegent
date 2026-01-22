# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Background Execution management for Subscription service.

This module handles:
- Creating execution records
- Updating execution status
- Listing and querying executions
- Cancelling executions
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import desc
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.subscription import BackgroundExecution
from app.schemas.subscription import (
    BackgroundExecutionInDB,
    BackgroundExecutionStatus,
    Subscription,
    SubscriptionStatus,
    SubscriptionVisibility,
)
from app.services.subscription.helpers import resolve_prompt_template
from app.services.subscription.state_machine import (
    OptimisticLockError,
    is_terminal_state,
    validate_state_transition,
)
from app.services.subscription.websocket import emit_background_execution_update

logger = logging.getLogger(__name__)


class BackgroundExecutionManager:
    """Manager class for BackgroundExecution operations."""

    def create_execution(
        self,
        db: Session,
        *,
        subscription: Kind,
        user_id: int,
        trigger_type: str,
        trigger_reason: str,
        extra_variables: Optional[Dict[str, Any]] = None,
    ) -> BackgroundExecutionInDB:
        """
        Create a new BackgroundExecution record.

        Args:
            db: Database session
            subscription: The Subscription Kind record
            user_id: User ID
            trigger_type: Type of trigger (cron, interval, webhook, manual)
            trigger_reason: Human-readable trigger reason
            extra_variables: Optional extra variables for prompt template

        Returns:
            BackgroundExecutionInDB object
        """
        subscription_crd = Subscription.model_validate(subscription.json)
        internal = subscription.json.get("_internal", {})

        # For rental subscriptions, get promptTemplate from source subscription
        prompt_template = subscription_crd.spec.promptTemplate
        display_name = subscription_crd.spec.displayName

        if internal.get("is_rental", False):
            source_subscription_id = internal.get("source_subscription_id")
            if source_subscription_id:
                source_subscription = (
                    db.query(Kind)
                    .filter(
                        Kind.id == source_subscription_id,
                        Kind.kind == "Subscription",
                        Kind.is_active == True,
                    )
                    .first()
                )
                if source_subscription:
                    source_crd = Subscription.model_validate(source_subscription.json)
                    # Use source subscription's promptTemplate
                    prompt_template = source_crd.spec.promptTemplate
                    logger.info(
                        f"[Subscription] Using source subscription {source_subscription_id} "
                        f"promptTemplate for rental {subscription.id}"
                    )
                else:
                    logger.warning(
                        f"[Subscription] Source subscription {source_subscription_id} not found "
                        f"for rental {subscription.id}, using placeholder"
                    )

        # Resolve prompt template
        resolved_prompt = resolve_prompt_template(
            prompt_template,
            display_name,
            extra_variables,
        )

        # Validate resolved prompt is not empty
        if not resolved_prompt or not resolved_prompt.strip():
            raise ValueError(
                f"Prompt template resolved to empty string for subscription {subscription.id} ({subscription.name}). "
                f"Template: '{subscription_crd.spec.promptTemplate}'"
            )

        execution = BackgroundExecution(
            user_id=user_id,
            subscription_id=subscription.id,
            task_id=0,  # No task created yet
            trigger_type=trigger_type,
            trigger_reason=trigger_reason or "",
            prompt=resolved_prompt,
            status=BackgroundExecutionStatus.PENDING.value,
            result_summary="",
            error_message="",
            # started_at and completed_at use model defaults (datetime.utcnow)
        )

        db.add(execution)
        db.commit()
        db.refresh(execution)

        logger.info(
            f"[Subscription] Created execution {execution.id}: "
            f"subscription_id={subscription.id}, subscription_name={subscription.name}, "
            f"trigger_type={trigger_type}, trigger_reason={trigger_reason}, "
            f"user_id={user_id}, status=PENDING"
        )

        exec_dict = self._convert_execution_to_dict(execution)
        exec_dict["subscription_name"] = subscription.name
        exec_dict["subscription_display_name"] = subscription_crd.spec.displayName
        exec_dict["task_type"] = subscription_crd.spec.taskType.value

        return BackgroundExecutionInDB(**exec_dict)

    def cancel_execution(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
    ) -> BackgroundExecutionInDB:
        """
        Cancel a background execution.

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
            Updated BackgroundExecutionInDB

        Raises:
            HTTPException: If execution not found or cannot be cancelled
        """
        execution = (
            db.query(BackgroundExecution)
            .filter(
                BackgroundExecution.id == execution_id,
                BackgroundExecution.user_id == user_id,
            )
            .first()
        )

        if not execution:
            raise HTTPException(status_code=404, detail="Execution not found")

        current_status = BackgroundExecutionStatus(execution.status)

        # Check if execution is in a terminal state
        if is_terminal_state(current_status):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot cancel execution in {current_status.value} state",
            )

        # Validate state transition
        if not validate_state_transition(
            current_status, BackgroundExecutionStatus.CANCELLED
        ):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot transition from {current_status.value} to CANCELLED",
            )

        # Update execution status
        now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
        execution.status = BackgroundExecutionStatus.CANCELLED.value
        execution.error_message = "Cancelled by user"
        execution.completed_at = now_utc
        execution.updated_at = now_utc

        # Calculate how long it's been running (if in RUNNING state)
        running_info = ""
        if current_status == BackgroundExecutionStatus.RUNNING and execution.started_at:
            running_duration = now_utc - execution.started_at
            running_hours = running_duration.total_seconds() / 3600
            running_info = f", running_hours={running_hours:.2f}h"

        db.commit()
        db.refresh(execution)

        logger.info(
            f"[Subscription] Execution {execution_id} cancelled by user {user_id}: "
            f"subscription_id={execution.subscription_id}, task_id={execution.task_id}, "
            f"previous_status={current_status.value}{running_info}"
        )

        # Emit WebSocket event
        emit_background_execution_update(
            db=db,
            execution=execution,
            status=BackgroundExecutionStatus.CANCELLED,
            error_message="Cancelled by user",
        )

        # Build response
        exec_dict = self._convert_execution_to_dict(execution)

        # Get subscription details
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == execution.subscription_id,
                Kind.kind == "Subscription",
            )
            .first()
        )
        if subscription:
            subscription_crd = Subscription.model_validate(subscription.json)
            exec_dict["subscription_name"] = subscription.name
            exec_dict["subscription_display_name"] = subscription_crd.spec.displayName
            exec_dict["task_type"] = subscription_crd.spec.taskType.value

            # Get team name from teamRef
            team_ref = subscription_crd.spec.teamRef
            if team_ref:
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Team",
                        Kind.name == team_ref.name,
                        Kind.namespace == team_ref.namespace,
                    )
                    .first()
                )
                if team:
                    exec_dict["team_name"] = team.name

        return BackgroundExecutionInDB(**exec_dict)

    def delete_execution(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
    ) -> None:
        """
        Delete a background execution record.

        This method allows users to delete an execution record from the timeline.
        Only executions in terminal states (COMPLETED, FAILED, CANCELLED) can be deleted.
        Running or pending executions must be cancelled first.

        Args:
            db: Database session
            execution_id: ID of the execution to delete
            user_id: ID of the user requesting deletion

        Raises:
            HTTPException: If execution not found or cannot be deleted
        """
        execution = (
            db.query(BackgroundExecution)
            .filter(
                BackgroundExecution.id == execution_id,
                BackgroundExecution.user_id == user_id,
            )
            .first()
        )

        if not execution:
            raise HTTPException(status_code=404, detail="Execution not found")

        current_status = BackgroundExecutionStatus(execution.status)

        # Only allow deletion of executions in terminal states
        if not is_terminal_state(current_status):
            raise HTTPException(
                status_code=400,
                detail=f"Cannot delete execution in {current_status.value} state. Please cancel it first.",
            )

        # Delete the execution record
        db.delete(execution)
        db.commit()

        logger.info(
            f"[Subscription] Execution {execution_id} deleted by user {user_id}: "
            f"subscription_id={execution.subscription_id}, task_id={execution.task_id}, "
            f"status={current_status.value}"
        )

    def list_executions(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 50,
        subscription_id: Optional[int] = None,
        status: Optional[List[BackgroundExecutionStatus]] = None,
        start_date: Optional[datetime] = None,
        end_date: Optional[datetime] = None,
        include_following: bool = True,
        include_silent: bool = False,
    ) -> Tuple[List[BackgroundExecutionInDB], int]:
        """
        List BackgroundExecution records (timeline view).

        Optimized to avoid N+1 queries by batch loading related subscriptions and teams.
        Now includes executions from followed subscriptions.
        Also allows viewing executions of public subscriptions.

        Args:
            db: Database session
            user_id: User ID
            skip: Number of records to skip
            limit: Maximum number of records to return
            subscription_id: Optional filter by subscription ID
            status: Optional filter by status list
            start_date: Optional filter by start date
            end_date: Optional filter by end date
            include_following: Include executions from followed subscriptions
            include_silent: Include COMPLETED_SILENT executions (default False)

        Returns:
            Tuple of (list of BackgroundExecutionInDB, total count)
        """
        from sqlalchemy import or_

        # Check if querying a specific subscription that is public
        is_public_subscription = False
        if subscription_id:
            subscription = (
                db.query(Kind)
                .filter(
                    Kind.id == subscription_id,
                    Kind.kind == "Subscription",
                )
                .first()
            )
            if subscription:
                subscription_crd = Subscription.model_validate(subscription.json)
                # Check visibility field - PUBLIC means it's a public subscription
                is_public_subscription = (
                    subscription_crd.spec.visibility == SubscriptionVisibility.PUBLIC
                )

        # If querying a public subscription, allow access without user_id filter
        if subscription_id and is_public_subscription:
            query = db.query(BackgroundExecution).filter(
                BackgroundExecution.subscription_id == subscription_id
            )
        else:
            # Get subscription IDs the user is following
            followed_subscription_ids = []
            if include_following and not subscription_id:
                from app.services.subscription.follow_service import (
                    subscription_follow_service,
                )

                followed_subscription_ids = (
                    subscription_follow_service.get_followed_subscription_ids(
                        db, user_id=user_id
                    )
                )

            # Build query: own subscriptions OR followed subscriptions
            if followed_subscription_ids:
                query = db.query(BackgroundExecution).filter(
                    or_(
                        BackgroundExecution.user_id == user_id,
                        BackgroundExecution.subscription_id.in_(
                            followed_subscription_ids
                        ),
                    )
                )
            else:
                query = db.query(BackgroundExecution).filter(
                    BackgroundExecution.user_id == user_id
                )

            if subscription_id:
                query = query.filter(
                    BackgroundExecution.subscription_id == subscription_id
                )

        if status:
            query = query.filter(
                BackgroundExecution.status.in_([s.value for s in status])
            )

        # Exclude silent executions unless explicitly requested
        # Skip exclusion if COMPLETED_SILENT is explicitly included in status filter
        if not include_silent and (
            not status or BackgroundExecutionStatus.COMPLETED_SILENT not in status
        ):
            query = query.filter(
                BackgroundExecution.status
                != BackgroundExecutionStatus.COMPLETED_SILENT.value
            )

        if start_date:
            query = query.filter(BackgroundExecution.created_at >= start_date)

        if end_date:
            query = query.filter(BackgroundExecution.created_at <= end_date)

        total = query.count()
        executions = (
            query.order_by(desc(BackgroundExecution.created_at))
            .offset(skip)
            .limit(limit)
            .all()
        )

        if not executions:
            return [], total

        # Batch load all related subscriptions (fixes N+1 query issue)
        subscription_ids = list(set(e.subscription_id for e in executions))
        subscriptions = (
            db.query(Kind)
            .filter(
                Kind.id.in_(subscription_ids),
                Kind.kind == "Subscription",
            )
            .all()
        )

        # Build subscription cache with parsed CRD data
        subscription_cache = {}
        team_refs = {}
        for subscription in subscriptions:
            subscription_crd = Subscription.model_validate(subscription.json)
            subscription_cache[subscription.id] = {
                "name": subscription.name,
                "display_name": subscription_crd.spec.displayName,
                "task_type": subscription_crd.spec.taskType.value,
                "team_ref": subscription_crd.spec.teamRef,
                "owner_user_id": subscription.user_id,  # Track subscription owner
            }
            if subscription_crd.spec.teamRef:
                team_ref = subscription_crd.spec.teamRef
                team_refs[(team_ref.name, team_ref.namespace)] = None

        # Batch load all related teams (fixes N+1 query issue)
        team_map = {}
        if team_refs:
            from sqlalchemy import and_, or_

            team_conditions = [
                and_(Kind.name == name, Kind.namespace == namespace)
                for name, namespace in team_refs.keys()
            ]
            teams = (
                db.query(Kind).filter(Kind.kind == "Team", or_(*team_conditions)).all()
            )
            team_map = {(t.name, t.namespace): t for t in teams}

        # Build result list (no additional queries)
        result = []
        for exec in executions:
            exec_dict = self._convert_execution_to_dict(exec)

            sub_info = subscription_cache.get(exec.subscription_id, {})
            exec_dict["subscription_name"] = sub_info.get("name")
            exec_dict["subscription_display_name"] = sub_info.get("display_name")
            exec_dict["task_type"] = sub_info.get("task_type")

            # Get team name from cache
            team_ref = sub_info.get("team_ref")
            if team_ref:
                team = team_map.get((team_ref.name, team_ref.namespace))
                if team:
                    exec_dict["team_name"] = team.name

            # Set can_delete: only subscription owner can delete executions
            owner_user_id = sub_info.get("owner_user_id")
            exec_dict["can_delete"] = owner_user_id == user_id

            result.append(BackgroundExecutionInDB(**exec_dict))

        return result, total

    def get_execution(
        self,
        db: Session,
        *,
        execution_id: int,
        user_id: int,
    ) -> BackgroundExecutionInDB:
        """
        Get a specific BackgroundExecution by ID.

        Args:
            db: Database session
            execution_id: Execution ID
            user_id: User ID

        Returns:
            BackgroundExecutionInDB object

        Raises:
            HTTPException: If execution not found
        """
        execution = (
            db.query(BackgroundExecution)
            .filter(
                BackgroundExecution.id == execution_id,
                BackgroundExecution.user_id == user_id,
            )
            .first()
        )

        if not execution:
            raise HTTPException(status_code=404, detail="Execution not found")

        exec_dict = self._convert_execution_to_dict(execution)

        # Get subscription details
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == execution.subscription_id,
                Kind.kind == "Subscription",
            )
            .first()
        )
        if subscription:
            subscription_crd = Subscription.model_validate(subscription.json)
            exec_dict["subscription_name"] = subscription.name
            exec_dict["subscription_display_name"] = subscription_crd.spec.displayName
            exec_dict["task_type"] = subscription_crd.spec.taskType.value

            # Get team name from teamRef
            team_ref = subscription_crd.spec.teamRef
            if team_ref:
                team = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Team",
                        Kind.name == team_ref.name,
                        Kind.namespace == team_ref.namespace,
                    )
                    .first()
                )
                if team:
                    exec_dict["team_name"] = team.name

        return BackgroundExecutionInDB(**exec_dict)

    def update_execution_status(
        self,
        db: Session,
        *,
        execution_id: int,
        status: BackgroundExecutionStatus,
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
            status = BackgroundExecutionStatus(status)

        # First, get the current status to validate state transition
        execution = (
            db.query(BackgroundExecution)
            .filter(BackgroundExecution.id == execution_id)
            .first()
        )

        if not execution:
            logger.warning(
                f"[Subscription] Execution {execution_id} not found for status update"
            )
            return False

        current_status = BackgroundExecutionStatus(execution.status)
        current_version = getattr(execution, "version", 0) or 0

        # Validate state transition
        if not validate_state_transition(current_status, status):
            logger.warning(
                f"[Subscription] Invalid state transition for execution {execution_id}: "
                f"{current_status.value} -> {status.value}, "
                f"subscription_id={execution.subscription_id}, task_id={execution.task_id}"
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

        if status == BackgroundExecutionStatus.RUNNING:
            update_values["started_at"] = now_utc
        elif status in (
            BackgroundExecutionStatus.COMPLETED,
            BackgroundExecutionStatus.COMPLETED_SILENT,
            BackgroundExecutionStatus.FAILED,
        ):
            update_values["completed_at"] = now_utc

        if result_summary:
            update_values["result_summary"] = result_summary

        if error_message:
            update_values["error_message"] = error_message

        # Atomic update with WHERE clause to prevent race conditions
        # Only update if current status and version match what we read
        rows_updated = (
            db.query(BackgroundExecution)
            .filter(
                BackgroundExecution.id == execution_id,
                BackgroundExecution.status == current_status.value,
                BackgroundExecution.version == current_version,
            )
            .update(update_values, synchronize_session=False)
        )

        if rows_updated == 0:
            # Another process updated the execution, refresh and check
            db.refresh(execution)
            logger.warning(
                f"[Subscription] Concurrent update detected for execution {execution_id}: "
                f"expected status={current_status.value}, version={current_version}, "
                f"actual status={execution.status}, version={execution.version}"
            )
            return False

        # Refresh the execution object after atomic update
        db.refresh(execution)

        # Update subscription statistics (only for terminal states to avoid double counting)
        # Note: COMPLETED_SILENT is intentionally excluded from stats updates because:
        # - Silent executions are designed for routine monitoring tasks
        # - They are hidden from the timeline by default
        # - Including them would pollute subscription metrics with routine checks
        if status in (
            BackgroundExecutionStatus.COMPLETED,
            BackgroundExecutionStatus.FAILED,
        ):
            self._update_subscription_statistics(db, execution, status, now_utc)

        db.commit()

        # Build detailed log message
        log_parts = [
            f"[Subscription] Execution {execution_id} status changed: {current_status.value} -> {status.value}",
            f"subscription_id={execution.subscription_id}",
            f"task_id={execution.task_id}",
        ]
        if error_message:
            log_parts.append(f"error={error_message[:100]}")
        if result_summary:
            log_parts.append(f"summary={result_summary[:50]}")

        # Use info level for terminal states, debug for intermediate
        if is_terminal_state(status):
            logger.info(", ".join(log_parts))
        else:
            logger.debug(", ".join(log_parts))

        # Emit WebSocket event to notify frontend of the status update
        logger.debug(
            f"[Subscription] Emitting WS event for execution {execution_id}, user_id={execution.user_id}"
        )
        emit_background_execution_update(
            db=db,
            execution=execution,
            status=status,
            result_summary=result_summary,
            error_message=error_message,
        )

        return True

    def _update_subscription_statistics(
        self,
        db: Session,
        execution: BackgroundExecution,
        status: BackgroundExecutionStatus,
        now_utc: datetime,
    ) -> None:
        """
        Update subscription statistics after execution completion.

        Args:
            db: Database session
            execution: The execution record
            status: Final execution status
            now_utc: Current UTC timestamp
        """
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == execution.subscription_id,
                Kind.kind == "Subscription",
            )
            .first()
        )
        if not subscription:
            return

        # Preserve _internal field before updating
        internal = subscription.json.get("_internal", {})

        subscription_crd = Subscription.model_validate(subscription.json)
        if subscription_crd.status is None:
            subscription_crd.status = SubscriptionStatus()

        subscription_crd.status.lastExecutionTime = now_utc
        subscription_crd.status.lastExecutionStatus = status
        subscription_crd.status.executionCount = (
            subscription_crd.status.executionCount or 0
        ) + 1

        if status == BackgroundExecutionStatus.COMPLETED:
            subscription_crd.status.successCount = (
                subscription_crd.status.successCount or 0
            ) + 1
        elif status == BackgroundExecutionStatus.FAILED:
            subscription_crd.status.failureCount = (
                subscription_crd.status.failureCount or 0
            ) + 1

        # Update _internal statistics as well
        internal["last_execution_time"] = now_utc.isoformat()
        internal["last_execution_status"] = status.value
        internal["execution_count"] = (internal.get("execution_count", 0) or 0) + 1
        if status == BackgroundExecutionStatus.COMPLETED:
            internal["success_count"] = (internal.get("success_count", 0) or 0) + 1
        elif status == BackgroundExecutionStatus.FAILED:
            internal["failure_count"] = (internal.get("failure_count", 0) or 0) + 1

        # Serialize CRD and restore _internal field
        crd_json = subscription_crd.model_dump(mode="json")
        crd_json["_internal"] = internal
        subscription.json = crd_json
        flag_modified(subscription, "json")

    def _convert_execution_to_dict(
        self, execution: BackgroundExecution
    ) -> Dict[str, Any]:
        """Convert BackgroundExecution to dict."""
        return {
            "id": execution.id,
            "user_id": execution.user_id,
            "subscription_id": execution.subscription_id,
            "task_id": execution.task_id,
            "trigger_type": execution.trigger_type,
            "trigger_reason": execution.trigger_reason,
            "prompt": execution.prompt,
            "status": BackgroundExecutionStatus(execution.status),
            "result_summary": execution.result_summary,
            "error_message": execution.error_message,
            "retry_attempt": execution.retry_attempt,
            "started_at": execution.started_at,
            "completed_at": execution.completed_at,
            "created_at": execution.created_at,
            "updated_at": execution.updated_at,
        }


# Singleton instance
background_execution_manager = BackgroundExecutionManager()

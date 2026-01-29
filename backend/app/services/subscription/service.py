# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription service for managing Subscription configurations.

This module provides the main SubscriptionService class for CRUD operations
on Subscription resources stored in the kinds table.
"""

import logging
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import desc
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.subscription import (
    BackgroundExecutionInDB,
    Subscription,
    SubscriptionCreate,
    SubscriptionInDB,
    SubscriptionStatus,
    SubscriptionTriggerType,
    SubscriptionUpdate,
    SubscriptionWorkspaceRef,
)
from app.services.subscription.execution import (
    BackgroundExecutionManager,
    background_execution_manager,
)
from app.services.subscription.helpers import (
    build_subscription_crd,
    build_trigger_config,
    build_workspace_repo_cache,
    calculate_next_execution_time,
    create_or_get_workspace,
    extract_trigger_config,
    resolve_workspace_repo_fields,
)

logger = logging.getLogger(__name__)


class SubscriptionService:
    """Service class for Subscription operations."""

    def __init__(self):
        self.execution_manager = background_execution_manager

    def create_subscription(
        self,
        db: Session,
        *,
        subscription_in: SubscriptionCreate,
        user_id: int,
    ) -> SubscriptionInDB:
        """Create a new Subscription configuration."""
        # Validate subscription name uniqueness
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == "Subscription",
                Kind.name == subscription_in.name,
                Kind.namespace == subscription_in.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Subscription with name '{subscription_in.name}' already exists",
            )

        # Validate team exists
        team = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_in.team_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
        )

        if not team:
            raise HTTPException(
                status_code=400,
                detail=f"Team with id {subscription_in.team_id} not found",
            )

        # Validate workspace if provided
        workspace = None
        workspace_id = subscription_in.workspace_id
        if subscription_in.workspace_id:
            workspace = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == subscription_in.workspace_id,
                    TaskResource.kind == "Workspace",
                    TaskResource.is_active == True,
                )
                .first()
            )

            if not workspace:
                raise HTTPException(
                    status_code=400,
                    detail=f"Workspace with id {subscription_in.workspace_id} not found",
                )
        elif subscription_in.git_repo:
            # Create workspace from git repo info if no workspace_id provided
            workspace_id = create_or_get_workspace(
                db,
                user_id=user_id,
                git_repo=subscription_in.git_repo,
                git_repo_id=subscription_in.git_repo_id,
                git_domain=subscription_in.git_domain or "github.com",
                branch_name=subscription_in.branch_name or "main",
            )

        # Generate webhook token and secret for event-type subscriptions
        webhook_token = None
        webhook_secret = None
        if subscription_in.trigger_type == SubscriptionTriggerType.EVENT:
            webhook_token = secrets.token_urlsafe(32)
            webhook_secret = secrets.token_urlsafe(32)  # HMAC signing secret

        # Build CRD JSON
        subscription_crd = build_subscription_crd(
            subscription_in, team, workspace, webhook_token
        )

        # Calculate next execution time for scheduled subscriptions
        next_execution_time = calculate_next_execution_time(
            subscription_in.trigger_type, subscription_in.trigger_config
        )
        # Ensure next_execution_time is never None
        if next_execution_time is None:
            next_execution_time = datetime.now(timezone.utc).replace(tzinfo=None)

        # Store additional fields in the CRD JSON for later retrieval
        crd_json = subscription_crd.model_dump(mode="json")
        crd_json["_internal"] = {
            "team_id": subscription_in.team_id,
            "workspace_id": workspace_id or 0,
            "webhook_token": webhook_token or "",
            "webhook_secret": webhook_secret or "",
            "enabled": subscription_in.enabled,
            "trigger_type": subscription_in.trigger_type.value,
            "next_execution_time": (
                next_execution_time.isoformat() if next_execution_time else None
            ),
            "last_execution_time": None,
            "last_execution_status": "",
            "execution_count": 0,
            "success_count": 0,
            "failure_count": 0,
            "bound_task_id": 0,
        }

        # Create Subscription as a Kind resource
        subscription = Kind(
            user_id=user_id,
            kind="Subscription",
            name=subscription_in.name,
            namespace=subscription_in.namespace,
            json=crd_json,
            is_active=True,
        )
        db.add(subscription)
        db.commit()
        db.refresh(subscription)

        return self._convert_to_subscription_in_db(subscription, db=db)

    def get_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> SubscriptionInDB:
        """Get a Subscription by ID."""
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.user_id == user_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        return self._convert_to_subscription_in_db(subscription, db=db)

    def list_subscriptions(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 100,
        enabled: Optional[bool] = None,
        trigger_type: Optional[SubscriptionTriggerType] = None,
    ) -> Tuple[List[SubscriptionInDB], int]:
        """List user's Subscriptions with pagination.

        Note: This method excludes rental subscriptions (is_rental=True).
        Rental subscriptions should be accessed via the market API.
        """
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )

        # Get all subscriptions first to filter by JSON fields
        all_subscriptions = query.order_by(desc(Kind.updated_at)).all()

        # Filter out rental subscriptions (is_rental=True)
        subscriptions = [
            s
            for s in all_subscriptions
            if not s.json.get("_internal", {}).get("is_rental", False)
        ]

        # Filter by enabled status if specified
        if enabled is not None:
            subscriptions = [
                s
                for s in subscriptions
                if s.json.get("_internal", {}).get("enabled", True) == enabled
            ]

        # Filter by trigger_type if specified
        if trigger_type is not None:
            subscriptions = [
                s
                for s in subscriptions
                if s.json.get("_internal", {}).get("trigger_type") == trigger_type.value
            ]

        total = len(subscriptions)
        subscriptions = subscriptions[skip : skip + limit]

        workspace_ids = [
            s.json.get("_internal", {}).get("workspace_id") for s in subscriptions
        ]
        workspace_repo_cache = build_workspace_repo_cache(db, workspace_ids)

        return [
            self._convert_to_subscription_in_db(
                s, db=db, workspace_repo_cache=workspace_repo_cache
            )
            for s in subscriptions
        ], total

    def update_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        subscription_in: SubscriptionUpdate,
        user_id: int,
    ) -> SubscriptionInDB:
        """Update a Subscription configuration."""
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.user_id == user_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        subscription_crd = Subscription.model_validate(subscription.json)
        internal = subscription.json.get("_internal", {})
        update_data = subscription_in.model_dump(exclude_unset=True)

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
            internal["team_id"] = update_data["team_id"]
            subscription_crd.spec.teamRef.name = team.name
            subscription_crd.spec.teamRef.namespace = team.namespace

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
                subscription_crd.spec.workspaceRef = SubscriptionWorkspaceRef(
                    name=workspace.name, namespace=workspace.namespace
                )
                internal["workspace_id"] = update_data["workspace_id"]
            else:
                subscription_crd.spec.workspaceRef = None
                internal["workspace_id"] = 0
        elif any(
            key in update_data
            for key in ("git_repo", "git_repo_id", "git_domain", "branch_name")
        ):
            git_repo = update_data.get("git_repo")
            if git_repo:
                workspace_id = create_or_get_workspace(
                    db,
                    user_id=user_id,
                    git_repo=git_repo,
                    git_repo_id=update_data.get("git_repo_id"),
                    git_domain=update_data.get("git_domain") or "github.com",
                    branch_name=update_data.get("branch_name") or "main",
                )
                workspace = (
                    db.query(TaskResource)
                    .filter(
                        TaskResource.id == workspace_id,
                        TaskResource.kind == "Workspace",
                        TaskResource.is_active == True,
                    )
                    .first()
                )
                if workspace:
                    subscription_crd.spec.workspaceRef = SubscriptionWorkspaceRef(
                        name=workspace.name, namespace=workspace.namespace
                    )
                    internal["workspace_id"] = workspace.id
            else:
                subscription_crd.spec.workspaceRef = None
                internal["workspace_id"] = 0

        # Update other fields
        if "display_name" in update_data:
            subscription_crd.spec.displayName = update_data["display_name"]

        if "description" in update_data:
            subscription_crd.spec.description = update_data["description"]

        if "task_type" in update_data:
            subscription_crd.spec.taskType = update_data["task_type"]

        # Update visibility if changed (handle side effects)
        if "visibility" in update_data:
            from app.schemas.subscription import SubscriptionVisibility
            from app.services.subscription.follow_service import (
                subscription_follow_service,
            )

            old_visibility = getattr(
                subscription_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
            )
            new_visibility = update_data["visibility"]
            subscription_crd.spec.visibility = new_visibility

            # Handle visibility change side effects
            if old_visibility != new_visibility:
                subscription_follow_service.handle_visibility_change(
                    db,
                    subscription_id=subscription_id,
                    old_visibility=old_visibility,
                    new_visibility=new_visibility,
                )

        if "prompt_template" in update_data:
            subscription_crd.spec.promptTemplate = update_data["prompt_template"]

        if "retry_count" in update_data:
            subscription_crd.spec.retryCount = update_data["retry_count"]

        if "timeout_seconds" in update_data:
            subscription_crd.spec.timeoutSeconds = update_data["timeout_seconds"]

        if "enabled" in update_data:
            subscription_crd.spec.enabled = update_data["enabled"]
            internal["enabled"] = update_data["enabled"]

        # Update model reference if changed
        if "model_ref" in update_data:
            from app.schemas.kind import ModelRef

            if update_data["model_ref"]:
                subscription_crd.spec.modelRef = ModelRef(
                    name=update_data["model_ref"].get("name", ""),
                    namespace=update_data["model_ref"].get("namespace", "default"),
                )
            else:
                subscription_crd.spec.modelRef = None

        if "force_override_bot_model" in update_data:
            subscription_crd.spec.forceOverrideBotModel = update_data[
                "force_override_bot_model"
            ]

        # Update history preservation settings
        if "preserve_history" in update_data:
            subscription_crd.spec.preserveHistory = update_data["preserve_history"]
            # If disabling history preservation, clear the bound task
            if not update_data["preserve_history"]:
                internal["bound_task_id"] = 0

        if "history_message_count" in update_data:
            subscription_crd.spec.historyMessageCount = update_data[
                "history_message_count"
            ]

        # Update trigger configuration
        if "trigger_type" in update_data or "trigger_config" in update_data:
            trigger_type = update_data.get("trigger_type", internal.get("trigger_type"))
            trigger_config = update_data.get(
                "trigger_config",
                extract_trigger_config(subscription_crd.spec.trigger),
            )

            # Generate new webhook token if switching to event trigger
            if (
                trigger_type == SubscriptionTriggerType.EVENT
                and internal.get("trigger_type") != SubscriptionTriggerType.EVENT.value
            ):
                internal["webhook_token"] = secrets.token_urlsafe(32)
                internal["webhook_secret"] = secrets.token_urlsafe(32)
            elif trigger_type != SubscriptionTriggerType.EVENT:
                internal["webhook_token"] = ""
                internal["webhook_secret"] = ""

            subscription_crd.spec.trigger = build_trigger_config(
                trigger_type, trigger_config
            )
            internal["trigger_type"] = (
                trigger_type.value
                if isinstance(trigger_type, SubscriptionTriggerType)
                else trigger_type
            )

            # Recalculate next execution time
            next_time = calculate_next_execution_time(trigger_type, trigger_config)
            internal["next_execution_time"] = (
                next_time.isoformat() if next_time else None
            )

        # Update status with webhook URL
        if internal.get("webhook_token"):
            if subscription_crd.status is None:
                subscription_crd.status = SubscriptionStatus()
            subscription_crd.status.webhookUrl = (
                f"/api/subscriptions/webhook/{internal['webhook_token']}"
            )

        # Save changes
        crd_json = subscription_crd.model_dump(mode="json")
        crd_json["_internal"] = internal
        subscription.json = crd_json
        subscription.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        flag_modified(subscription, "json")

        db.commit()
        db.refresh(subscription)

        return self._convert_to_subscription_in_db(subscription, db=db)

    def delete_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> None:
        """Delete a Subscription (soft delete)."""
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.user_id == user_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        # Soft delete
        subscription.is_active = False
        internal = subscription.json.get("_internal", {})
        internal["enabled"] = False
        subscription.json["_internal"] = internal
        subscription.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        flag_modified(subscription, "json")

        db.commit()

    def toggle_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
        enabled: bool,
    ) -> SubscriptionInDB:
        """Enable or disable a Subscription."""
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.user_id == user_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        subscription_crd = Subscription.model_validate(subscription.json)
        internal = subscription.json.get("_internal", {})

        internal["enabled"] = enabled
        subscription_crd.spec.enabled = enabled

        # Recalculate next execution time if enabling
        if enabled:
            next_time = calculate_next_execution_time(
                internal.get("trigger_type", "cron"),
                extract_trigger_config(subscription_crd.spec.trigger),
            )
            internal["next_execution_time"] = (
                next_time.isoformat() if next_time else None
            )
        else:
            internal["next_execution_time"] = None

        crd_json = subscription_crd.model_dump(mode="json")
        crd_json["_internal"] = internal
        subscription.json = crd_json
        subscription.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        flag_modified(subscription, "json")

        db.commit()
        db.refresh(subscription)

        return self._convert_to_subscription_in_db(subscription, db=db)

    def trigger_subscription_manually(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> BackgroundExecutionInDB:
        """Manually trigger a Subscription execution."""
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.user_id == user_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        # Create execution record
        execution = self.execution_manager.create_execution(
            db,
            subscription=subscription,
            user_id=user_id,
            trigger_type="manual",
            trigger_reason="Manually triggered by user",
        )

        # Dispatch task for execution
        self.dispatch_background_execution(subscription, execution)

        return execution

    def get_subscription_by_webhook_token(
        self,
        db: Session,
        *,
        webhook_token: str,
    ) -> Optional[Kind]:
        """Get a Subscription by webhook token."""
        # Query all active subscriptions and filter by webhook token
        subscriptions = (
            db.query(Kind)
            .filter(
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .all()
        )

        for subscription in subscriptions:
            internal = subscription.json.get("_internal", {})
            if internal.get("webhook_token") == webhook_token and internal.get(
                "enabled", True
            ):
                return subscription

        return None

    def trigger_subscription_by_webhook(
        self,
        db: Session,
        *,
        webhook_token: str,
        payload: Dict[str, Any],
    ) -> BackgroundExecutionInDB:
        """Trigger a Subscription via webhook."""
        subscription = self.get_subscription_by_webhook_token(
            db, webhook_token=webhook_token
        )

        if not subscription:
            raise HTTPException(
                status_code=404, detail="Subscription not found or disabled"
            )

        # Create execution with webhook data
        execution = self.execution_manager.create_execution(
            db,
            subscription=subscription,
            user_id=subscription.user_id,
            trigger_type="webhook",
            trigger_reason="Triggered by webhook",
            extra_variables={"webhook_data": payload},
        )

        # Dispatch task for execution
        self.dispatch_background_execution(subscription, execution)

        return execution

    def dispatch_background_execution(
        self,
        subscription: Kind,
        execution: BackgroundExecutionInDB,
        use_sync: bool = False,
    ) -> None:
        """
        Dispatch a background execution for async processing.

        This is the unified dispatch method used by all trigger paths:
        - Manual trigger (trigger_subscription_manually)
        - Webhook trigger (trigger_subscription_by_webhook)
        - Automatic trigger (check_due_subscriptions / check_due_subscriptions_sync)

        Args:
            subscription: The Subscription Kind resource to execute
            execution: The execution record created by create_execution()
            use_sync: If True, use sync execution (for non-Celery backends)
        """
        from app.core.config import settings

        subscription_crd = Subscription.model_validate(subscription.json)
        timeout_seconds = getattr(
            subscription_crd.spec,
            "timeoutSeconds",
            settings.FLOW_DEFAULT_TIMEOUT_SECONDS,
        )
        retry_count = (
            subscription_crd.spec.retryCount or settings.FLOW_DEFAULT_RETRY_COUNT
        )

        if use_sync:
            # Sync execution for non-Celery backends (APScheduler, XXL-JOB)
            import threading

            from app.tasks.subscription_tasks import execute_subscription_task_sync

            logger.info(
                f"[Subscription] Dispatching execution {execution.id} (sync): "
                f"subscription_id={subscription.id}, timeout={timeout_seconds}s, retry_count={retry_count}"
            )

            thread = threading.Thread(
                target=execute_subscription_task_sync,
                args=(subscription.id, execution.id, timeout_seconds),
                daemon=True,
            )
            thread.start()
        else:
            # Celery async execution (default)
            from app.tasks.subscription_tasks import execute_subscription_task

            logger.info(
                f"[Subscription] Dispatching execution {execution.id} (celery): "
                f"subscription_id={subscription.id}, timeout={timeout_seconds}s, retry_count={retry_count}"
            )

            execute_subscription_task.apply_async(
                args=[subscription.id, execution.id],
                kwargs={"timeout_seconds": timeout_seconds},
                max_retries=retry_count,
            )

    # Delegate execution methods to execution manager
    def create_execution(self, db: Session, **kwargs) -> BackgroundExecutionInDB:
        """Create a new execution record."""
        return self.execution_manager.create_execution(db, **kwargs)

    def cancel_execution(self, db: Session, **kwargs) -> BackgroundExecutionInDB:
        """Cancel an execution."""
        return self.execution_manager.cancel_execution(db, **kwargs)

    def delete_execution(self, db: Session, **kwargs) -> None:
        """Delete an execution."""
        return self.execution_manager.delete_execution(db, **kwargs)

    def list_executions(self, db: Session, **kwargs):
        """List executions."""
        return self.execution_manager.list_executions(db, **kwargs)

    def get_execution(self, db: Session, **kwargs) -> BackgroundExecutionInDB:
        """Get an execution by ID."""
        return self.execution_manager.get_execution(db, **kwargs)

    def update_execution_status(self, db: Session, **kwargs) -> bool:
        """Update execution status."""
        return self.execution_manager.update_execution_status(db, **kwargs)

    # Helper methods exposed for external use
    def extract_trigger_config(self, trigger) -> Dict[str, Any]:
        """Extract trigger config dict from trigger object."""
        return extract_trigger_config(trigger)

    def calculate_next_execution_time(self, trigger_type, trigger_config):
        """Calculate next execution time."""
        return calculate_next_execution_time(trigger_type, trigger_config)

    def _convert_to_subscription_in_db(
        self,
        subscription: Kind,
        current_user_id: Optional[int] = None,
        *,
        db: Optional[Session] = None,
        workspace_repo_cache: Optional[Dict[int, Dict[str, Optional[Any]]]] = None,
    ) -> SubscriptionInDB:
        """Convert Kind to SubscriptionInDB."""
        from app.schemas.subscription import SubscriptionVisibility

        subscription_crd = Subscription.model_validate(subscription.json)
        internal = subscription.json.get("_internal", {})

        # Build webhook URL
        webhook_url = None
        webhook_token = internal.get("webhook_token")
        if webhook_token:
            webhook_url = f"/api/subscriptions/webhook/{webhook_token}"

        # Extract model_ref from CRD
        model_ref = None
        if subscription_crd.spec.modelRef:
            model_ref = {
                "name": subscription_crd.spec.modelRef.name,
                "namespace": subscription_crd.spec.modelRef.namespace,
            }

        # Parse next_execution_time
        next_execution_time = None
        if internal.get("next_execution_time"):
            try:
                next_execution_time = datetime.fromisoformat(
                    internal["next_execution_time"]
                )
            except (ValueError, TypeError):
                pass

        # Parse last_execution_time
        last_execution_time = None
        if internal.get("last_execution_time"):
            try:
                last_execution_time = datetime.fromisoformat(
                    internal["last_execution_time"]
                )
            except (ValueError, TypeError):
                pass

        # Get visibility with default
        visibility = getattr(
            subscription_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
        )

        # Get rental-related fields from _internal
        is_rental = internal.get("is_rental", False)
        source_subscription_id = internal.get("source_subscription_id")
        source_subscription_name = internal.get("source_subscription_name")
        source_subscription_display_name = internal.get(
            "source_subscription_display_name"
        )
        source_owner_username = internal.get("source_owner_username")
        rental_count = internal.get("rental_count", 0)
        workspace_repo_fields = (
            resolve_workspace_repo_fields(
                db,
                user_id=subscription.user_id,
                workspace_id=internal.get("workspace_id"),
                workspace_ref=subscription_crd.spec.workspaceRef,
                workspace_repo_cache=workspace_repo_cache,
            )
            if db
            else {
                "git_repo": None,
                "git_repo_id": None,
                "git_domain": None,
                "branch_name": None,
            }
        )

        return SubscriptionInDB(
            id=subscription.id,
            user_id=subscription.user_id,
            name=subscription.name,
            namespace=subscription.namespace,
            display_name=subscription_crd.spec.displayName,
            description=subscription_crd.spec.description,
            task_type=subscription_crd.spec.taskType,
            visibility=visibility,
            trigger_type=SubscriptionTriggerType(internal.get("trigger_type", "cron")),
            trigger_config=extract_trigger_config(subscription_crd.spec.trigger),
            team_id=internal.get("team_id", 0),
            workspace_id=internal.get("workspace_id", 0),
            git_repo=workspace_repo_fields.get("git_repo"),
            git_repo_id=workspace_repo_fields.get("git_repo_id"),
            git_domain=workspace_repo_fields.get("git_domain"),
            branch_name=workspace_repo_fields.get("branch_name"),
            model_ref=model_ref,
            force_override_bot_model=subscription_crd.spec.forceOverrideBotModel,
            prompt_template=subscription_crd.spec.promptTemplate,
            retry_count=subscription_crd.spec.retryCount,
            timeout_seconds=subscription_crd.spec.timeoutSeconds,
            enabled=internal.get("enabled", True),
            # History preservation settings
            preserve_history=subscription_crd.spec.preserveHistory,
            history_message_count=subscription_crd.spec.historyMessageCount,
            bound_task_id=internal.get("bound_task_id", 0),
            webhook_url=webhook_url,
            webhook_secret=internal.get("webhook_secret"),
            last_execution_time=last_execution_time,
            last_execution_status=internal.get("last_execution_status"),
            next_execution_time=next_execution_time,
            execution_count=internal.get("execution_count", 0),
            success_count=internal.get("success_count", 0),
            failure_count=internal.get("failure_count", 0),
            # Follow-related fields - default values, can be populated by follow_service
            followers_count=0,
            is_following=False,
            owner_username=None,
            # Market rental fields
            is_rental=is_rental,
            source_subscription_id=source_subscription_id,
            source_subscription_name=source_subscription_name,
            source_subscription_display_name=source_subscription_display_name,
            source_owner_username=source_owner_username,
            rental_count=rental_count,
            created_at=subscription.created_at,
            updated_at=subscription.updated_at,
        )


# Singleton instance
subscription_service = SubscriptionService()

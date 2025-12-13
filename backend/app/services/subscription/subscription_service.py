# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription service for Smart Feed feature
"""
import asyncio
import json
import logging
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import HTTPException
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.subscription import (
    Subscription,
    SubscriptionItem,
    SubscriptionRun,
    SubscriptionRunStatus,
)
from app.models.user import User
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionItemCreate,
    SubscriptionUpdate,
)

logger = logging.getLogger(__name__)


class SubscriptionService:
    """Service for managing subscriptions"""

    def create_subscription(
        self,
        db: Session,
        *,
        obj_in: SubscriptionCreate,
        user_id: int,
    ) -> Subscription:
        """Create a new subscription"""
        # Validate team exists
        team = self._get_team(
            db,
            user_id=user_id,
            team_id=obj_in.team_id,
            team_name=obj_in.team_name,
            team_namespace=obj_in.team_namespace,
        )

        if not team:
            raise HTTPException(status_code=404, detail="Team not found")

        # Check for duplicate name
        existing = (
            db.query(Subscription)
            .filter(
                Subscription.user_id == user_id,
                Subscription.namespace == obj_in.namespace,
                Subscription.name == obj_in.name,
                Subscription.is_active == True,
            )
            .first()
        )
        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Subscription with name '{obj_in.name}' already exists in namespace '{obj_in.namespace}'",
            )

        # Parse trigger config
        trigger = obj_in.trigger
        cron_expression = None
        cron_timezone = None
        webhook_secret = None

        if trigger.type == "cron" and trigger.cron:
            cron_expression = trigger.cron.expression
            cron_timezone = trigger.cron.timezone
        elif trigger.type == "webhook":
            webhook_secret = (
                trigger.webhook.secret if trigger.webhook else secrets.token_urlsafe(32)
            )

        # Parse alert policy
        alert_enabled = True
        alert_prompt = None
        alert_keywords = None

        if obj_in.alert_policy:
            alert_enabled = obj_in.alert_policy.enabled
            alert_prompt = obj_in.alert_policy.prompt
            alert_keywords = obj_in.alert_policy.keywords

        # Parse retention
        retention_days = 30
        if obj_in.retention:
            retention_days = obj_in.retention.days

        subscription = Subscription(
            user_id=user_id,
            namespace=obj_in.namespace,
            name=obj_in.name,
            description=obj_in.description,
            team_id=team.id,
            team_name=team.name,
            team_namespace=team.namespace,
            trigger_type=trigger.type,
            cron_expression=cron_expression,
            cron_timezone=cron_timezone,
            webhook_secret=webhook_secret,
            alert_enabled=alert_enabled,
            alert_prompt=alert_prompt,
            alert_keywords=alert_keywords,
            retention_days=retention_days,
            enabled=obj_in.enabled,
        )

        db.add(subscription)
        db.commit()
        db.refresh(subscription)

        logger.info(f"Created subscription {subscription.id} for user {user_id}")
        return subscription

    def get_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> Optional[Subscription]:
        """Get a subscription by ID"""
        return (
            db.query(Subscription)
            .filter(
                Subscription.id == subscription_id,
                Subscription.user_id == user_id,
                Subscription.is_active == True,
            )
            .first()
        )

    def get_subscriptions(
        self,
        db: Session,
        *,
        user_id: int,
        namespace: Optional[str] = None,
        scope: str = "all",
        skip: int = 0,
        limit: int = 100,
    ) -> Tuple[List[Subscription], int]:
        """Get subscriptions for a user with pagination"""
        query = db.query(Subscription).filter(
            Subscription.user_id == user_id,
            Subscription.is_active == True,
        )

        if namespace:
            query = query.filter(Subscription.namespace == namespace)

        if scope == "personal":
            query = query.filter(Subscription.namespace == "default")
        elif scope == "group" and namespace:
            query = query.filter(Subscription.namespace == namespace)

        total = query.count()
        items = (
            query.order_by(Subscription.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        return items, total

    def update_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        obj_in: SubscriptionUpdate,
        user_id: int,
    ) -> Subscription:
        """Update a subscription"""
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        update_data = obj_in.model_dump(exclude_unset=True)

        # Handle team update
        if any(k in update_data for k in ["team_id", "team_name", "team_namespace"]):
            team = self._get_team(
                db,
                user_id=user_id,
                team_id=update_data.get("team_id"),
                team_name=update_data.get("team_name"),
                team_namespace=update_data.get("team_namespace"),
            )
            if team:
                subscription.team_id = team.id
                subscription.team_name = team.name
                subscription.team_namespace = team.namespace

        # Handle trigger update
        if "trigger" in update_data and update_data["trigger"]:
            trigger = update_data["trigger"]
            subscription.trigger_type = trigger.get("type", subscription.trigger_type)

            if trigger.get("type") == "cron" and trigger.get("cron"):
                subscription.cron_expression = trigger["cron"].get("expression")
                subscription.cron_timezone = trigger["cron"].get(
                    "timezone", "Asia/Shanghai"
                )
            elif trigger.get("type") == "webhook":
                if not subscription.webhook_secret:
                    subscription.webhook_secret = secrets.token_urlsafe(32)

        # Handle alert policy update
        if "alert_policy" in update_data and update_data["alert_policy"]:
            policy = update_data["alert_policy"]
            subscription.alert_enabled = policy.get(
                "enabled", subscription.alert_enabled
            )
            subscription.alert_prompt = policy.get("prompt", subscription.alert_prompt)
            subscription.alert_keywords = policy.get(
                "keywords", subscription.alert_keywords
            )

        # Handle retention update
        if "retention" in update_data and update_data["retention"]:
            subscription.retention_days = update_data["retention"].get(
                "days", subscription.retention_days
            )

        # Handle simple fields
        if "name" in update_data:
            subscription.name = update_data["name"]
        if "description" in update_data:
            subscription.description = update_data["description"]
        if "enabled" in update_data:
            subscription.enabled = update_data["enabled"]

        subscription.updated_at = datetime.now()
        db.commit()
        db.refresh(subscription)

        return subscription

    def delete_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> None:
        """Soft delete a subscription"""
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        subscription.is_active = False
        subscription.updated_at = datetime.now()
        db.commit()

    def enable_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> Subscription:
        """Enable a subscription"""
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        subscription.enabled = True
        subscription.updated_at = datetime.now()
        db.commit()
        db.refresh(subscription)

        return subscription

    def disable_subscription(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> Subscription:
        """Disable a subscription"""
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )

        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        subscription.enabled = False
        subscription.updated_at = datetime.now()
        db.commit()
        db.refresh(subscription)

        return subscription

    # Items management
    def create_item(
        self,
        db: Session,
        *,
        obj_in: SubscriptionItemCreate,
    ) -> SubscriptionItem:
        """Create a subscription item"""
        item = SubscriptionItem(
            subscription_id=obj_in.subscription_id,
            title=obj_in.title,
            content=obj_in.content,
            summary=obj_in.summary,
            source_url=obj_in.source_url,
            metadata=obj_in.metadata,
            should_alert=obj_in.should_alert,
            alert_reason=obj_in.alert_reason,
            task_id=obj_in.task_id,
            run_id=obj_in.run_id,
        )

        db.add(item)

        # Update subscription counters
        subscription = (
            db.query(Subscription)
            .filter(Subscription.id == obj_in.subscription_id)
            .first()
        )
        if subscription:
            subscription.total_item_count += 1
            subscription.unread_count += 1

        db.commit()
        db.refresh(item)

        return item

    def get_items(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
        is_read: Optional[bool] = None,
        should_alert: Optional[bool] = None,
        search: Optional[str] = None,
        skip: int = 0,
        limit: int = 50,
    ) -> Tuple[List[SubscriptionItem], int]:
        """Get items for a subscription"""
        # Verify subscription ownership
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )
        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        query = db.query(SubscriptionItem).filter(
            SubscriptionItem.subscription_id == subscription_id
        )

        if is_read is not None:
            query = query.filter(SubscriptionItem.is_read == is_read)

        if should_alert is not None:
            query = query.filter(SubscriptionItem.should_alert == should_alert)

        if search:
            query = query.filter(
                or_(
                    SubscriptionItem.title.ilike(f"%{search}%"),
                    SubscriptionItem.content.ilike(f"%{search}%"),
                    SubscriptionItem.summary.ilike(f"%{search}%"),
                )
            )

        total = query.count()
        items = (
            query.order_by(SubscriptionItem.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        return items, total

    def get_item(
        self,
        db: Session,
        *,
        subscription_id: int,
        item_id: int,
        user_id: int,
    ) -> Optional[SubscriptionItem]:
        """Get a single item"""
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )
        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        return (
            db.query(SubscriptionItem)
            .filter(
                SubscriptionItem.id == item_id,
                SubscriptionItem.subscription_id == subscription_id,
            )
            .first()
        )

    def mark_item_read(
        self,
        db: Session,
        *,
        subscription_id: int,
        item_id: int,
        user_id: int,
    ) -> SubscriptionItem:
        """Mark an item as read"""
        item = self.get_item(
            db, subscription_id=subscription_id, item_id=item_id, user_id=user_id
        )
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")

        if not item.is_read:
            item.is_read = True

            # Update unread count
            subscription = (
                db.query(Subscription)
                .filter(Subscription.id == subscription_id)
                .first()
            )
            if subscription and subscription.unread_count > 0:
                subscription.unread_count -= 1

            db.commit()
            db.refresh(item)

        return item

    def mark_all_read(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> int:
        """Mark all items as read"""
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )
        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        count = (
            db.query(SubscriptionItem)
            .filter(
                SubscriptionItem.subscription_id == subscription_id,
                SubscriptionItem.is_read == False,
            )
            .update({SubscriptionItem.is_read: True})
        )

        subscription.unread_count = 0
        db.commit()

        return count

    # Runs management
    def create_run(
        self,
        db: Session,
        *,
        subscription_id: int,
        task_id: Optional[int] = None,
    ) -> SubscriptionRun:
        """Create a new run record"""
        run = SubscriptionRun(
            subscription_id=subscription_id,
            task_id=task_id,
            status=SubscriptionRunStatus.PENDING,
            started_at=datetime.now(),
        )

        db.add(run)
        db.commit()
        db.refresh(run)

        return run

    def update_run(
        self,
        db: Session,
        *,
        run_id: int,
        status: str,
        items_collected: int = 0,
        items_alerted: int = 0,
        error_message: Optional[str] = None,
    ) -> SubscriptionRun:
        """Update a run record"""
        run = db.query(SubscriptionRun).filter(SubscriptionRun.id == run_id).first()

        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        run.status = status
        run.items_collected = items_collected
        run.items_alerted = items_alerted
        run.error_message = error_message

        if status in ["success", "failed"]:
            run.finished_at = datetime.now()

            # Update subscription last run info
            subscription = (
                db.query(Subscription)
                .filter(Subscription.id == run.subscription_id)
                .first()
            )
            if subscription:
                subscription.last_run_time = run.started_at
                subscription.last_run_status = status

        db.commit()
        db.refresh(run)

        return run

    def get_runs(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
        skip: int = 0,
        limit: int = 20,
    ) -> Tuple[List[SubscriptionRun], int]:
        """Get runs for a subscription"""
        subscription = self.get_subscription(
            db, subscription_id=subscription_id, user_id=user_id
        )
        if not subscription:
            raise HTTPException(status_code=404, detail="Subscription not found")

        query = db.query(SubscriptionRun).filter(
            SubscriptionRun.subscription_id == subscription_id
        )

        total = query.count()
        items = (
            query.order_by(SubscriptionRun.started_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        return items, total

    # Unread count
    def get_unread_count(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> Dict[str, Any]:
        """Get total unread count for all subscriptions"""
        subscriptions = (
            db.query(Subscription)
            .filter(
                Subscription.user_id == user_id,
                Subscription.is_active == True,
            )
            .all()
        )

        total_unread = sum(s.unread_count for s in subscriptions)
        subscription_counts = [
            {"id": s.id, "name": s.name, "unread_count": s.unread_count}
            for s in subscriptions
            if s.unread_count > 0
        ]

        return {
            "total_unread": total_unread,
            "subscriptions": subscription_counts,
        }

    # Webhook handling
    def validate_webhook(
        self,
        db: Session,
        *,
        subscription_id: int,
        secret: Optional[str],
    ) -> Optional[Subscription]:
        """Validate webhook request"""
        subscription = (
            db.query(Subscription)
            .filter(
                Subscription.id == subscription_id,
                Subscription.trigger_type == "webhook",
                Subscription.is_active == True,
                Subscription.enabled == True,
            )
            .first()
        )

        if not subscription:
            return None

        # If secret is set, validate it
        if subscription.webhook_secret:
            if not secret or secret != subscription.webhook_secret:
                return None

        return subscription

    # Data cleanup
    def cleanup_old_data(
        self,
        db: Session,
    ) -> int:
        """Clean up data older than retention period"""
        now = datetime.now()
        total_deleted = 0

        subscriptions = (
            db.query(Subscription).filter(Subscription.is_active == True).all()
        )

        for subscription in subscriptions:
            cutoff_date = now - timedelta(days=subscription.retention_days)

            # Delete old items
            deleted = (
                db.query(SubscriptionItem)
                .filter(
                    SubscriptionItem.subscription_id == subscription.id,
                    SubscriptionItem.created_at < cutoff_date,
                )
                .delete()
            )
            total_deleted += deleted

            # Delete old runs
            db.query(SubscriptionRun).filter(
                SubscriptionRun.subscription_id == subscription.id,
                SubscriptionRun.started_at < cutoff_date,
            ).delete()

            # Update item count
            subscription.total_item_count = (
                db.query(SubscriptionItem)
                .filter(SubscriptionItem.subscription_id == subscription.id)
                .count()
            )
            subscription.unread_count = (
                db.query(SubscriptionItem)
                .filter(
                    SubscriptionItem.subscription_id == subscription.id,
                    SubscriptionItem.is_read == False,
                )
                .count()
            )

        db.commit()

        logger.info(f"Cleaned up {total_deleted} old subscription items")
        return total_deleted

    # Get enabled cron subscriptions for scheduler
    def get_enabled_cron_subscriptions(
        self,
        db: Session,
    ) -> List[Subscription]:
        """Get all enabled cron subscriptions"""
        return (
            db.query(Subscription)
            .filter(
                Subscription.trigger_type == "cron",
                Subscription.enabled == True,
                Subscription.is_active == True,
            )
            .all()
        )

    # Helper methods
    def _get_team(
        self,
        db: Session,
        *,
        user_id: int,
        team_id: Optional[int] = None,
        team_name: Optional[str] = None,
        team_namespace: Optional[str] = None,
    ) -> Optional[Kind]:
        """Get team by ID or name"""
        if team_id:
            return (
                db.query(Kind)
                .filter(
                    Kind.id == team_id,
                    Kind.user_id == user_id,
                    Kind.kind == "Team",
                    Kind.is_active == True,
                )
                .first()
            )

        if team_name:
            return (
                db.query(Kind)
                .filter(
                    Kind.user_id == user_id,
                    Kind.kind == "Team",
                    Kind.name == team_name,
                    Kind.namespace == (team_namespace or "default"),
                    Kind.is_active == True,
                )
                .first()
            )

        return None

    async def execute_subscription(
        self,
        db: Session,
        *,
        subscription: Subscription,
        run: SubscriptionRun,
        user: User,
    ) -> Dict[str, Any]:
        """
        Execute a subscription task and save the result to subscription_items.

        This method:
        1. Gets the team and bot configuration
        2. Calls the LLM API directly (non-streaming)
        3. Saves the result to subscription_items
        4. Updates the run status

        Args:
            db: Database session
            subscription: The subscription to execute
            run: The run record
            user: The user who owns the subscription

        Returns:
            Dict with execution result
        """
        from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
        from app.schemas.kind import Bot, Shell, Team
        from app.services.chat.model_resolver import (
            get_bot_system_prompt,
            get_model_config_for_bot,
        )

        try:
            # Update run status to running
            run.status = SubscriptionRunStatus.RUNNING
            db.commit()

            # Get team
            team = (
                db.query(Kind)
                .filter(
                    Kind.id == subscription.team_id,
                    Kind.kind == "Team",
                    Kind.is_active == True,
                )
                .first()
            )

            if not team:
                raise ValueError(f"Team not found: {subscription.team_id}")

            team_crd = Team.model_validate(team.json)

            # Get first bot
            if not team_crd.spec.members:
                raise ValueError("Team has no members")

            first_member = team_crd.spec.members[0]
            bot = (
                db.query(Kind)
                .filter(
                    Kind.user_id == team.user_id,
                    Kind.kind == "Bot",
                    Kind.name == first_member.botRef.name,
                    Kind.namespace == first_member.botRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

            if not bot:
                raise ValueError(f"Bot not found: {first_member.botRef.name}")

            # Get model config
            model_config = get_model_config_for_bot(db, bot, team.user_id)

            # Get system prompt
            system_prompt = get_bot_system_prompt(
                db, bot, team.user_id, first_member.prompt
            )

            # Build the prompt
            prompt = (
                subscription.description or f"Execute subscription: {subscription.name}"
            )

            # Call LLM API (non-streaming)
            result = await self._call_llm_non_streaming(
                model_config=model_config,
                system_prompt=system_prompt,
                message=prompt,
            )

            # Create subscription item with the result
            item = self.create_item(
                db,
                obj_in=SubscriptionItemCreate(
                    subscription_id=subscription.id,
                    title=f"Run #{run.id}: {subscription.name}",
                    content=result,
                    summary=result[:200] + "..." if len(result) > 200 else result,
                    run_id=run.id,
                    should_alert=False,
                ),
            )

            # Update run status to success
            self.update_run(
                db,
                run_id=run.id,
                status="success",
                items_collected=1,
                items_alerted=0,
            )

            logger.info(
                f"Subscription {subscription.id} executed successfully, item_id={item.id}"
            )

            return {
                "success": True,
                "item_id": item.id,
                "content": result,
            }

        except Exception as e:
            logger.error(
                f"Failed to execute subscription {subscription.id}: {e}", exc_info=True
            )

            # Update run status to failed
            self.update_run(
                db,
                run_id=run.id,
                status="failed",
                error_message=str(e),
            )

            return {
                "success": False,
                "error": str(e),
            }

    async def _call_llm_non_streaming(
        self,
        model_config: Dict[str, Any],
        system_prompt: str,
        message: str,
    ) -> str:
        """
        Call LLM API without streaming.

        Args:
            model_config: Model configuration (api_key, base_url, model_id, model)
            system_prompt: System prompt
            message: User message

        Returns:
            LLM response text
        """
        model_type = model_config.get("model", "openai")
        api_key = model_config.get("api_key", "")
        base_url = model_config.get("base_url", "https://api.openai.com/v1")
        model_id = model_config.get("model_id", "gpt-4")
        default_headers = model_config.get("default_headers", {})

        # Build messages
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": message})

        async with httpx.AsyncClient(timeout=120.0) as client:
            if model_type == "claude":
                return await self._call_claude_non_streaming(
                    client, api_key, base_url, model_id, messages, default_headers
                )
            elif model_type == "gemini":
                return await self._call_gemini_non_streaming(
                    client, api_key, base_url, model_id, messages, default_headers
                )
            else:
                return await self._call_openai_non_streaming(
                    client, api_key, base_url, model_id, messages, default_headers
                )

    async def _call_openai_non_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None,
    ) -> str:
        """Call OpenAI-compatible API without streaming."""
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = {"Content-Type": "application/json"}

        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"

        if default_headers:
            headers.update(default_headers)

        payload = {
            "model": model_id,
            "messages": messages,
            "stream": False,
        }

        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()

        data = response.json()
        choices = data.get("choices", [])
        if choices:
            return choices[0].get("message", {}).get("content", "")
        return ""

    async def _call_claude_non_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None,
    ) -> str:
        """Call Claude API without streaming."""
        base_url_stripped = base_url.rstrip("/")
        if base_url_stripped.endswith("/v1"):
            url = f"{base_url_stripped}/messages"
        else:
            url = f"{base_url_stripped}/v1/messages"

        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        if default_headers:
            headers.update(default_headers)

        # Separate system message
        system_content = ""
        chat_messages = []
        for msg in messages:
            if msg["role"] == "system":
                system_content = msg["content"]
            else:
                chat_messages.append(
                    {
                        "role": msg["role"],
                        "content": [{"type": "text", "text": msg["content"]}],
                    }
                )

        payload = {
            "model": model_id,
            "max_tokens": 4096,
            "stream": False,
            "messages": chat_messages,
        }
        if system_content:
            payload["system"] = system_content

        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()

        data = response.json()
        content = data.get("content", [])
        if content:
            return content[0].get("text", "")
        return ""

    async def _call_gemini_non_streaming(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        base_url: str,
        model_id: str,
        messages: List[Dict[str, str]],
        default_headers: Dict[str, Any] = None,
    ) -> str:
        """Call Gemini API without streaming."""
        base_url_stripped = base_url.rstrip("/")
        if "generativelanguage.googleapis.com" in base_url_stripped:
            if "/v1beta" in base_url_stripped or "/v1" in base_url_stripped:
                url = f"{base_url_stripped}/models/{model_id}:generateContent"
            else:
                url = f"{base_url_stripped}/v1beta/models/{model_id}:generateContent"
        else:
            url = f"{base_url_stripped}/v1beta/models/{model_id}:generateContent"

        headers = {"Content-Type": "application/json"}

        if api_key:
            headers["x-goog-api-key"] = api_key

        if default_headers:
            headers.update(default_headers)

        # Convert messages to Gemini format
        system_instruction = None
        gemini_contents = []

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "system":
                system_instruction = {"parts": [{"text": content}]}
                continue

            gemini_role = "model" if role == "assistant" else "user"
            gemini_contents.append({"role": gemini_role, "parts": [{"text": content}]})

        payload = {"contents": gemini_contents}
        if system_instruction:
            payload["systemInstruction"] = system_instruction

        response = await client.post(url, json=payload, headers=headers)
        response.raise_for_status()

        data = response.json()
        candidates = data.get("candidates", [])
        if candidates:
            content_obj = candidates[0].get("content", {})
            parts = content_obj.get("parts", [])
            if parts:
                return parts[0].get("text", "")
        return ""


subscription_service = SubscriptionService()

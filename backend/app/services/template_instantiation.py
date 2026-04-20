# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Template instantiation engine using the Strategy pattern.

Each template category (e.g., 'inbox') has a corresponding instantiator
that knows how to create the required resources in the correct order.
"""

import logging
import secrets
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Dict

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.template import TemplateInstantiateResponse

logger = logging.getLogger(__name__)

NAMESPACE = "default"
API_VERSION = "agent.wecode.io/v1"


class BaseTemplateInstantiator(ABC):
    """Abstract base class for template instantiators."""

    @abstractmethod
    def instantiate(
        self, db: Session, user_id: int, template: Kind
    ) -> TemplateInstantiateResponse:
        """Create all resources defined by the template."""
        pass

    @staticmethod
    def _generate_suffix(length: int = 8) -> str:
        """Generate a random alphanumeric suffix."""
        return secrets.token_hex(length // 2 + 1)[:length]


class InboxTemplateInstantiator(BaseTemplateInstantiator):
    """Instantiator for inbox-category templates.

    Creates resources in dependency order:
    Ghost -> Bot -> Team -> Subscription -> WorkQueue
    """

    def instantiate(
        self, db: Session, user_id: int, template: Kind
    ) -> TemplateInstantiateResponse:
        spec = template.json.get("spec", {})
        resources = spec.get("resources", {})
        template_name = template.name
        suffix = self._generate_suffix()
        display_name = spec.get("displayName", template_name)

        # 1. Create Ghost
        ghost = self._create_ghost(
            db,
            user_id,
            template_name,
            suffix,
            display_name,
            resources.get("ghost", {}),
        )

        # 2. Create Bot referencing Ghost
        bot = self._create_bot(
            db,
            user_id,
            template_name,
            suffix,
            resources.get("bot", {}),
            ghost,
        )

        # 3. Create Team referencing Bot
        team = self._create_team(
            db,
            user_id,
            template_name,
            suffix,
            display_name,
            resources.get("team", {}),
            bot,
        )

        # 4. Create Subscription referencing Team
        subscription = self._create_subscription(
            db,
            user_id,
            template_name,
            suffix,
            display_name,
            resources.get("subscription", {}),
            team,
        )

        # 5. Create WorkQueue with autoProcess referencing Subscription
        queue = self._create_queue(
            db,
            user_id,
            template_name,
            suffix,
            display_name,
            resources.get("queue", {}),
            subscription,
        )

        # Flush to ensure all IDs are assigned
        db.flush()

        return TemplateInstantiateResponse(
            ghostId=ghost.id,
            botId=bot.id,
            teamId=team.id,
            subscriptionId=subscription.id,
            queueId=queue.id,
            queueName=queue.name,
        )

    def _create_ghost(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
    ) -> Kind:
        """Create a Ghost resource from template config."""
        name = f"tpl-{template_name}-{suffix}-ghost"
        ghost_spec = {
            "systemPrompt": config.get("systemPrompt", ""),
        }
        if config.get("mcpServers"):
            ghost_spec["mcpServers"] = config["mcpServers"]
        if config.get("skills"):
            ghost_spec["skills"] = config["skills"]

        ghost_json = {
            "apiVersion": API_VERSION,
            "kind": "Ghost",
            "metadata": {
                "name": name,
                "namespace": NAMESPACE,
                "labels": {
                    "template.wecode.io/source": template_name,
                    "template.wecode.io/category": "inbox",
                },
            },
            "spec": ghost_spec,
            "status": {"state": "Available"},
        }

        ghost = Kind(
            user_id=user_id,
            kind="Ghost",
            name=name,
            namespace=NAMESPACE,
            json=ghost_json,
            is_active=True,
        )
        db.add(ghost)
        db.flush()
        logger.info(f"Created Ghost from template: name={name}, id={ghost.id}")
        return ghost

    def _create_bot(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        config: Dict,
        ghost: Kind,
    ) -> Kind:
        """Create a Bot resource referencing the Ghost."""
        name = f"tpl-{template_name}-{suffix}-bot"
        shell_name = config.get("shellName", "Chat")

        # Public shells use 'default' namespace
        shell_namespace = "default"

        # Build model reference from agent_config if provided
        model_ref_name = ""
        model_ref_namespace = "default"
        agent_config = config.get("agentConfig") or {}
        if agent_config.get("bind_model"):
            model_ref_name = agent_config["bind_model"]
            model_ref_namespace = agent_config.get("namespace", "default")

        bot_json = {
            "apiVersion": API_VERSION,
            "kind": "Bot",
            "metadata": {
                "name": name,
                "namespace": NAMESPACE,
                "labels": {
                    "template.wecode.io/source": template_name,
                    "template.wecode.io/category": "inbox",
                },
            },
            "spec": {
                "ghostRef": {"name": ghost.name, "namespace": NAMESPACE},
                "shellRef": {"name": shell_name, "namespace": shell_namespace},
                "modelRef": {
                    "name": model_ref_name,
                    "namespace": model_ref_namespace,
                },
            },
            "status": {"state": "Available"},
        }

        bot = Kind(
            user_id=user_id,
            kind="Bot",
            name=name,
            namespace=NAMESPACE,
            json=bot_json,
            is_active=True,
        )
        db.add(bot)
        db.flush()
        logger.info(f"Created Bot from template: name={name}, id={bot.id}")
        return bot

    def _create_team(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
        bot: Kind,
    ) -> Kind:
        """Create a Team resource referencing the Bot."""
        name = f"tpl-{template_name}-{suffix}"
        collaboration_model = config.get("collaborationModel", "pipeline")

        team_spec = {
            "members": [
                {
                    "botRef": {"name": bot.name, "namespace": NAMESPACE},
                    "prompt": "",
                    "role": "",
                    "requireConfirmation": False,
                }
            ],
            "collaborationModel": collaboration_model,
            "description": config.get("description", display_name),
        }
        if config.get("bindMode"):
            team_spec["bind_mode"] = config["bindMode"]

        team_json = {
            "apiVersion": API_VERSION,
            "kind": "Team",
            "metadata": {
                "name": name,
                "namespace": NAMESPACE,
                "labels": {
                    "template.wecode.io/source": template_name,
                    "template.wecode.io/category": "inbox",
                },
            },
            "spec": team_spec,
            "status": {"state": "Available"},
        }

        team = Kind(
            user_id=user_id,
            kind="Team",
            name=name,
            namespace=NAMESPACE,
            json=team_json,
            is_active=True,
        )
        db.add(team)
        db.flush()
        logger.info(f"Created Team from template: name={name}, id={team.id}")
        return team

    def _create_subscription(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
        team: Kind,
    ) -> Kind:
        """Create a Subscription resource for inbox message processing."""
        name = f"tpl-{template_name}-{suffix}-sub"

        # Build CRD spec following the Subscription CRD pattern
        sub_spec = {
            "displayName": f"{display_name} - Subscription",
            "taskType": "collection",
            "visibility": "private",
            "trigger": {
                "type": "event",
                "event": {
                    "eventType": "inbox_message",
                },
            },
            "teamRef": {"name": team.name, "namespace": NAMESPACE},
            "promptTemplate": config.get(
                "promptTemplate", "Process this inbox message."
            ),
            "retryCount": config.get("retryCount", 1),
            "timeoutSeconds": config.get("timeoutSeconds", 600),
            "enabled": True,
            "executionTarget": {"type": "managed"},
            "preserveHistory": False,
            "historyMessageCount": 10,
        }

        now = datetime.now(timezone.utc).replace(tzinfo=None)

        crd_json = {
            "apiVersion": API_VERSION,
            "kind": "Subscription",
            "metadata": {
                "name": name,
                "namespace": NAMESPACE,
                "displayName": f"{display_name} - Subscription",
                "labels": {
                    "template.wecode.io/source": template_name,
                    "template.wecode.io/category": "inbox",
                },
            },
            "spec": sub_spec,
            "status": {"state": "Active"},
            "_internal": {
                "team_id": team.id,
                "workspace_id": 0,
                "webhook_token": "",
                "webhook_secret": "",
                "enabled": True,
                "trigger_type": "event",
                "next_execution_time": now.isoformat(),
                "last_execution_time": None,
                "last_execution_status": "",
                "execution_count": 0,
                "success_count": 0,
                "failure_count": 0,
                "bound_task_id": 0,
                "market_whitelist_user_ids": [],
                "expires_at": None,
            },
        }

        subscription = Kind(
            user_id=user_id,
            kind="Subscription",
            name=name,
            namespace=NAMESPACE,
            json=crd_json,
            is_active=True,
        )
        db.add(subscription)
        db.flush()
        logger.info(
            f"Created Subscription from template: name={name}, id={subscription.id}"
        )
        return subscription

    def _create_queue(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
        subscription: Kind,
    ) -> Kind:
        """Create a WorkQueue with auto-process linked to the Subscription."""
        name = f"tpl-{template_name}-{suffix}-queue"
        visibility = config.get("visibility", "private")
        trigger_mode = config.get("triggerMode", "immediate")

        queue_spec = {
            "displayName": display_name,
            "description": f"Auto-created from template: {display_name}",
            "isDefault": False,
            "visibility": visibility,
            "autoProcess": {
                "enabled": True,
                "mode": "subscription",
                "subscriptionRef": {
                    "namespace": NAMESPACE,
                    "name": subscription.name,
                    "userId": user_id,
                },
                "triggerMode": trigger_mode,
            },
            "resultFeedback": {
                "replyToSender": False,
                "saveInQueue": True,
                "sendNotification": False,
            },
        }

        resource_json = {
            "apiVersion": API_VERSION,
            "kind": "WorkQueue",
            "metadata": {
                "name": name,
                "namespace": NAMESPACE,
                "labels": {
                    "template.wecode.io/source": template_name,
                    "template.wecode.io/category": "inbox",
                },
            },
            "spec": queue_spec,
            "status": {"state": "Available"},
        }

        queue = Kind(
            user_id=user_id,
            kind="WorkQueue",
            name=name,
            namespace=NAMESPACE,
            json=resource_json,
            is_active=True,
        )
        db.add(queue)
        db.flush()
        logger.info(f"Created WorkQueue from template: name={name}, id={queue.id}")
        return queue


# --- Instantiator Registry ---

_INSTANTIATORS: Dict[str, BaseTemplateInstantiator] = {
    "inbox": InboxTemplateInstantiator(),
}


def get_instantiator(category: str) -> BaseTemplateInstantiator:
    """Get the instantiator for the given template category."""
    instantiator = _INSTANTIATORS.get(category)
    if not instantiator:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported template category: '{category}'",
        )
    return instantiator

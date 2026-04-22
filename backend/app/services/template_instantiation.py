# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Template instantiation engine.

Templates define a list of Kind resources to create. The instantiator
iterates over the resource list in order, creates each Kind, and resolves
cross-references (e.g. ghostRef, botRef, subscriptionRef) using the names
of previously created resources.

Supported resource types: Ghost, Bot, Team, Subscription, WorkQueue.
Any resource type can be omitted from the template - only defined resources
are created.
"""

import logging
import secrets
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.subscription import (
    SubscriptionCreate,
    SubscriptionExecutionTarget,
    SubscriptionExecutionTargetType,
    SubscriptionTaskType,
    SubscriptionTriggerType,
    SubscriptionVisibility,
)
from app.schemas.template import TemplateInstantiateResponse
from app.services.subscription.helpers import build_subscription_crd

logger = logging.getLogger(__name__)

NAMESPACE = "default"
API_VERSION = "agent.wecode.io/v1"

# Ordered list of resource keys as they appear in template YAML.
# Resources are created in this order so that later resources can reference
# earlier ones (e.g. Bot references Ghost, Team references Bot).
RESOURCE_ORDER: List[str] = ["ghost", "bot", "team", "subscription", "queue"]


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

    @staticmethod
    def _create_kind(
        db: Session,
        user_id: int,
        kind_type: str,
        name: str,
        json_data: Dict[str, Any],
    ) -> Kind:
        """Persist a single Kind record and flush to obtain its database ID.

        This is the single entry point for all Kind creation in the template
        instantiation engine. All resource-specific helpers must call this
        method instead of constructing Kind objects directly.
        """
        kind = Kind(
            user_id=user_id,
            kind=kind_type,
            name=name,
            namespace=NAMESPACE,
            json=json_data,
            is_active=True,
        )
        db.add(kind)
        db.flush()
        logger.info(f"Created {kind_type} from template: name={name}, id={kind.id}")
        return kind


class InboxTemplateInstantiator(BaseTemplateInstantiator):
    """Instantiator for inbox-category templates.

    Iterates over the resource list defined in the template spec and creates
    each Kind in dependency order. Resources not present in the template are
    simply skipped - no resource type is mandatory.

    Dependency order: Ghost -> Bot -> Team -> Subscription -> WorkQueue

    WorkQueue auto-process mode is determined automatically:
    - If a Subscription was created: mode='subscription' with subscriptionRef
    - If queue config has 'teamRef': mode='direct_agent' using the referenced Team
    - If a Team was created: mode='direct_agent' using the newly created Team
    """

    def instantiate(
        self, db: Session, user_id: int, template: Kind
    ) -> TemplateInstantiateResponse:
        spec = template.json.get("spec", {})
        resources = spec.get("resources", {})
        template_name = template.name
        suffix = self._generate_suffix()
        display_name = spec.get("displayName", template_name)

        # Track created kinds by resource key for cross-reference resolution
        created: Dict[str, Optional[Kind]] = {key: None for key in RESOURCE_ORDER}

        # Create each resource in dependency order, skipping absent ones
        for resource_key in RESOURCE_ORDER:
            config = resources.get(resource_key)
            if config is None:
                continue

            if resource_key == "ghost":
                created["ghost"] = self._build_ghost(
                    db, user_id, template_name, suffix, display_name, config
                )
            elif resource_key == "bot":
                created["bot"] = self._build_bot(
                    db, user_id, template_name, suffix, config, created["ghost"]
                )
            elif resource_key == "team":
                created["team"] = self._build_team(
                    db,
                    user_id,
                    template_name,
                    suffix,
                    display_name,
                    config,
                    created["bot"],
                )
            elif resource_key == "subscription":
                if created["team"] is None:
                    raise HTTPException(
                        status_code=400,
                        detail="Template defines a Subscription but no Team was created",
                    )
                created["subscription"] = self._build_subscription(
                    db,
                    user_id,
                    template_name,
                    suffix,
                    display_name,
                    config,
                    created["team"],
                )
            elif resource_key == "queue":
                created["queue"] = self._build_work_queue(
                    db,
                    user_id,
                    template_name,
                    suffix,
                    display_name,
                    config,
                    created_team=created["team"],
                    subscription=created["subscription"],
                )

        # Flush to ensure all IDs are assigned
        db.flush()

        queue = created["queue"]
        if queue is None:
            raise HTTPException(
                status_code=400,
                detail="Template must define at least a 'queue' resource",
            )

        return TemplateInstantiateResponse(
            ghostId=created["ghost"].id if created["ghost"] else None,
            botId=created["bot"].id if created["bot"] else None,
            teamId=created["team"].id if created["team"] else None,
            subscriptionId=(
                created["subscription"].id if created["subscription"] else None
            ),
            queueId=queue.id,
            queueName=queue.name,
        )

    # ------------------------------------------------------------------
    # Resource builders - each returns a Kind via _create_kind()
    # Method names follow the pattern _build_{kind_type_lowercase}.
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_bot_model_ref(agent_config: Dict[str, Any]) -> Dict[str, str]:
        """Resolve template bot agentConfig into a Bot spec modelRef."""
        model_name = agent_config.get("bind_model", "")
        namespace = agent_config.get("bind_model_namespace") or NAMESPACE

        return {"name": model_name, "namespace": namespace}

    def _build_ghost(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
    ) -> Kind:
        """Build and persist a Ghost Kind from template config."""
        name = f"tpl-{template_name}-{suffix}-ghost"
        ghost_spec: Dict[str, Any] = {
            "systemPrompt": config.get("systemPrompt", ""),
        }
        if config.get("mcpServers"):
            ghost_spec["mcpServers"] = config["mcpServers"]

        skill_names, _skill_refs = self._resolve_template_skill_refs(
            db=db, skill_refs=config.get("skillRefs") or []
        )
        if skill_names:
            ghost_spec["skills"] = skill_names

        preload_skill_names, _preload_skil_refs = self._resolve_template_skill_refs(
            db=db, skill_refs=config.get("preloadSkillRefs") or []
        )
        if preload_skill_names:
            ghost_spec["preload_skills"] = preload_skill_names

        return self._create_kind(
            db,
            user_id,
            "Ghost",
            name,
            {
                "apiVersion": API_VERSION,
                "kind": "Ghost",
                "metadata": {
                    "name": name,
                    "namespace": NAMESPACE,
                    "labels": {"template.wecode.io/source": template_name},
                },
                "spec": ghost_spec,
                "status": {"state": "Available"},
            },
        )

    def _resolve_template_skill_refs(
        self, db: Session, skill_refs: List[Dict[str, Any]]
    ) -> tuple[List[str], Dict[str, Dict[str, Any]]]:
        """Resolve template skill triplets into Ghost skill fields."""
        if not skill_refs:
            return [], {}

        skill_names: List[str] = []
        resolved: Dict[str, Dict[str, Any]] = {}

        for ref in skill_refs:
            skill_name = ref["name"]
            if skill_name in skill_names:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Template ghost skill refs contain duplicate skill names. "
                        f"Duplicate: '{skill_name}'"
                    ),
                )
            skill_names.append(skill_name)

            skill = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Skill",
                    Kind.name == skill_name,
                    Kind.namespace == ref.get("namespace", NAMESPACE),
                    Kind.user_id == ref["user_id"],
                    Kind.is_active == True,
                )
                .first()
            )
            if not skill:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "Template ghost skillRef not found: "
                        f"name='{ref['name']}', "
                        f"namespace='{ref.get('namespace', NAMESPACE)}', "
                        f"user_id={ref['user_id']}"
                    ),
                )

            resolved[skill_name] = {
                "skill_id": skill.id,
                "namespace": skill.namespace,
                "is_public": skill.user_id == 0,
            }

        return skill_names, resolved

    def _build_bot(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        config: Dict,
        ghost: Optional[Kind],
    ) -> Kind:
        """Build and persist a Bot Kind referencing the Ghost (if any)."""
        name = f"tpl-{template_name}-{suffix}-bot"
        shell_name = config.get("shellName", "Chat")
        shell_namespace = "default"

        agent_config = config.get("agentConfig") or {}
        model_ref = self._resolve_bot_model_ref(agent_config)

        bot_spec: Dict[str, Any] = {
            "shellRef": {"name": shell_name, "namespace": shell_namespace},
            "modelRef": model_ref,
        }
        if ghost is not None:
            bot_spec["ghostRef"] = {"name": ghost.name, "namespace": NAMESPACE}

        return self._create_kind(
            db,
            user_id,
            "Bot",
            name,
            {
                "apiVersion": API_VERSION,
                "kind": "Bot",
                "metadata": {
                    "name": name,
                    "namespace": NAMESPACE,
                    "labels": {"template.wecode.io/source": template_name},
                },
                "spec": bot_spec,
                "status": {"state": "Available"},
            },
        )

    def _build_team(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
        bot: Optional[Kind],
    ) -> Kind:
        """Build and persist a Team Kind referencing the Bot (if any)."""
        name = f"tpl-{template_name}-{suffix}"
        collaboration_model = config.get("collaborationModel", "pipeline")

        members = []
        if bot is not None:
            members.append(
                {
                    "botRef": {"name": bot.name, "namespace": NAMESPACE},
                    "prompt": "",
                    "role": "leader",
                    "requireConfirmation": False,
                }
            )

        team_spec: Dict[str, Any] = {
            "members": members,
            "collaborationModel": collaboration_model,
            "description": config.get("description", display_name),
        }
        if config.get("bindMode"):
            team_spec["bind_mode"] = config["bindMode"]

        return self._create_kind(
            db,
            user_id,
            "Team",
            name,
            {
                "apiVersion": API_VERSION,
                "kind": "Team",
                "metadata": {
                    "name": name,
                    "namespace": NAMESPACE,
                    "labels": {"template.wecode.io/source": template_name},
                },
                "spec": team_spec,
                "status": {"state": "Available"},
            },
        )

    def _build_subscription(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
        team: Kind,
    ) -> Kind:
        """Build and persist a Subscription Kind for inbox message processing.

        Uses Pydantic models via build_subscription_crd() to ensure the stored
        JSON uses the correct field names (snake_case) that validate_subscription_for_read()
        expects when resolving the subscription during inbox auto-processing.
        """
        name = f"tpl-{template_name}-{suffix}-sub"

        # Build SubscriptionCreate to reuse the standard CRD builder.
        # This guarantees the stored JSON matches what Subscription.model_validate()
        # expects (e.g. event_type instead of eventType).
        subscription_in = SubscriptionCreate(
            name=name,
            namespace=NAMESPACE,
            display_name=f"{display_name} - Subscription",
            task_type=SubscriptionTaskType.COLLECTION,
            visibility=SubscriptionVisibility.PRIVATE,
            trigger_type=SubscriptionTriggerType.EVENT,
            trigger_config={"event_type": "inbox_message"},
            team_id=team.id,
            prompt_template=config.get("promptTemplate", "Process this inbox message."),
            retry_count=config.get("retryCount", 1),
            timeout_seconds=config.get("timeoutSeconds", 600),
            enabled=True,
            execution_target=SubscriptionExecutionTarget(
                type=SubscriptionExecutionTargetType.MANAGED
            ),
            preserve_history=False,
            history_message_count=10,
        )

        webhook_token = secrets.token_urlsafe(32)
        webhook_secret = secrets.token_urlsafe(32)

        subscription_crd = build_subscription_crd(
            subscription_in, team, workspace=None, webhook_token=webhook_token
        )

        now = datetime.now(timezone.utc).replace(tzinfo=None)
        crd_json = subscription_crd.model_dump(mode="json")
        crd_json["metadata"]["labels"] = {
            "template.wecode.io/source": template_name,
        }
        crd_json["_internal"] = {
            "team_id": team.id,
            "workspace_id": 0,
            "webhook_token": webhook_token,
            "webhook_secret": webhook_secret,
            "enabled": True,
            "trigger_type": SubscriptionTriggerType.EVENT.value,
            "next_execution_time": now.isoformat(),
            "last_execution_time": None,
            "last_execution_status": "",
            "execution_count": 0,
            "success_count": 0,
            "failure_count": 0,
            "bound_task_id": 0,
            "market_whitelist_user_ids": [],
            "expires_at": None,
        }

        return self._create_kind(db, user_id, "Subscription", name, crd_json)

    def _build_work_queue(
        self,
        db: Session,
        user_id: int,
        template_name: str,
        suffix: str,
        display_name: str,
        config: Dict,
        created_team: Optional[Kind],
        subscription: Optional[Kind],
    ) -> Kind:
        """Build and persist a WorkQueue Kind.

        Auto-process mode priority:
        1. subscription present  -> mode='subscription' with subscriptionRef
        2. config has 'teamRef'  -> mode='direct_agent' referencing an existing Team
        3. created_team present  -> mode='direct_agent' referencing the newly created Team
        4. none of the above     -> error
        """
        name = f"tpl-{template_name}-{suffix}-queue"
        visibility = config.get("visibility", "private")
        trigger_mode = config.get("triggerMode", "immediate")

        if subscription is not None:
            auto_process: Dict[str, Any] = {
                "enabled": True,
                "mode": "subscription",
                "subscriptionRef": {
                    "namespace": NAMESPACE,
                    "name": subscription.name,
                    "userId": user_id,
                },
                "triggerMode": trigger_mode,
            }
        elif config.get("teamRef"):
            # Use an existing Team referenced by name/namespace in the template config.
            # This allows templates that point to system public Teams (e.g. wegent-chat)
            # without needing to create Ghost/Bot/Team resources.
            team_ref = config["teamRef"]
            auto_process = {
                "enabled": True,
                "mode": "direct_agent",
                "teamRef": {
                    "namespace": team_ref.get("namespace", NAMESPACE),
                    "name": team_ref["name"],
                },
                "triggerMode": trigger_mode,
            }
        elif created_team is not None:
            auto_process = {
                "enabled": True,
                "mode": "direct_agent",
                "teamRef": {
                    "namespace": NAMESPACE,
                    "name": created_team.name,
                },
                "triggerMode": trigger_mode,
            }
        else:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Template queue requires either a Subscription, a teamRef, or a "
                    "Team resource for auto-process configuration"
                ),
            )

        return self._create_kind(
            db,
            user_id,
            "WorkQueue",
            name,
            {
                "apiVersion": API_VERSION,
                "kind": "WorkQueue",
                "metadata": {
                    "name": name,
                    "namespace": NAMESPACE,
                    "labels": {"template.wecode.io/source": template_name},
                },
                "spec": {
                    "displayName": display_name,
                    "description": f"Auto-created from template: {display_name}",
                    "isDefault": False,
                    "visibility": visibility,
                    "autoProcess": auto_process,
                    "resultFeedback": {
                        "replyToSender": False,
                        "saveInQueue": True,
                        "sendNotification": False,
                    },
                },
                "status": {"state": "Available"},
            },
        )


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

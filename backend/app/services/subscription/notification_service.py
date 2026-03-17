# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription notification service for managing follower notifications.

This module provides:
- Follow notification settings management
- IM channel binding detection
- Notification dispatch for subscription executions
"""

import json
import logging
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import redis
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.subscription_follow import (
    FollowType,
    InvitationStatus,
    NotificationLevel,
    SubscriptionFollow,
)
from app.models.user import User
from app.schemas.subscription import (
    FollowSettingsResponse,
    IMChannelBinding,
    NotificationChannelInfo,
)
from app.schemas.subscription import NotificationLevel as SchemaNotificationLevel
from app.schemas.subscription import (
    SubscriptionFollowConfig,
)
from app.services.subscription.websocket import (
    emit_subscription_binding_update,
    emit_subscription_group_info,
)

logger = logging.getLogger(__name__)

# Messager CRD kind
MESSAGER_KIND = "Messager"
MESSAGER_USER_ID = 0
SUBSCRIPTION_KIND = "Subscription"
BINDING_PENDING_TTL_SECONDS = 600
BINDING_PENDING_PREFIX = "subscription:binding:pending:"
BINDING_PENDING_INDEX_PREFIX = "subscription:binding:pending:index:"


class SubscriptionNotificationService:
    """Service for managing subscription follower notifications."""

    def get_follow_settings(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> FollowSettingsResponse:
        """
        Get notification settings for a subscription follow.

        Args:
            db: Database session
            subscription_id: Subscription ID
            user_id: Follower user ID

        Returns:
            Follow settings with available channels
        """
        # Get the follow record
        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
                SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
            )
            .first()
        )

        if not follow:
            # Return default settings if not following
            return FollowSettingsResponse(
                notification_level=SchemaNotificationLevel.DEFAULT,
                notification_channel_ids=[],
                notification_channels=[],
                available_channels=self.get_available_channels(db, user_id),
            )

        # Parse config
        config = self._parse_follow_config(follow.config)

        # Get selected channel info
        selected_channels = []
        if config.notification_channel_ids:
            selected_channels = self._get_channels_info(
                db, config.notification_channel_ids, user_id
            )

        return FollowSettingsResponse(
            notification_level=config.notification_level,
            notification_channel_ids=config.notification_channel_ids or [],
            notification_channels=selected_channels,
            available_channels=self.get_available_channels(db, user_id),
        )

    def update_follow_settings(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
        notification_level: SchemaNotificationLevel,
        notification_channel_ids: Optional[List[int]] = None,
    ) -> FollowSettingsResponse:
        """
        Update notification settings for a subscription follow.

        Args:
            db: Database session
            subscription_id: Subscription ID
            user_id: Follower user ID
            notification_level: New notification level
            notification_channel_ids: Messager channel IDs (for notify level)

        Returns:
            Updated follow settings

        Raises:
            ValueError: If not following the subscription
        """
        # Get the follow record
        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
                SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
            )
            .first()
        )

        if not follow:
            raise ValueError("Not following this subscription")

        # Build new config
        config = SubscriptionFollowConfig(
            notification_level=notification_level,
            notification_channel_ids=notification_channel_ids,
        )

        # Update follow record
        follow.config = config.model_dump_json()
        follow.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

        logger.info(
            f"[SubscriptionNotification] Updated settings for user {user_id} on subscription {subscription_id}: "
            f"level={notification_level.value}, channels={notification_channel_ids}"
        )

        # Return updated settings
        selected_channels = []
        if notification_channel_ids:
            selected_channels = self._get_channels_info(
                db, notification_channel_ids, user_id
            )

        return FollowSettingsResponse(
            notification_level=notification_level,
            notification_channel_ids=notification_channel_ids or [],
            notification_channels=selected_channels,
            available_channels=self.get_available_channels(db, user_id),
        )

    def get_developer_settings(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> "DeveloperNotificationSettingsResponse":
        """
        Get notification settings for the subscription developer.

        Args:
            db: Database session
            subscription_id: Subscription ID
            user_id: Developer user ID (must be subscription owner)

        Returns:
            Developer notification settings with available channels

        Raises:
            ValueError: If user is not the subscription owner
        """
        from app.schemas.subscription import (
            DeveloperNotificationSettingsResponse,
        )

        # Verify user is the subscription owner
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise ValueError("Subscription not found")

        if subscription.user_id != user_id:
            raise ValueError("Only subscription owner can access developer settings")

        # Get developer follow record (follower_user_id matches subscription owner)
        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
            )
            .first()
        )

        if follow:
            # Parse config
            config = self._parse_follow_config(follow.config)
            channel_binding_configs = self._get_subscription_channel_binding_configs(
                subscription
            )
            return DeveloperNotificationSettingsResponse(
                notification_level=config.notification_level,
                notification_channel_ids=config.notification_channel_ids or [],
                available_channels=self.get_available_channels(db, user_id),
                channel_binding_configs=channel_binding_configs,
            )

        # No developer follow record yet, return defaults (NOTIFY level)
        return DeveloperNotificationSettingsResponse(
            notification_level=SchemaNotificationLevel.NOTIFY,
            notification_channel_ids=[],
            available_channels=self.get_available_channels(db, user_id),
            channel_binding_configs=self._get_subscription_channel_binding_configs(
                subscription
            ),
        )

    def update_developer_settings(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
        notification_level: SchemaNotificationLevel,
        notification_channel_ids: Optional[List[int]] = None,
        channel_binding_configs: Optional[List[Any]] = None,
    ) -> "DeveloperNotificationSettingsResponse":
        """
        Update notification settings for the subscription developer.

        Args:
            db: Database session
            subscription_id: Subscription ID
            user_id: Developer user ID (must be subscription owner)
            notification_level: New notification level
            notification_channel_ids: Messager channel IDs (for notify level)

        Returns:
            Updated developer notification settings

        Raises:
            ValueError: If user is not the subscription owner
        """
        from app.schemas.subscription import DeveloperNotificationSettingsResponse

        # Verify user is the subscription owner
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not subscription:
            raise ValueError("Subscription not found")

        if subscription.user_id != user_id:
            raise ValueError("Only subscription owner can update developer settings")

        # Get or create developer follow record
        follow = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
            )
            .first()
        )

        if not follow:
            # Create new developer follow record
            follow = SubscriptionFollow(
                subscription_id=subscription_id,
                follower_user_id=user_id,
                follow_type=FollowType.DIRECT.value,
                invitation_status=InvitationStatus.ACCEPTED.value,
                config="",
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
                updated_at=datetime.now(timezone.utc).replace(tzinfo=None),
            )
            db.add(follow)

        # Build and save config
        config = SubscriptionFollowConfig(
            notification_level=notification_level,
            notification_channel_ids=notification_channel_ids,
        )
        follow.config = config.model_dump_json()
        follow.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)

        if channel_binding_configs is not None:
            subscription = self._get_subscription_for_owner(
                db, subscription_id=subscription_id, user_id=user_id
            )
            json_data = deepcopy(subscription.json or {})
            internal = json_data.get("_internal", {})
            channel_binding_map: Dict[str, Any] = {}
            for item in channel_binding_configs:
                if hasattr(item, "model_dump"):
                    item_data = item.model_dump()
                else:
                    item_data = dict(item)
                channel_id = str(item_data["channel_id"])
                channel_binding_map[channel_id] = {
                    "bind_private": bool(item_data.get("bind_private", True)),
                    "bind_group": bool(item_data.get("bind_group", False)),
                    "group_conversation_id": item_data.get("group_conversation_id"),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            internal["notification_channel_bindings"] = channel_binding_map
            json_data["_internal"] = internal
            subscription.json = json_data
            subscription.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()

        logger.info(
            f"[SubscriptionNotification] Updated developer settings for user {user_id} "
            f"on subscription {subscription_id}: level={notification_level.value}, "
            f"channels={notification_channel_ids}"
        )

        return DeveloperNotificationSettingsResponse(
            notification_level=notification_level,
            notification_channel_ids=notification_channel_ids or [],
            available_channels=self.get_available_channels(db, user_id),
            channel_binding_configs=self._get_subscription_channel_binding_configs(
                subscription
                if channel_binding_configs is not None
                else self._get_subscription_for_owner(
                    db, subscription_id=subscription_id, user_id=user_id
                )
            ),
        )

    def ensure_developer_follow(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> None:
        """
        Ensure developer follow record exists for subscription owner.

        Called when creating a new subscription. Creates a follow record
        with default NOTIFY level if it doesn't exist.

        Args:
            db: Database session
            subscription_id: Subscription ID
            user_id: Developer user ID (subscription owner)
        """
        # Check if developer follow record already exists
        existing = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.follower_user_id == user_id,
            )
            .first()
        )

        if existing:
            return

        # Create new developer follow record with default NOTIFY level
        config = SubscriptionFollowConfig(
            notification_level=SchemaNotificationLevel.NOTIFY,
            notification_channel_ids=[],
        )

        follow = SubscriptionFollow(
            subscription_id=subscription_id,
            follower_user_id=user_id,
            follow_type=FollowType.DIRECT.value,
            invitation_status=InvitationStatus.ACCEPTED.value,
            config=config.model_dump_json(),
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            updated_at=datetime.now(timezone.utc).replace(tzinfo=None),
        )
        db.add(follow)
        db.commit()

        logger.info(
            f"[SubscriptionNotification] Created developer follow for user {user_id} "
            f"on subscription {subscription_id} with NOTIFY level"
        )

    def get_followers_with_settings(
        self,
        db: Session,
        *,
        subscription_id: int,
    ) -> List[Tuple[int, SubscriptionFollowConfig]]:
        """
        Get all accepted followers and their notification settings for a subscription.

        Args:
            db: Database session
            subscription_id: Subscription ID

        Returns:
            List of (user_id, config) tuples
        """
        follows = (
            db.query(SubscriptionFollow)
            .filter(
                SubscriptionFollow.subscription_id == subscription_id,
                SubscriptionFollow.invitation_status == InvitationStatus.ACCEPTED.value,
            )
            .all()
        )

        result = []
        for follow in follows:
            config = self._parse_follow_config(follow.config)
            result.append((follow.follower_user_id, config))

        return result

    def get_user_im_bindings(
        self,
        db: Session,
        *,
        user_id: int,
    ) -> Dict[str, IMChannelBinding]:
        """
        Get user's IM channel bindings from preferences.

        Args:
            db: Database session
            user_id: User ID

        Returns:
            Dict mapping channel_id (string) to IMChannelBinding
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user or not user.preferences:
            return {}

        try:
            preferences = json.loads(user.preferences)
            im_channels = preferences.get("im_channels", {})
            result = {}
            for channel_id, binding_data in im_channels.items():
                try:
                    result[channel_id] = IMChannelBinding.model_validate(binding_data)
                except Exception as e:
                    logger.warning(
                        f"[SubscriptionNotification] Invalid IM binding for user {user_id}, "
                        f"channel {channel_id}: {e}"
                    )
            return result
        except json.JSONDecodeError:
            return {}

    def update_user_im_binding(
        self,
        db: Session,
        *,
        user_id: int,
        channel_id: int,
        channel_type: str,
        sender_id: str,
        sender_staff_id: Optional[str] = None,
        conversation_id: Optional[str] = None,
    ) -> None:
        """
        Update user's IM channel binding in preferences.

        Called when user sends a message via Messager channel.

        Args:
            db: Database session
            user_id: User ID
            channel_id: Messager Kind ID
            channel_type: Channel type (dingtalk, feishu, etc.)
            sender_id: User's ID in the IM platform
            sender_staff_id: Staff ID (for enterprise channels)
            conversation_id: Current conversation/task ID
        """
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            logger.warning(
                f"[SubscriptionNotification] User {user_id} not found for IM binding update"
            )
            return

        try:
            preferences = json.loads(user.preferences or "{}")
        except json.JSONDecodeError:
            preferences = {}

        im_channels = preferences.get("im_channels", {})
        im_channels[str(channel_id)] = {
            "channel_type": channel_type,
            "sender_id": sender_id,
            "sender_staff_id": sender_staff_id,
            "last_conversation_id": conversation_id,
            "last_active_at": datetime.now(timezone.utc).isoformat(),
        }
        preferences["im_channels"] = im_channels

        user.preferences = json.dumps(preferences)
        db.commit()

        logger.debug(
            f"[SubscriptionNotification] Updated IM binding for user {user_id}, "
            f"channel {channel_id} ({channel_type})"
        )

    def _parse_follow_config(
        self, config_json: Optional[str]
    ) -> SubscriptionFollowConfig:
        """Parse follow config from JSON string."""
        if not config_json:
            return SubscriptionFollowConfig()

        try:
            data = json.loads(config_json)
            return SubscriptionFollowConfig.model_validate(data)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning(f"[SubscriptionNotification] Invalid config JSON: {e}")
            return SubscriptionFollowConfig()

    def get_available_channels(
        self,
        db: Session,
        user_id: int,
    ) -> List[NotificationChannelInfo]:
        """
        Get all available Messager channels with binding status.

        Args:
            db: Database session
            user_id: User ID to check bindings

        Returns:
            List of channel info with binding status
        """
        # Get all enabled Messager channels (global channels created by admin)
        channels = (
            db.query(Kind)
            .filter(
                Kind.kind == MESSAGER_KIND,
                Kind.user_id == MESSAGER_USER_ID,
                Kind.is_active == True,
            )
            .all()
        )

        # Get user's IM bindings (stores which Messager channels user has bound to)
        user_bindings = self.get_user_im_bindings(db, user_id=user_id)

        result = []
        for channel in channels:
            # Get channel spec from json field
            spec = channel.json.get("spec", {}) if channel.json else {}
            if not spec.get("isEnabled", True):
                continue

            channel_info = NotificationChannelInfo(
                id=channel.id,
                name=(
                    channel.json.get("metadata", {}).get("name", channel.name)
                    if channel.json
                    else channel.name
                ),
                channel_type=spec.get("channelType", "unknown"),
                is_bound=str(channel.id) in user_bindings,
            )
            result.append(channel_info)

        return result

    def _get_channels_info(
        self,
        db: Session,
        channel_ids: List[int],
        user_id: int,
    ) -> List[NotificationChannelInfo]:
        """
        Get channel info for specific channel IDs.

        Args:
            db: Database session
            channel_ids: List of Messager Kind IDs
            user_id: User ID to check bindings

        Returns:
            List of channel info
        """
        if not channel_ids:
            return []

        # Get channel details from Messager kinds (global channels)
        channels = (
            db.query(Kind)
            .filter(
                Kind.id.in_(channel_ids),
                Kind.kind == MESSAGER_KIND,
                Kind.is_active == True,
            )
            .all()
        )

        # Get user's IM bindings
        user_bindings = self.get_user_im_bindings(db, user_id=user_id)

        result = []
        for channel in channels:
            # Get spec from json field for Messager kind
            spec = channel.json.get("spec", {}) if channel.json else {}
            channel_info = NotificationChannelInfo(
                id=channel.id,
                name=(
                    channel.json.get("metadata", {}).get("name", channel.name)
                    if channel.json
                    else channel.name
                ),
                channel_type=spec.get("channelType", "unknown"),
                is_bound=str(channel.id) in user_bindings,
            )
            result.append(channel_info)

        return result

    def _get_binding_pending_key(
        self, *, user_id: int, channel_id: int, subscription_id: Optional[int] = None
    ) -> str:
        if subscription_id is not None:
            return f"{BINDING_PENDING_PREFIX}{user_id}:{subscription_id}:{channel_id}"
        return f"{BINDING_PENDING_PREFIX}{user_id}:{channel_id}"

    def _get_binding_pending_index_key(self, *, user_id: int) -> str:
        return f"{BINDING_PENDING_INDEX_PREFIX}{user_id}"

    def _get_redis_client(self):
        return redis.from_url(settings.REDIS_URL, decode_responses=True)

    def _get_subscription_channel_binding_configs(
        self, subscription: Kind
    ) -> List[Dict[str, Any]]:
        json_data = subscription.json or {}
        internal = json_data.get("_internal", {})
        binding_map = internal.get("notification_channel_bindings", {})
        result: List[Dict[str, Any]] = []
        for channel_id, cfg in binding_map.items():
            result.append(
                {
                    "channel_id": int(channel_id),
                    "bind_private": bool(cfg.get("bind_private", True)),
                    "bind_group": bool(cfg.get("bind_group", False)),
                    "group_conversation_id": cfg.get("group_conversation_id"),
                    "group_name": cfg.get("group_name"),
                }
            )
        return result

    def _get_subscription_for_owner(
        self, db: Session, *, subscription_id: int, user_id: int
    ) -> Kind:
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == SUBSCRIPTION_KIND,
                Kind.is_active == True,
            )
            .first()
        )
        if not subscription:
            raise ValueError("Subscription not found")
        if subscription.user_id != user_id:
            raise ValueError("Only subscription owner can configure bindings")
        return subscription

    def get_subscription_channel_binding_config(
        self, db: Session, *, subscription_id: int, channel_id: int
    ) -> Optional[Dict[str, Any]]:
        subscription = (
            db.query(Kind)
            .filter(
                Kind.id == subscription_id,
                Kind.kind == SUBSCRIPTION_KIND,
                Kind.is_active == True,
            )
            .first()
        )
        if not subscription:
            return None
        json_data = subscription.json or {}
        internal = json_data.get("_internal", {})
        binding_map = internal.get("notification_channel_bindings", {})
        cfg = binding_map.get(str(channel_id))
        if not cfg:
            return None
        return {
            "bind_private": bool(cfg.get("bind_private", True)),
            "bind_group": bool(cfg.get("bind_group", False)),
            "group_conversation_id": cfg.get("group_conversation_id"),
        }

    def _upsert_subscription_channel_binding(
        self,
        db: Session,
        *,
        subscription: Kind,
        channel_id: int,
        bind_private: Optional[bool] = None,
        bind_group: Optional[bool] = None,
        group_conversation_id: Optional[str] = None,
        group_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        json_data = deepcopy(subscription.json or {})
        internal = json_data.get("_internal", {})
        binding_map = internal.get("notification_channel_bindings", {})
        existing = binding_map.get(str(channel_id), {})

        updated = {
            "bind_private": (
                bind_private
                if bind_private is not None
                else existing.get("bind_private", True)
            ),
            "bind_group": (
                bind_group
                if bind_group is not None
                else existing.get("bind_group", False)
            ),
            "group_conversation_id": (
                group_conversation_id
                if group_conversation_id is not None
                else existing.get("group_conversation_id")
            ),
            "group_name": (
                group_name if group_name is not None else existing.get("group_name")
            ),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        binding_map[str(channel_id)] = updated
        internal["notification_channel_bindings"] = binding_map
        json_data["_internal"] = internal
        subscription.json = json_data
        subscription.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
        db.refresh(subscription)
        logger.info(
            "[SubscriptionNotification] Upserted channel binding: subscription_id=%s, user_id=%s, channel_id=%s, bind_private=%s, bind_group=%s, group_conversation_id=%s, group_name=%s",
            subscription.id,
            subscription.user_id,
            channel_id,
            updated["bind_private"],
            updated["bind_group"],
            updated["group_conversation_id"],
            updated["group_name"],
        )
        return updated

    def start_developer_binding_session(
        self,
        db: Session,
        *,
        user_id: int,
        channel_id: int,
        bind_private: bool,
        bind_group: bool,
        subscription_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not bind_private and not bind_group:
            raise ValueError("At least one binding target is required")

        # Subscription ownership check is optional (only when subscription_id is provided)
        if subscription_id is not None:
            self._get_subscription_for_owner(
                db, subscription_id=subscription_id, user_id=user_id
            )

        payload: Dict[str, Any] = {
            "user_id": user_id,
            "channel_id": channel_id,
            "bind_private": bind_private,
            "bind_group": bind_group,
            "private_bound": False,
            "group_bound": False,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        # Include subscription_id in payload if provided
        if subscription_id is not None:
            payload["subscription_id"] = subscription_id

        key = self._get_binding_pending_key(user_id=user_id, channel_id=channel_id)
        index_key = self._get_binding_pending_index_key(user_id=user_id)
        redis_client = self._get_redis_client()
        try:
            redis_client.setex(key, BINDING_PENDING_TTL_SECONDS, json.dumps(payload))
            redis_client.setex(index_key, BINDING_PENDING_TTL_SECONDS, key)
            logger.info(
                "[SubscriptionNotification] Started binding session: key=%s, index_key=%s, ttl=%ss, bind_private=%s, bind_group=%s, subscription_id=%s",
                key,
                index_key,
                BINDING_PENDING_TTL_SECONDS,
                bind_private,
                bind_group,
                subscription_id,
            )
        finally:
            redis_client.close()
        result: Dict[str, Any] = {
            "status": "waiting",
            "channel_id": channel_id,
            "bind_private": bind_private,
            "bind_group": bind_group,
        }
        if subscription_id is not None:
            result["subscription_id"] = subscription_id
        return result

    def cancel_developer_binding_session(
        self,
        db: Session,
        *,
        user_id: int,
        channel_id: int,
        subscription_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        # Subscription ownership check is optional (only when subscription_id is provided)
        if subscription_id is not None:
            self._get_subscription_for_owner(
                db, subscription_id=subscription_id, user_id=user_id
            )
        key = self._get_binding_pending_key(user_id=user_id, channel_id=channel_id)
        index_key = self._get_binding_pending_index_key(user_id=user_id)
        redis_client = self._get_redis_client()
        try:
            deleted = redis_client.delete(key)
            index_value = redis_client.get(index_key)
            if index_value == key:
                redis_client.delete(index_key)
            logger.info(
                "[SubscriptionNotification] Cancelled binding session: key=%s, index_key=%s, deleted=%s, subscription_id=%s",
                key,
                index_key,
                deleted,
                subscription_id,
            )
        finally:
            redis_client.close()
        result: Dict[str, Any] = {
            "status": "cancelled",
            "channel_id": channel_id,
        }
        if subscription_id is not None:
            result["subscription_id"] = subscription_id
        return result

    def handle_dingtalk_binding_from_message(
        self,
        db: Session,
        *,
        user_id: int,
        channel_id: int,
        conversation_type: str,
        conversation_id: str,
        sender_id: str,
        sender_staff_id: Optional[str],
        group_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        index_key = self._get_binding_pending_index_key(user_id=user_id)
        redis_client = self._get_redis_client()
        try:
            logger.info(
                "[SubscriptionNotification] Checking DingTalk binding from message: user_id=%s, channel_id=%s, conversation_type=%s, conversation_id=%s, sender_id=%s",
                user_id,
                channel_id,
                conversation_type,
                conversation_id,
                sender_id,
            )
            matched_key = redis_client.get(index_key)
            if not matched_key:
                logger.info(
                    "[SubscriptionNotification] No pending binding session found: index_key=%s",
                    index_key,
                )
                return {"matched": False, "completed": False}

            raw = redis_client.get(matched_key)
            if not raw:
                logger.warning(
                    "[SubscriptionNotification] Pending key from index missing payload: index_key=%s, key=%s",
                    index_key,
                    matched_key,
                )
                redis_client.delete(index_key)
                return {"matched": False, "completed": False}
            pending = json.loads(raw)
            logger.info(
                "[SubscriptionNotification] Matched pending session: key=%s, subscription_id=%s, bind_private=%s, bind_group=%s, private_bound=%s, group_bound=%s",
                matched_key,
                pending.get("subscription_id"),
                pending.get("bind_private"),
                pending.get("bind_group"),
                pending.get("private_bound"),
                pending.get("group_bound"),
            )

            bind_private = bool(pending.get("bind_private", False))
            bind_group = bool(pending.get("bind_group", False))
            private_bound = bool(pending.get("private_bound", False))
            group_bound = bool(pending.get("group_bound", False))
            changed = False

            if bind_private and not private_bound:
                logger.info(
                    "[SubscriptionNotification] Completing private binding from message: user_id=%s, channel_id=%s",
                    user_id,
                    channel_id,
                )
                self.update_user_im_binding(
                    db=db,
                    user_id=user_id,
                    channel_id=channel_id,
                    channel_type="dingtalk",
                    sender_id=sender_id,
                    sender_staff_id=sender_staff_id,
                    conversation_id=conversation_id,
                )
                private_bound = True
                changed = True

            if (
                bind_group
                and not group_bound
                and conversation_type == "group"
                and conversation_id
            ):
                # Use provided group name or default placeholder
                resolved_group_name = group_name or "Group Chat"
                logger.info(
                    "[SubscriptionNotification] Group binding detected from message: channel_id=%s, conversation_id=%s, group_name=%s",
                    channel_id,
                    conversation_id,
                    resolved_group_name,
                )
                # Emit WebSocket event with group info instead of auto-updating subscription
                emit_subscription_group_info(
                    user_id=user_id,
                    channel_id=channel_id,
                    group_name=resolved_group_name,
                    group_conversation_id=conversation_id,
                )
                logger.info(
                    "[SubscriptionNotification] Emitted group info event: user_id=%s, channel_id=%s, group_conversation_id=%s",
                    user_id,
                    channel_id,
                    conversation_id,
                )
                group_bound = True
                changed = True

            if not changed:
                logger.info(
                    "[SubscriptionNotification] Pending session matched but no binding state changed: key=%s, conversation_type=%s, conversation_id=%s",
                    matched_key,
                    conversation_type,
                    conversation_id,
                )
                return {"matched": True, "completed": False}

            pending["private_bound"] = private_bound
            pending["group_bound"] = group_bound
            completed = (not bind_private or private_bound) and (
                not bind_group or group_bound
            )
            if completed:
                redis_client.delete(matched_key)
                redis_client.delete(index_key)
                logger.info(
                    "[SubscriptionNotification] Binding session completed and cleared: key=%s, index_key=%s",
                    matched_key,
                    index_key,
                )
            else:
                redis_client.setex(
                    matched_key,
                    BINDING_PENDING_TTL_SECONDS,
                    json.dumps(pending),
                )
                redis_client.setex(index_key, BINDING_PENDING_TTL_SECONDS, matched_key)
                logger.info(
                    "[SubscriptionNotification] Binding session partially completed and refreshed: key=%s, index_key=%s, ttl=%ss, private_bound=%s, group_bound=%s",
                    matched_key,
                    index_key,
                    BINDING_PENDING_TTL_SECONDS,
                    private_bound,
                    group_bound,
                )

            payload: Dict[str, Any] = {
                "channel_id": channel_id,
                "conversation_id": conversation_id if group_bound else None,
                "private_bound": private_bound,
                "group_bound": group_bound,
                "completed": completed,
                "status": "success" if completed else "partial",
            }
            # Include subscription_id in payload if it exists
            pending_subscription_id = pending.get("subscription_id")
            if pending_subscription_id is not None:
                payload["subscription_id"] = int(pending_subscription_id)
            emit_subscription_binding_update(user_id=user_id, payload=payload)
            logger.info(
                "[SubscriptionNotification] Emitted binding update event: user_id=%s, payload=%s",
                user_id,
                payload,
            )
            return {
                "matched": True,
                "completed": completed,
                "private_bound": private_bound,
                "group_bound": group_bound,
            }
        finally:
            redis_client.close()

    async def notify_execution_completed(
        self,
        db: Session,
        *,
        user_id: int,
        subscription: Any,
        execution: Any,
    ) -> Dict[str, Any]:
        """
        Notify followers that a subscription execution has completed.

        This method is called when a subscription-triggered task completes,
        dispatching notifications to followers based on their notification settings.

        Args:
            db: Database session
            user_id: User ID who owns the subscription
            subscription: Subscription CRD object
            execution: BackgroundExecution object

        Returns:
            Dict with notification dispatch results
        """
        from app.core.config import settings
        from app.schemas.subscription import BackgroundExecutionStatus
        from app.services.subscription.notification_dispatcher import (
            subscription_notification_dispatcher,
        )

        # Generate detail URL for the execution
        # Link to the subscription detail page
        base_url = getattr(settings, "TASK_SHARE_BASE_URL", "http://localhost:3000")
        subscription_id = execution.subscription_id
        execution_id = execution.id
        task_id = execution.task_id

        # Build detail URL - link to subscription page with execution and task info
        # Frontend can use these parameters to show the specific execution
        detail_url = f"{base_url}/feed/subscriptions/{subscription_id}?execution={execution_id}&task={task_id}"

        logger.info(
            f"[notify_execution_completed] Generated detail_url: {detail_url}, "
            f"base_url: {base_url}, subscription_id: {subscription_id}, "
            f"execution_id: {execution_id}, task_id: {task_id}"
        )

        # Map execution status to string
        status_map = {
            BackgroundExecutionStatus.COMPLETED.value: "COMPLETED",
            BackgroundExecutionStatus.COMPLETED_SILENT.value: "COMPLETED",
            BackgroundExecutionStatus.FAILED.value: "FAILED",
            BackgroundExecutionStatus.CANCELLED.value: "CANCELLED",
        }
        status = status_map.get(execution.status, execution.status)

        # Get subscription display name
        subscription_display_name = (
            subscription.spec.displayName
            if subscription and subscription.spec
            else "Unknown"
        )

        # Dispatch notifications
        result = (
            await subscription_notification_dispatcher.dispatch_execution_notifications(
                db=db,
                subscription_id=subscription_id,
                execution_id=execution_id,
                subscription_display_name=subscription_display_name,
                result_summary=execution.result_summary or "",
                status=status,
                detail_url=detail_url,
            )
        )

        logger.info(
            f"[notify_execution_completed] Dispatched notifications for "
            f"subscription {subscription_id}, execution {execution_id}: {result}"
        )

        return result


# Singleton instance
subscription_notification_service = SubscriptionNotificationService()

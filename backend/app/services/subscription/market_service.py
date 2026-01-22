# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Subscription Market service for browsing and renting market subscriptions.

This module provides the SubscriptionMarketService class for:
- Browsing market subscriptions (visibility=market)
- Renting market subscriptions
- Managing user's rental subscriptions
"""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException
from sqlalchemy import desc, func
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.models.user import User
from app.schemas.subscription import (
    MarketSubscriptionDetail,
    RentalCountResponse,
    RentalSubscriptionResponse,
    RentSubscriptionRequest,
    Subscription,
    SubscriptionTriggerType,
    SubscriptionVisibility,
)
from app.services.subscription.helpers import (
    build_trigger_config,
    calculate_next_execution_time,
    extract_trigger_config,
)

logger = logging.getLogger(__name__)


def _get_trigger_description(
    trigger_type: SubscriptionTriggerType,
    trigger_config: Dict[str, Any],
) -> str:
    """Generate a human-readable trigger description."""
    if trigger_type == SubscriptionTriggerType.CRON:
        expression = trigger_config.get("expression", "")
        timezone_str = trigger_config.get("timezone", "UTC")
        return f"Cron: {expression} ({timezone_str})"
    elif trigger_type == SubscriptionTriggerType.INTERVAL:
        value = trigger_config.get("value", 1)
        unit = trigger_config.get("unit", "hours")
        return f"Every {value} {unit}"
    elif trigger_type == SubscriptionTriggerType.ONE_TIME:
        execute_at = trigger_config.get("execute_at", "")
        return f"One time at {execute_at}"
    elif trigger_type == SubscriptionTriggerType.EVENT:
        event_type = trigger_config.get("event_type", "webhook")
        return f"Event: {event_type}"
    return "Unknown trigger"


class SubscriptionMarketService:
    """Service class for Subscription Market operations."""

    def discover_market_subscriptions(
        self,
        db: Session,
        *,
        user_id: int,
        sort_by: str = "rental_count",
        search: Optional[str] = None,
        skip: int = 0,
        limit: int = 20,
    ) -> Tuple[List[MarketSubscriptionDetail], int]:
        """
        Discover market subscriptions (visibility=market).

        Args:
            db: Database session
            user_id: Current user ID
            sort_by: Sort by 'rental_count' or 'recent'
            search: Optional search query for name/description
            skip: Pagination offset
            limit: Pagination limit

        Returns:
            Tuple of (list of MarketSubscriptionDetail, total count)
        """
        # Query all active subscriptions
        query = db.query(Kind).filter(
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )

        subscriptions = query.all()

        # Filter for market visibility subscriptions
        market_subscriptions = []
        for sub in subscriptions:
            subscription_crd = Subscription.model_validate(sub.json)
            visibility = getattr(
                subscription_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
            )
            if visibility == SubscriptionVisibility.MARKET:
                market_subscriptions.append(sub)

        # Apply search filter
        if search:
            search_lower = search.lower()
            filtered = []
            for sub in market_subscriptions:
                subscription_crd = Subscription.model_validate(sub.json)
                display_name = subscription_crd.spec.displayName.lower()
                description = (subscription_crd.spec.description or "").lower()
                if search_lower in display_name or search_lower in description:
                    filtered.append(sub)
            market_subscriptions = filtered

        # Get user's rented subscriptions for is_rented check
        rented_source_ids = self._get_user_rented_source_ids(db, user_id)

        # Convert to response and collect rental counts
        result_items = []
        for sub in market_subscriptions:
            subscription_crd = Subscription.model_validate(sub.json)
            internal = sub.json.get("_internal", {})

            # Get owner username
            owner = db.query(User).filter(User.id == sub.user_id).first()
            owner_username = owner.user_name if owner else "Unknown"

            trigger_type = SubscriptionTriggerType(internal.get("trigger_type", "cron"))
            trigger_config = extract_trigger_config(subscription_crd.spec.trigger)

            result_items.append(
                MarketSubscriptionDetail(
                    id=sub.id,
                    name=sub.name,
                    display_name=subscription_crd.spec.displayName,
                    description=subscription_crd.spec.description,
                    task_type=subscription_crd.spec.taskType,
                    trigger_type=trigger_type,
                    trigger_description=_get_trigger_description(
                        trigger_type, trigger_config
                    ),
                    owner_user_id=sub.user_id,
                    owner_username=owner_username,
                    rental_count=internal.get("rental_count", 0),
                    is_rented=sub.id in rented_source_ids,
                    created_at=sub.created_at,
                    updated_at=sub.updated_at,
                )
            )

        # Sort
        if sort_by == "rental_count":
            result_items.sort(key=lambda x: x.rental_count, reverse=True)
        else:  # recent
            result_items.sort(key=lambda x: x.updated_at, reverse=True)

        total = len(result_items)

        # Apply pagination
        result_items = result_items[skip : skip + limit]

        return result_items, total

    def get_market_subscription_detail(
        self,
        db: Session,
        *,
        subscription_id: int,
        user_id: int,
    ) -> MarketSubscriptionDetail:
        """
        Get market subscription detail (hides sensitive information).

        Args:
            db: Database session
            subscription_id: Subscription ID
            user_id: Current user ID

        Returns:
            MarketSubscriptionDetail

        Raises:
            HTTPException: If subscription not found or not market visibility
        """
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
            raise HTTPException(status_code=404, detail="Subscription not found")

        subscription_crd = Subscription.model_validate(subscription.json)
        visibility = getattr(
            subscription_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
        )

        if visibility != SubscriptionVisibility.MARKET:
            raise HTTPException(
                status_code=404, detail="Subscription not found in market"
            )

        internal = subscription.json.get("_internal", {})

        # Get owner username
        owner = db.query(User).filter(User.id == subscription.user_id).first()
        owner_username = owner.user_name if owner else "Unknown"

        # Check if user has rented this subscription
        rented_source_ids = self._get_user_rented_source_ids(db, user_id)

        trigger_type = SubscriptionTriggerType(internal.get("trigger_type", "cron"))
        trigger_config = extract_trigger_config(subscription_crd.spec.trigger)

        return MarketSubscriptionDetail(
            id=subscription.id,
            name=subscription.name,
            display_name=subscription_crd.spec.displayName,
            description=subscription_crd.spec.description,
            task_type=subscription_crd.spec.taskType,
            trigger_type=trigger_type,
            trigger_description=_get_trigger_description(trigger_type, trigger_config),
            owner_user_id=subscription.user_id,
            owner_username=owner_username,
            rental_count=internal.get("rental_count", 0),
            is_rented=subscription.id in rented_source_ids,
            created_at=subscription.created_at,
            updated_at=subscription.updated_at,
        )

    def rent_subscription(
        self,
        db: Session,
        *,
        source_subscription_id: int,
        renter_user_id: int,
        request: RentSubscriptionRequest,
    ) -> RentalSubscriptionResponse:
        """
        Rent a market subscription.

        Creates a new subscription with sourceSubscriptionRef pointing to the
        source subscription. The rental subscription only stores trigger config
        and optional model_ref; team/prompt/workspace are read from source at
        execution time.

        Args:
            db: Database session
            source_subscription_id: Source subscription ID to rent
            renter_user_id: Renter user ID
            request: Rental configuration

        Returns:
            RentalSubscriptionResponse

        Raises:
            HTTPException: If validation fails
        """
        # Validate source subscription exists and is market visibility
        source = (
            db.query(Kind)
            .filter(
                Kind.id == source_subscription_id,
                Kind.kind == "Subscription",
                Kind.is_active == True,
            )
            .first()
        )

        if not source:
            raise HTTPException(status_code=404, detail="Source subscription not found")

        source_crd = Subscription.model_validate(source.json)
        visibility = getattr(
            source_crd.spec, "visibility", SubscriptionVisibility.PRIVATE
        )

        if visibility != SubscriptionVisibility.MARKET:
            raise HTTPException(
                status_code=400, detail="Source subscription is not available in market"
            )

        # Prevent users from renting their own subscriptions
        if source.user_id == renter_user_id:
            raise HTTPException(
                status_code=400, detail="Cannot rent your own subscription"
            )

        # Check if user already rented this subscription
        existing_rental = self._get_user_rental_for_source(
            db, renter_user_id, source_subscription_id
        )
        if existing_rental:
            raise HTTPException(
                status_code=400, detail="You have already rented this subscription"
            )

        # Validate rental subscription name uniqueness
        existing = (
            db.query(Kind)
            .filter(
                Kind.user_id == renter_user_id,
                Kind.kind == "Subscription",
                Kind.name == request.name,
                Kind.namespace == "default",
                Kind.is_active == True,
            )
            .first()
        )

        if existing:
            raise HTTPException(
                status_code=400,
                detail=f"Subscription with name '{request.name}' already exists",
            )

        # Get source owner username
        source_owner = db.query(User).filter(User.id == source.user_id).first()
        source_owner_username = source_owner.user_name if source_owner else "Unknown"

        # Build trigger config
        trigger = build_trigger_config(request.trigger_type, request.trigger_config)

        # Calculate next execution time
        next_execution_time = calculate_next_execution_time(
            request.trigger_type, request.trigger_config
        )
        if next_execution_time is None:
            next_execution_time = datetime.now(timezone.utc).replace(tzinfo=None)

        # Build model_ref if provided
        from app.schemas.kind import ModelRef

        model_ref = None
        if request.model_ref:
            model_ref = ModelRef(
                name=request.model_ref.get("name", ""),
                namespace=request.model_ref.get("namespace", "default"),
            )

        # Build rental subscription CRD JSON
        # Note: teamRef, promptTemplate, workspaceRef are NOT stored in rental
        # They are read from source subscription at execution time
        from app.schemas.subscription import (
            SourceSubscriptionRef,
            SubscriptionMetadata,
            SubscriptionSpec,
            SubscriptionStatus,
            SubscriptionTaskType,
            SubscriptionTeamRef,
        )

        spec = SubscriptionSpec(
            displayName=request.display_name,
            taskType=source_crd.spec.taskType,  # Copy task type from source
            visibility=SubscriptionVisibility.PRIVATE,  # Rentals are always private
            trigger=trigger,
            teamRef=SubscriptionTeamRef(
                name="__rental_placeholder__", namespace="default"
            ),  # Placeholder
            promptTemplate="__rental_placeholder__",  # Placeholder
            enabled=True,
            description=f"Rental of: {source_crd.spec.displayName}",
            sourceSubscriptionRef=SourceSubscriptionRef(
                id=source.id,
                name=source.name,
                namespace=source.namespace,
            ),
            modelRef=model_ref,
        )

        rental_crd = Subscription(
            metadata=SubscriptionMetadata(
                name=request.name,
                namespace="default",
                displayName=request.display_name,
            ),
            spec=spec,
            status=SubscriptionStatus(),
        )

        crd_json = rental_crd.model_dump(mode="json")
        crd_json["_internal"] = {
            "team_id": 0,  # Not used for rentals
            "workspace_id": 0,  # Not used for rentals
            "webhook_token": "",
            "webhook_secret": "",
            "enabled": True,
            "trigger_type": request.trigger_type.value,
            "next_execution_time": (
                next_execution_time.isoformat() if next_execution_time else None
            ),
            "last_execution_time": None,
            "last_execution_status": "",
            "execution_count": 0,
            "success_count": 0,
            "failure_count": 0,
            "bound_task_id": 0,
            # Rental-specific fields
            "is_rental": True,
            "source_subscription_id": source.id,
            "source_subscription_name": source.name,
            "source_subscription_display_name": source_crd.spec.displayName,
            "source_owner_username": source_owner_username,
        }

        # Create rental subscription
        rental = Kind(
            user_id=renter_user_id,
            kind="Subscription",
            name=request.name,
            namespace="default",
            json=crd_json,
            is_active=True,
        )
        db.add(rental)

        # Increment rental count on source subscription
        source_internal = source.json.get("_internal", {})
        source_internal["rental_count"] = source_internal.get("rental_count", 0) + 1
        source.json["_internal"] = source_internal
        flag_modified(source, "json")

        db.commit()
        db.refresh(rental)

        return RentalSubscriptionResponse(
            id=rental.id,
            name=rental.name,
            display_name=request.display_name,
            namespace="default",
            source_subscription_id=source.id,
            source_subscription_name=source.name,
            source_subscription_display_name=source_crd.spec.displayName,
            source_owner_user_id=source.user_id,
            source_owner_username=source_owner_username,
            trigger_type=request.trigger_type,
            trigger_config=request.trigger_config,
            model_ref=request.model_ref,
            enabled=True,
            last_execution_time=None,
            last_execution_status=None,
            next_execution_time=next_execution_time,
            execution_count=0,
            created_at=rental.created_at,
            updated_at=rental.updated_at,
        )

    def get_user_rentals(
        self,
        db: Session,
        *,
        user_id: int,
        skip: int = 0,
        limit: int = 20,
    ) -> Tuple[List[RentalSubscriptionResponse], int]:
        """
        Get user's rental subscriptions.

        Args:
            db: Database session
            user_id: User ID
            skip: Pagination offset
            limit: Pagination limit

        Returns:
            Tuple of (list of RentalSubscriptionResponse, total count)
        """
        # Query all active subscriptions for the user
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )

        subscriptions = query.all()

        # Filter for rental subscriptions
        rentals = []
        for sub in subscriptions:
            internal = sub.json.get("_internal", {})
            if internal.get("is_rental", False):
                rentals.append(sub)

        total = len(rentals)

        # Sort by updated_at desc
        rentals.sort(key=lambda x: x.updated_at, reverse=True)

        # Apply pagination
        rentals = rentals[skip : skip + limit]

        # Convert to response
        result = []
        for rental in rentals:
            rental_crd = Subscription.model_validate(rental.json)
            internal = rental.json.get("_internal", {})

            # Parse execution times
            next_execution_time = None
            if internal.get("next_execution_time"):
                try:
                    next_execution_time = datetime.fromisoformat(
                        internal["next_execution_time"]
                    )
                except (ValueError, TypeError):
                    pass

            last_execution_time = None
            if internal.get("last_execution_time"):
                try:
                    last_execution_time = datetime.fromisoformat(
                        internal["last_execution_time"]
                    )
                except (ValueError, TypeError):
                    pass

            # Get model_ref
            model_ref = None
            if rental_crd.spec.modelRef:
                model_ref = {
                    "name": rental_crd.spec.modelRef.name,
                    "namespace": rental_crd.spec.modelRef.namespace,
                }

            # Get source owner info
            source_id = internal.get("source_subscription_id")
            source_owner_user_id = 0
            if source_id:
                source_sub = db.query(Kind).filter(Kind.id == source_id).first()
                if source_sub:
                    source_owner_user_id = source_sub.user_id

            result.append(
                RentalSubscriptionResponse(
                    id=rental.id,
                    name=rental.name,
                    display_name=rental_crd.spec.displayName,
                    namespace=rental.namespace,
                    source_subscription_id=internal.get("source_subscription_id", 0),
                    source_subscription_name=internal.get(
                        "source_subscription_name", ""
                    ),
                    source_subscription_display_name=internal.get(
                        "source_subscription_display_name", ""
                    ),
                    source_owner_user_id=source_owner_user_id,
                    source_owner_username=internal.get("source_owner_username", ""),
                    trigger_type=SubscriptionTriggerType(
                        internal.get("trigger_type", "cron")
                    ),
                    trigger_config=extract_trigger_config(rental_crd.spec.trigger),
                    model_ref=model_ref,
                    enabled=internal.get("enabled", True),
                    last_execution_time=last_execution_time,
                    last_execution_status=internal.get("last_execution_status"),
                    next_execution_time=next_execution_time,
                    execution_count=internal.get("execution_count", 0),
                    created_at=rental.created_at,
                    updated_at=rental.updated_at,
                )
            )

        return result, total

    def get_rental_count(
        self,
        db: Session,
        *,
        subscription_id: int,
    ) -> RentalCountResponse:
        """
        Get rental count for a market subscription.

        Args:
            db: Database session
            subscription_id: Subscription ID

        Returns:
            RentalCountResponse

        Raises:
            HTTPException: If subscription not found
        """
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
            raise HTTPException(status_code=404, detail="Subscription not found")

        internal = subscription.json.get("_internal", {})

        return RentalCountResponse(
            subscription_id=subscription.id,
            rental_count=internal.get("rental_count", 0),
        )

    def _get_user_rented_source_ids(self, db: Session, user_id: int) -> set:
        """Get set of source subscription IDs that user has rented."""
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )

        source_ids = set()
        for sub in query.all():
            internal = sub.json.get("_internal", {})
            if internal.get("is_rental", False):
                source_id = internal.get("source_subscription_id")
                if source_id:
                    source_ids.add(source_id)

        return source_ids

    def _get_user_rental_for_source(
        self, db: Session, user_id: int, source_subscription_id: int
    ) -> Optional[Kind]:
        """Get user's rental subscription for a specific source."""
        query = db.query(Kind).filter(
            Kind.user_id == user_id,
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )

        for sub in query.all():
            internal = sub.json.get("_internal", {})
            if (
                internal.get("is_rental", False)
                and internal.get("source_subscription_id") == source_subscription_id
            ):
                return sub

        return None


# Singleton instance
subscription_market_service = SubscriptionMarketService()

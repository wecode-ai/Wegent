# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrator marketplace curation endpoints."""

from copy import deepcopy

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.marketplace_resource import MarketplaceResource
from app.models.smart_app_marketplace import SmartApp
from app.models.user import User
from app.schemas.admin_marketplace import (
    AdminMarketplaceResource,
    AdminMarketplaceResourceList,
    AdminMarketplaceResourceUpdate,
    AdminMarketplaceSmartApp,
    AdminMarketplaceSmartAppList,
    AdminMarketplaceSmartAppUpdate,
)
from app.services.resource_library_service import (
    _marketplace_config,
    _marketplace_recommendation_score,
)
from shared.telemetry.decorators import trace_async

router = APIRouter()

KIND_BY_RESOURCE_TYPE = {
    "agent": "Team",
    "skill": "Skill",
}


def _resource_metadata(resource: Kind) -> tuple[str, str | None]:
    payload = resource.json if isinstance(resource.json, dict) else {}
    metadata = payload.get("metadata", {})
    spec = payload.get("spec", {})
    capability = spec.get("capability", {})
    metadata = metadata if isinstance(metadata, dict) else {}
    spec = spec if isinstance(spec, dict) else {}
    capability = capability if isinstance(capability, dict) else {}

    if resource.user_id == 0:
        display_name = (
            spec.get("displayName")
            if resource.kind == "Skill"
            else metadata.get("displayName")
        )
        description = spec.get("description")
    else:
        display_name = capability.get("displayName")
        description = capability.get("description")

    return str(display_name or resource.name), (
        str(description) if description is not None else None
    )


def _mutable_marketplace_config(resource: Kind) -> dict:
    payload = deepcopy(resource.json) if isinstance(resource.json, dict) else {}
    spec = payload.setdefault("spec", {})
    if not isinstance(spec, dict):
        spec = {}
        payload["spec"] = spec
    capability = spec.setdefault("capability", {})
    if not isinstance(capability, dict):
        capability = {}
        spec["capability"] = capability
    marketplace = capability.setdefault("marketplace", {})
    if not isinstance(marketplace, dict):
        marketplace = {}
        capability["marketplace"] = marketplace
    resource.json = payload
    flag_modified(resource, "json")
    return marketplace


def _to_response(
    resource: Kind,
    publisher_user_name: str | None,
    published_recommendation_score: int | None,
) -> AdminMarketplaceResource:
    display_name, description = _resource_metadata(resource)
    marketplace = _marketplace_config(resource)
    return AdminMarketplaceResource(
        id=resource.id,
        resource_type="agent" if resource.kind == "Team" else "skill",
        name=resource.name,
        display_name=display_name,
        description=description,
        publisher_user_name=publisher_user_name,
        is_system=resource.user_id == 0,
        recommendation_score=(
            _marketplace_recommendation_score(resource)
            if resource.user_id == 0
            else int(published_recommendation_score or 0)
        ),
        example_conversations=(
            marketplace.get("exampleConversations", [])
            if resource.kind == "Team"
            else []
        ),
    )


def _smart_app_response(
    app: SmartApp, publisher_user_name: str | None
) -> AdminMarketplaceSmartApp:
    return AdminMarketplaceSmartApp(
        id=app.id,
        name=app.name,
        display_name=app.display_name,
        summary=app.summary,
        publisher_user_name=publisher_user_name,
        is_system=app.owner_user_id == 0,
        featured_rank=app.featured_rank,
    )


@router.get(
    "/marketplace-resources",
    response_model=AdminMarketplaceResourceList,
)
@trace_async()
async def list_marketplace_resources(
    resource_type: str = Query(pattern="^(agent|skill)$"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplaceResourceList:
    """List resources currently visible in the Agent or Skill marketplace."""
    kind = KIND_BY_RESOURCE_TYPE[resource_type]
    system_rows = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == kind,
            Kind.is_active == True,
        )
        .all()
    )
    published_rows = (
        db.query(
            Kind,
            User.user_name,
            MarketplaceResource.recommendation_score,
        )
        .select_from(MarketplaceResource)
        .join(Kind, Kind.id == MarketplaceResource.kind_id)
        .outerjoin(User, User.id == Kind.user_id)
        .filter(
            Kind.user_id != 0,
            Kind.kind == kind,
            Kind.is_active == True,
            MarketplaceResource.resource_type == resource_type,
        )
        .all()
    )
    items_with_sort = [
        *[
            (_to_response(resource, None, None), resource.updated_at)
            for resource in system_rows
        ],
        *[
            (_to_response(resource, user_name, score), resource.updated_at)
            for resource, user_name, score in published_rows
        ],
    ]
    items_with_sort.sort(
        key=lambda row: (
            row[0].recommendation_score,
            row[1],
            row[0].id,
        ),
        reverse=True,
    )
    total = len(items_with_sort)
    start = (page - 1) * limit
    return AdminMarketplaceResourceList(
        items=[item for item, _ in items_with_sort[start : start + limit]],
        total=total,
        page=page,
        limit=limit,
    )


@router.put(
    "/marketplace-resources/{resource_id}",
    response_model=AdminMarketplaceResource,
)
@trace_async()
async def update_marketplace_resource(
    update: AdminMarketplaceResourceUpdate,
    resource_id: int = Path(gt=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplaceResource:
    """Update marketplace curation metadata for one resource."""
    resource = (
        db.query(Kind)
        .filter(
            Kind.id == resource_id,
            Kind.kind.in_(KIND_BY_RESOURCE_TYPE.values()),
            Kind.is_active == True,
        )
        .first()
    )
    publication = (
        None
        if resource is None or resource.user_id == 0
        else db.get(MarketplaceResource, resource.id)
    )
    if resource is None or (resource.user_id != 0 and publication is None):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Marketplace resource not found",
        )

    publisher = db.get(User, resource.user_id)
    publisher_user_name = publisher.user_name if publisher is not None else None
    marketplace = None
    if (
        "recommendation_score" in update.model_fields_set
        and update.recommendation_score is not None
    ):
        if resource.user_id == 0:
            marketplace = _mutable_marketplace_config(resource)
            marketplace["recommendationScore"] = update.recommendation_score
        else:
            publication.recommendation_score = update.recommendation_score
    if "example_conversations" in update.model_fields_set:
        if resource.kind != "Team" and update.example_conversations:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Example conversations are only supported for Agents",
            )
        if resource.user_id != 0:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Example conversations are managed by the publisher",
            )
        marketplace = marketplace or _mutable_marketplace_config(resource)
        marketplace["exampleConversations"] = [
            item.model_dump() for item in update.example_conversations or []
        ]
    db.commit()
    db.refresh(resource)
    if publication is not None:
        db.refresh(publication)
    return _to_response(
        resource,
        publisher_user_name,
        publication.recommendation_score if publication is not None else None,
    )


@router.get(
    "/marketplace-smart-apps",
    response_model=AdminMarketplaceSmartAppList,
)
@trace_async()
async def list_marketplace_smart_apps(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplaceSmartAppList:
    """List official and user-published Smart apps visible to everyone."""
    rows = (
        db.query(SmartApp, User.user_name)
        .outerjoin(User, User.id == SmartApp.owner_user_id)
        .filter(
            SmartApp.status == "published",
            SmartApp.visibility == "public",
        )
        .all()
    )
    rows.sort(
        key=lambda row: (
            row[0].featured_rank,
            row[0].source_type == "official",
            row[0].updated_at,
            row[0].id,
        ),
        reverse=True,
    )
    total = len(rows)
    start = (page - 1) * limit
    return AdminMarketplaceSmartAppList(
        items=[
            _smart_app_response(app, publisher_user_name)
            for app, publisher_user_name in rows[start : start + limit]
        ],
        total=total,
        page=page,
        limit=limit,
    )


@router.put(
    "/marketplace-smart-apps/{smart_app_id}",
    response_model=AdminMarketplaceSmartApp,
)
@trace_async()
async def update_marketplace_smart_app(
    update: AdminMarketplaceSmartAppUpdate,
    smart_app_id: int = Path(gt=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplaceSmartApp:
    """Set the featured priority for one public Smart app."""
    app = (
        db.query(SmartApp)
        .filter(
            SmartApp.id == smart_app_id,
            SmartApp.status == "published",
            SmartApp.visibility == "public",
        )
        .first()
    )
    if app is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Marketplace Smart app not found",
        )
    app.featured_rank = update.featured_rank
    db.commit()
    db.refresh(app)
    publisher = db.get(User, app.owner_user_id) if app.owner_user_id else None
    return _smart_app_response(app, publisher.user_name if publisher else None)

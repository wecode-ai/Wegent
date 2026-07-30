# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability Center marketplace endpoints."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from app.schemas.resource_library import (
    ResourceLibraryAgentBindings,
    ResourceLibraryAgentBindingsUpdateRequest,
    ResourceLibraryCreateListingRequest,
    ResourceLibraryDiscoveryList,
    ResourceLibraryInstall,
    ResourceLibraryInstallList,
    ResourceLibraryInstallRequest,
    ResourceLibraryListing,
    ResourceLibraryListingList,
    ResourceLibraryPublicationUpdateRequest,
)
from app.services.resource_library_service import resource_library_service

router = APIRouter()


def _parse_tags(tags: str | None) -> list[str]:
    return [item.strip() for item in (tags or "").split(",") if item.strip()]


@router.get("/listings", response_model=ResourceLibraryDiscoveryList)
def list_resource_library(
    resource_type: str | None = Query(default=None, pattern="^(agent|skill)$"),
    keyword: str | None = Query(default=None, max_length=200),
    tags: str | None = Query(default=None),
    target_namespace: str = Query(default="default", min_length=1, max_length=100),
    cursor: str | None = Query(default=None, max_length=512),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List active public Team and Skill capabilities."""
    return resource_library_service.list_public(
        db,
        user_id=current_user.id,
        resource_type=resource_type,
        keyword=keyword,
        tags=_parse_tags(tags),
        target_namespace=target_namespace,
        cursor=cursor,
        limit=limit,
    )


@router.get("/listings/{listing_id}", response_model=ResourceLibraryListing)
def get_resource_library_listing(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get one public capability."""
    return resource_library_service.get_public_listing(
        db, listing_id=listing_id, user_id=current_user.id
    )


@router.get("/listings/{listing_id}/publication", response_model=ResourceLibraryListing)
def get_resource_library_publication(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get editable publication settings for an owned capability."""
    return resource_library_service.get_manageable_publication(
        db,
        listing_id=listing_id,
        current_user=current_user,
    )


@router.post("/listings", response_model=ResourceLibraryListing)
def publish_resource_library_listing(
    request: ResourceLibraryCreateListingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Publish an existing Team or Skill Kind."""
    return resource_library_service.publish(
        db, request=request, current_user=current_user
    )


@router.put("/listings/{listing_id}/publication", response_model=ResourceLibraryListing)
def update_resource_library_publication(
    listing_id: int,
    request: ResourceLibraryPublicationUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Update listing metadata, version, install rules, or status."""
    return resource_library_service.update_publication(
        db,
        listing_id=listing_id,
        request=request,
        current_user=current_user,
    )


@router.post("/listings/{listing_id}/archive", response_model=ResourceLibraryListing)
def archive_resource_library_listing(
    listing_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Archive a listing without removing existing installations."""
    return resource_library_service.update_publication(
        db,
        listing_id=listing_id,
        request=ResourceLibraryPublicationUpdateRequest(status="archived"),
        current_user=current_user,
    )


@router.post("/listings/{listing_id}/install", response_model=ResourceLibraryInstall)
def install_resource_library_listing(
    listing_id: int,
    request: ResourceLibraryInstallRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Idempotently add a capability to the user or a writable group."""
    return resource_library_service.install(
        db,
        listing_id=listing_id,
        target_namespace=request.target_namespace,
        current_user=current_user,
    )


@router.post("/agents/{agent_id}/bindings", response_model=ResourceLibraryInstall)
def bind_agent_to_scope(
    agent_id: int,
    request: ResourceLibraryInstallRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Publish an owned Agent to a personal or writable group scope by reference."""
    return resource_library_service.bind_agent(
        db,
        agent_id=agent_id,
        target_namespace=request.target_namespace,
        current_user=current_user,
    )


@router.get("/agents/{agent_id}/bindings", response_model=ResourceLibraryAgentBindings)
def get_agent_bindings(
    agent_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get all effective scopes that reference an owned Agent."""
    return resource_library_service.get_agent_bindings(
        db,
        agent_id=agent_id,
        current_user=current_user,
    )


@router.put("/agents/{agent_id}/bindings", response_model=ResourceLibraryAgentBindings)
def sync_agent_bindings(
    agent_id: int,
    request: ResourceLibraryAgentBindingsUpdateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Replace extra group references to an owned Agent."""
    return resource_library_service.sync_agent_bindings(
        db,
        agent_id=agent_id,
        group_names=request.group_names,
        current_user=current_user,
    )


@router.get("/users/me/published", response_model=ResourceLibraryListingList)
def list_my_resource_library_publications(
    resource_type: str | None = Query(default=None, pattern="^(agent|skill)$"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List current-user publications that the user can still manage."""
    return resource_library_service.list_published(
        db,
        current_user=current_user,
        resource_type=resource_type,
        page=page,
        limit=limit,
    )


@router.get("/users/me/installs", response_model=ResourceLibraryInstallList)
def list_my_resource_library_installs(
    resource_type: str | None = Query(default=None, pattern="^(agent|skill)$"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List personal managed agent installs and SkillBindings."""
    return resource_library_service.list_installs(
        db,
        current_user=current_user,
        resource_type=resource_type,
        page=page,
        limit=limit,
    )


@router.get(
    "/groups/{group_namespace}/installs", response_model=ResourceLibraryInstallList
)
def list_group_resource_library_installs(
    group_namespace: str,
    resource_type: str | None = Query(default=None, pattern="^(agent|skill)$"),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List capabilities installed into an accessible group."""
    return resource_library_service.list_group_installs(
        db,
        group_namespace=group_namespace,
        current_user=current_user,
        resource_type=resource_type,
        page=page,
        limit=limit,
    )

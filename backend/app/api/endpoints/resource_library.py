# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Capability Center marketplace endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core import security
from app.models.subtask_context import SubtaskContext
from app.models.user import User
from app.schemas.marketplace_tags import MarketplaceTagsResponse
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
    ResourceLibraryReferenceUsage,
)
from app.services.context import context_service
from app.services.marketplace_tag_service import marketplace_tag_service
from app.services.resource_library_service import resource_library_service

router = APIRouter()
PUBLIC_TEAM_ICON_ASSET_TYPE = "public_team_icon"


def _parse_tags(tags: str | None) -> list[str]:
    return [item.strip() for item in (tags or "").split(",") if item.strip()]


@router.get("/assets/team-icons/{asset_id}", include_in_schema=False)
def get_public_team_icon(
    asset_id: int,
    db: Session = Depends(get_db),
) -> Response:
    """Serve a public team icon from the configured attachment storage."""
    asset = db.get(SubtaskContext, asset_id)
    if (
        asset is None
        or (asset.type_data or {}).get("public_asset_type")
        != PUBLIC_TEAM_ICON_ASSET_TYPE
    ):
        raise HTTPException(status_code=404, detail="Team icon asset not found")
    content = context_service.get_attachment_binary_data(db, asset)
    if content is None:
        raise HTTPException(status_code=404, detail="Team icon asset not found")
    return Response(
        content=content,
        media_type=asset.mime_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/tags", response_model=MarketplaceTagsResponse)
def get_marketplace_tags(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Return the marketplace tag catalog for display and selection."""
    return marketplace_tag_service.get_config(db)


@router.get("/listings", response_model=ResourceLibraryDiscoveryList)
def list_resource_library(
    resource_type: str | None = Query(
        default=None, pattern="^(agent|skill|model|shell|retriever)$"
    ),
    system_only: bool = Query(default=False),
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
        system_only=system_only,
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


@router.get("/publications/source", response_model=ResourceLibraryListing)
def get_resource_library_publication_by_source(
    resource_type: str = Query(..., pattern="^(agent|skill|model|shell|retriever)$"),
    source_name: str = Query(..., min_length=1, max_length=100),
    source_namespace: str = Query(default="default", min_length=1, max_length=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Get sharing settings for an owned capability by source identity."""
    return resource_library_service.get_manageable_publication_by_source(
        db,
        resource_type=resource_type,
        source_name=source_name,
        source_namespace=source_namespace,
        current_user=current_user,
    )


@router.post("/listings", response_model=ResourceLibraryListing)
def publish_resource_library_listing(
    request: ResourceLibraryCreateListingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Set the sharing scope for an existing capability Kind."""
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


@router.delete(
    "/listings/{listing_id}/install",
    status_code=status.HTTP_204_NO_CONTENT,
)
def uninstall_resource_library_listing(
    listing_id: int,
    target_namespace: str = Query(default="default", min_length=1, max_length=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """Remove an Agent, model, executor, or retriever reference from a scope."""
    resource_library_service.uninstall_kind_reference(
        db,
        listing_id=listing_id,
        target_namespace=target_namespace,
        current_user=current_user,
    )


@router.get(
    "/listings/{listing_id}/install/usage",
    response_model=ResourceLibraryReferenceUsage,
)
def get_resource_library_reference_usage(
    listing_id: int,
    target_namespace: str = Query(default="default", min_length=1, max_length=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List active resources that prevent a capability reference from being unbound."""
    return resource_library_service.get_kind_reference_usage(
        db,
        listing_id=listing_id,
        target_namespace=target_namespace,
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
    resource_type: str | None = Query(
        default=None, pattern="^(agent|skill|model|shell|retriever)$"
    ),
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
    resource_type: str | None = Query(
        default=None, pattern="^(agent|skill|model|shell|retriever)$"
    ),
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


@router.get("/groups/installs", response_model=ResourceLibraryInstallList)
def list_group_resource_library_installs_batch(
    group_names: str = Query(..., min_length=1, max_length=10000),
    resource_type: str | None = Query(
        default=None, pattern="^(agent|skill|model|shell|retriever)$"
    ),
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user),
):
    """List capabilities installed into multiple accessible groups."""
    group_namespaces = list(
        dict.fromkeys(name.strip() for name in group_names.split(",") if name.strip())
    )
    if len(group_namespaces) > 100:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At most 100 groups can be queried at once",
        )
    return resource_library_service.list_group_installs_batch(
        db,
        group_namespaces=group_namespaces,
        current_user=current_user,
        resource_type=resource_type,
        page=page,
        limit=limit,
    )


@router.get(
    "/groups/{group_namespace:path}/installs", response_model=ResourceLibraryInstallList
)
def list_group_resource_library_installs(
    group_namespace: str,
    resource_type: str | None = Query(
        default=None, pattern="^(agent|skill|model|shell|retriever)$"
    ),
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

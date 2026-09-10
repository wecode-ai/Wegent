# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Authenticated Backend proxy endpoints for the Sites project API."""

from typing import NoReturn

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)

from app.core import security
from app.models.user import User
from app.schemas.site import (
    ApplicationTypeListResponse,
    EnvironmentRevision,
    EnvironmentSnapshot,
    EnvironmentVariableDeleteRequest,
    EnvironmentVariablePutRequest,
    EnvironmentVariablesPatchRequest,
    SiteAccessPolicy,
    SiteAccessPolicyUpdateRequest,
    SiteAppType,
    SiteCollaborator,
    SiteCollaboratorAddRequest,
    SiteCollaboratorListResponse,
    SiteListResponse,
    SiteMetadataUpdateRequest,
    SiteNetworkUpdateRequest,
    SiteResponse,
    SiteUpdateRequest,
)
from app.services.site_application_types import list_application_types
from app.services.sites import (
    SitesNotAvailableError,
    SitesUpstreamResponseError,
    SitesUpstreamUnavailableError,
    sites_service,
)

router = APIRouter()


def _raise_sites_error(error: Exception) -> NoReturn:
    if isinstance(error, SitesNotAvailableError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "sites_not_available",
                "message": "Sites is not available yet",
            },
        ) from error
    if isinstance(error, SitesUpstreamUnavailableError):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={
                "code": "sites_upstream_unavailable",
                "message": "Sites service is unavailable",
            },
        ) from error
    if isinstance(error, SitesUpstreamResponseError):
        raise HTTPException(
            status_code=error.status_code,
            detail=error.detail,
        ) from error
    raise error


@router.get("", response_model=SiteListResponse)
async def list_sites(
    app_type: SiteAppType = Query(default="web"),
    q: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
    current_user: User = Depends(security.get_current_user),
) -> SiteListResponse:
    """List typed applications owned by or shared with the authenticated user."""
    try:
        return await sites_service.list_sites(
            username=current_user.user_name,
            app_type=app_type,
            query=q.strip() if q and q.strip() else None,
            offset=offset,
            limit=limit,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.get("/app-types", response_model=ApplicationTypeListResponse)
async def list_site_app_types(
    _current_user: User = Depends(security.get_current_user),
) -> ApplicationTypeListResponse:
    """List application types and capabilities supported by this Backend."""
    return list_application_types()


@router.get(
    "/{siteid}/collaborators",
    response_model=SiteCollaboratorListResponse,
)
async def list_site_collaborators(
    siteid: str,
    current_user: User = Depends(security.get_current_user),
) -> SiteCollaboratorListResponse:
    """List collaborators for a Project owned by the authenticated user."""
    try:
        return await sites_service.list_collaborators(
            siteid, username=current_user.user_name
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.get("/{siteid}/access", response_model=SiteAccessPolicy)
async def get_site_access_policy(
    siteid: str,
    current_user: User = Depends(security.get_current_user),
) -> SiteAccessPolicy:
    """Return the latest inner access policy for an accessible Project."""
    try:
        return await sites_service.get_access_policy(
            siteid, username=current_user.user_name
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.put("/{siteid}/access", response_model=SiteAccessPolicy)
async def update_site_access_policy(
    siteid: str,
    payload: SiteAccessPolicyUpdateRequest,
    request: Request,
    idempotency_key: str = Header(
        ...,
        alias="Idempotency-Key",
        min_length=8,
        max_length=128,
    ),
    current_user: User = Depends(security.get_current_user),
) -> SiteAccessPolicy:
    """Replace the inner access policy for an accessible Project."""
    try:
        return await sites_service.update_access_policy(
            siteid,
            username=current_user.user_name,
            audience=payload.audience,
            subjects=payload.subjects,
            idempotency_key=idempotency_key,
            request_id=request.state.request_id,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.post(
    "/{siteid}/collaborators",
    response_model=SiteCollaborator,
    status_code=status.HTTP_201_CREATED,
)
async def add_site_collaborator(
    siteid: str,
    payload: SiteCollaboratorAddRequest,
    request: Request,
    idempotency_key: str = Header(
        ...,
        alias="Idempotency-Key",
        min_length=8,
        max_length=128,
    ),
    current_user: User = Depends(security.get_current_user),
) -> SiteCollaborator:
    """Add a collaborator to a Project owned by the authenticated user."""
    try:
        return await sites_service.add_collaborator(
            siteid,
            username=current_user.user_name,
            subject=payload.subject.strip(),
            idempotency_key=idempotency_key,
            request_id=request.state.request_id,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.delete(
    "/{siteid}/collaborators/{subject}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_site_collaborator(
    siteid: str,
    subject: str,
    request: Request,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Remove a collaborator without revoking already issued credentials."""
    try:
        await sites_service.remove_collaborator(
            siteid,
            subject,
            username=current_user.user_name,
            request_id=request.state.request_id,
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.post("/{siteid}/publish", response_model=SiteResponse)
async def publish_site(
    siteid: str,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Publish an accessible site by switching its project network to outer."""
    try:
        return await sites_service.update_site_network(
            siteid,
            username=current_user.user_name,
            network="outer",
        )
    except HTTPException:
        raise
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.put("/{siteid}/network", response_model=SiteResponse)
async def update_site_network(
    siteid: str,
    request: SiteNetworkUpdateRequest,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Update an accessible site network scope."""
    try:
        return await sites_service.update_site_network(
            siteid,
            username=current_user.user_name,
            network=request.network,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.put("/{siteid}", response_model=SiteResponse)
async def update_site(
    siteid: str,
    request: SiteUpdateRequest,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Update an accessible site name."""
    sitename = (request.sitename or request.name or "").strip()
    if not sitename:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "validation_error",
                "message": "Site name is required",
            },
        )
    try:
        return await sites_service.update_site_name(
            siteid,
            username=current_user.user_name,
            sitename=sitename,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.patch("/{siteid}", response_model=SiteResponse)
async def update_site_metadata(
    siteid: str,
    request: SiteMetadataUpdateRequest,
    current_user: User = Depends(security.get_current_user),
) -> SiteResponse:
    """Update editable metadata for an accessible site project."""
    request_fields = request.model_fields_set
    title = request.title if "title" in request_fields else request.name
    title = title.strip() if title is not None else None
    if ("title" in request_fields or "name" in request_fields) and not title:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "validation_error",
                "message": "Site title is required",
            },
        )
    custom_domain_prefix_set = "custom_domain_prefix" in request_fields
    custom_domain_prefix = request.custom_domain_prefix
    if isinstance(custom_domain_prefix, str):
        custom_domain_prefix = custom_domain_prefix.strip() or None
    if title is None and not custom_domain_prefix_set:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "validation_error",
                "message": "No editable site fields were provided",
            },
        )
    try:
        return await sites_service.update_site_metadata(
            siteid,
            username=current_user.user_name,
            title=title,
            custom_domain_prefix=custom_domain_prefix,
            custom_domain_prefix_set=custom_domain_prefix_set,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.get(
    "/{siteid}/environment-variables",
    response_model=EnvironmentSnapshot,
)
async def get_environment_variables(
    siteid: str,
    response: Response,
    current_user: User = Depends(security.get_current_user),
) -> EnvironmentSnapshot:
    """Return one accessible Site Project's latest environment configuration."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return await sites_service.get_environment_variables(
            siteid,
            username=current_user.user_name,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.patch(
    "/{siteid}/environment-variables",
    response_model=EnvironmentRevision,
    status_code=status.HTTP_201_CREATED,
)
async def patch_environment_variables(
    siteid: str,
    payload: EnvironmentVariablesPatchRequest,
    request: Request,
    response: Response,
    idempotency_key: str = Header(
        ...,
        alias="Idempotency-Key",
        min_length=8,
        max_length=128,
    ),
    current_user: User = Depends(security.get_current_user),
) -> EnvironmentRevision:
    """Atomically apply environment variable changes for an owned Site Project."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return await sites_service.patch_environment_variables(
            siteid,
            username=current_user.user_name,
            body=payload.model_dump(exclude_unset=True),
            idempotency_key=idempotency_key,
            request_id=request.state.request_id,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.put(
    "/{siteid}/environment-variables/{key}",
    response_model=EnvironmentRevision,
    status_code=status.HTTP_201_CREATED,
)
async def put_environment_variable(
    siteid: str,
    key: str,
    payload: EnvironmentVariablePutRequest,
    request: Request,
    response: Response,
    idempotency_key: str = Header(
        ...,
        alias="Idempotency-Key",
        min_length=8,
        max_length=128,
    ),
    current_user: User = Depends(security.get_current_user),
) -> EnvironmentRevision:
    """Create or replace one environment variable for an owned Site Project."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return await sites_service.put_environment_variable(
            siteid,
            key,
            username=current_user.user_name,
            body=payload.model_dump(exclude_unset=True),
            idempotency_key=idempotency_key,
            request_id=request.state.request_id,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.delete(
    "/{siteid}/environment-variables/{key}",
    response_model=EnvironmentRevision,
    status_code=status.HTTP_201_CREATED,
)
async def delete_environment_variable(
    siteid: str,
    key: str,
    payload: EnvironmentVariableDeleteRequest,
    request: Request,
    response: Response,
    idempotency_key: str = Header(
        ...,
        alias="Idempotency-Key",
        min_length=8,
        max_length=128,
    ),
    current_user: User = Depends(security.get_current_user),
) -> EnvironmentRevision:
    """Delete one environment variable from an owned Site Project."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return await sites_service.delete_environment_variable(
            siteid,
            key,
            username=current_user.user_name,
            body=payload.model_dump(exclude_unset=True),
            idempotency_key=idempotency_key,
            request_id=request.state.request_id,
        )
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)


@router.delete("/{siteid}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_site(
    siteid: str,
    current_user: User = Depends(security.get_current_user),
) -> Response:
    """Delete an owned site project."""
    try:
        await sites_service.delete_site(siteid, username=current_user.user_name)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except (
        SitesNotAvailableError,
        SitesUpstreamUnavailableError,
        SitesUpstreamResponseError,
    ) as error:
        _raise_sites_error(error)

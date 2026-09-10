# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Project event-subscription management and public ingestion endpoints."""

from datetime import datetime
from typing import Any, get_args

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.core.security import get_current_user
from app.models.delivery import (
    ProjectIncomingEvent,
    ProjectIncomingHook,
    loop_datetime_value_is_unset,
)
from app.models.user import User
from app.schemas.project_incoming_hook import (
    EventCollectionMode,
    EventSourceType,
    ProjectEventSourceCatalogItem,
    ProjectIncomingEventView,
    ProjectIncomingHookCreate,
    ProjectIncomingHookUpdate,
    ProjectIncomingHookView,
    ProjectIncomingReceipt,
)
from app.services.project_event_sources import event_source_catalog
from app.services.project_incoming_hooks import project_incoming_hook_service

router = APIRouter()
public_router = APIRouter()


MACHINE_CLI_CREDENTIALS = frozenset({"machine-cli", "local-cli"})
_EVENT_SOURCE_TYPES = frozenset(get_args(EventSourceType))
_EVENT_COLLECTION_MODES = frozenset(get_args(EventCollectionMode))
_RESOURCE_TYPE_FALLBACK = {
    item["source_type"]: (item["resource_types"] or ["endpoint"])[0]
    for item in event_source_catalog()
}


def _datetime(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _normalized_source_type(value: object) -> str:
    """Coerce a stored source type into a valid catalog value for the view."""
    text = str(value or "").strip()
    return text if text in _EVENT_SOURCE_TYPES else "generic"


def _reject_machine_cli_credential(
    values: ProjectIncomingHookCreate | ProjectIncomingHookUpdate,
) -> None:
    if values.credential_ref in MACHINE_CLI_CREDENTIALS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Machine CLI credentials are reserved for branch collectors",
        )


def _normalized_collection_mode(value: object) -> str:
    text = str(value or "webhook").strip()
    return text if text in _EVENT_COLLECTION_MODES else "webhook"


def _normalized_resource(value: object, source_type: str) -> dict[str, Any]:
    resource = value if isinstance(value, dict) else {}
    resource_type = resource.get("resource_type")
    if isinstance(resource_type, str) and resource_type:
        return resource
    return {
        "resource_type": _RESOURCE_TYPE_FALLBACK.get(source_type, "endpoint"),
        **resource,
    }


def _view(
    request: Request,
    hook: ProjectIncomingHook,
) -> ProjectIncomingHookView:
    metadata = project_incoming_hook_service.metadata(hook)
    source_type = _normalized_source_type(metadata.get("source_type") or hook.source)
    collection_mode = _normalized_collection_mode(metadata.get("collection_mode"))
    resource = _normalized_resource(metadata.get("resource"), source_type)
    poll = metadata.get("poll")
    health = metadata.get("health")
    return ProjectIncomingHookView(
        id=str(hook.id),
        project_id=str(hook.cloud_project_id),
        name=hook.name or "",
        status=hook.status or "disabled",
        source_type=source_type,
        collection_mode=collection_mode,
        resource=resource,
        webhook_url=(
            str(request.url_for("receive_project_incoming_hook", token=hook.public_id))
            if collection_mode in {"webhook", "hybrid"} and hook.public_id
            else None
        ),
        poll_interval_seconds=(
            int(poll.get("interval_seconds"))
            if isinstance(poll, dict) and isinstance(poll.get("interval_seconds"), int)
            else None
        ),
        credential_ref=(
            str(metadata.get("credential_ref"))
            if metadata.get("credential_ref")
            else None
        ),
        health=health if isinstance(health, dict) else {},
        last_event_at=_datetime(metadata.get("last_event_at")),
        next_poll_at=(
            None if loop_datetime_value_is_unset(hook.due_at) else hook.due_at
        ),
        version=hook.version,
        created_at=hook.created_at,
        updated_at=hook.updated_at,
    )


def _event_view(event: ProjectIncomingEvent) -> ProjectIncomingEventView:
    metadata = project_incoming_hook_service.metadata(event)
    normalized_events = metadata.get("normalized_events")
    matched_runs = metadata.get("matched_runs")
    return ProjectIncomingEventView(
        id=str(event.id),
        subscription_id=str(event.parent_id),
        source_type=event.source or "unknown",
        collection_mode=str(metadata.get("collection_mode") or "unknown"),
        status=event.status or "failed",
        normalized_events=(
            [dict(item) for item in normalized_events if isinstance(item, dict)]
            if isinstance(normalized_events, list)
            else []
        ),
        matched_runs=(
            [str(item) for item in matched_runs]
            if isinstance(matched_runs, list)
            else []
        ),
        reason=(
            str(metadata.get("reason"))
            if metadata.get("reason")
            else event.description or None
        ),
        attempt_count=int(metadata.get("attempt_count") or 0),
        created_at=event.created_at,
        updated_at=event.updated_at,
    )


@router.get(
    "/event-sources/catalog",
    response_model=list[ProjectEventSourceCatalogItem],
)
def get_event_source_catalog() -> list[ProjectEventSourceCatalogItem]:
    return [
        ProjectEventSourceCatalogItem.model_validate(item)
        for item in event_source_catalog()
    ]


@router.get(
    "/{project_id}/incoming-hooks",
    response_model=list[ProjectIncomingHookView],
)
def list_incoming_hooks(
    project_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectIncomingHookView]:
    return [
        _view(request, hook)
        for hook in project_incoming_hook_service.list(db, project_id, current_user.id)
    ]


@router.post(
    "/{project_id}/incoming-hooks",
    response_model=ProjectIncomingHookView,
    status_code=status.HTTP_201_CREATED,
)
def create_incoming_hook(
    project_id: str,
    values: ProjectIncomingHookCreate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectIncomingHookView:
    _reject_machine_cli_credential(values)
    hook = project_incoming_hook_service.create(
        db,
        project_id,
        current_user.id,
        values,
    )
    return _view(request, hook)


@router.patch(
    "/{project_id}/incoming-hooks/{hook_id}",
    response_model=ProjectIncomingHookView,
)
def update_incoming_hook(
    project_id: str,
    hook_id: str,
    values: ProjectIncomingHookUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectIncomingHookView:
    _reject_machine_cli_credential(values)
    hook = project_incoming_hook_service.update(
        db,
        project_id,
        hook_id,
        current_user.id,
        values,
    )
    return _view(request, hook)


@router.post(
    "/{project_id}/incoming-hooks/{hook_id}/rotate",
    response_model=ProjectIncomingHookView,
)
def rotate_incoming_hook(
    project_id: str,
    hook_id: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectIncomingHookView:
    hook = project_incoming_hook_service.rotate(
        db, project_id, hook_id, current_user.id
    )
    return _view(request, hook)


@router.delete(
    "/{project_id}/incoming-hooks/{hook_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_incoming_hook(
    project_id: str,
    hook_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> None:
    project_incoming_hook_service.delete(
        db,
        project_id,
        hook_id,
        current_user.id,
    )


@router.get(
    "/{project_id}/incoming-hooks/{hook_id}/events",
    response_model=list[ProjectIncomingEventView],
)
def list_incoming_events(
    project_id: str,
    hook_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[ProjectIncomingEventView]:
    return [
        _event_view(event)
        for event in project_incoming_hook_service.list_events(
            db,
            project_id,
            hook_id,
            current_user.id,
            limit=limit,
        )
    ]


@public_router.post(
    "/{token}",
    response_model=ProjectIncomingReceipt,
    status_code=status.HTTP_202_ACCEPTED,
    name="receive_project_incoming_hook",
)
async def receive_project_incoming_hook(
    token: str,
    request: Request,
    db: Session = Depends(get_db),
) -> ProjectIncomingReceipt:
    result = await project_incoming_hook_service.receive(
        db,
        token,
        await request.body(),
        request.headers.get("content-type", ""),
        request.headers,
    )
    return ProjectIncomingReceipt.model_validate(result)

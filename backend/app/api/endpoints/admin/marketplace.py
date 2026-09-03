# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Administrator marketplace curation endpoints."""

import json
from copy import deepcopy
from datetime import datetime
from pathlib import PurePath

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Path,
    Query,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import case, or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.api.dependencies import get_db
from app.core.security import get_admin_user
from app.models.kind import Kind
from app.models.marketplace_resource import MarketplaceResource
from app.models.plugin_marketplace import EPOCH_TIME, Plugin, PluginRelease
from app.models.smart_app_marketplace import SmartApp
from app.models.user import User
from app.schemas.admin_marketplace import (
    AdminMarketplacePlugin,
    AdminMarketplacePluginList,
    AdminMarketplacePluginUpdate,
    AdminMarketplaceResource,
    AdminMarketplaceResourceList,
    AdminMarketplaceResourceUpdate,
    AdminMarketplaceSmartApp,
    AdminMarketplaceSmartAppList,
    AdminMarketplaceSmartAppMetadataUpdate,
    AdminMarketplaceSmartAppUpdate,
)
from app.services.marketplace_artifact_storage import marketplace_artifact_storage
from app.services.official_smart_app_publisher import official_smart_app_publisher
from app.services.plugin_marketplace_identity import (
    ENTERPRISE_CATALOG_NAMESPACE,
    OFFICIAL_CATALOG_NAMESPACE,
)
from app.services.resource_library_service import (
    _marketplace_config,
    _marketplace_recommendation_score,
)
from app.services.smart_app_marketplace_service import smart_app_marketplace_service
from app.services.smart_app_package_parser import MAX_SMART_APP_PACKAGE_SIZE_BYTES
from shared.telemetry.decorators import trace_async

router = APIRouter()
UPLOAD_CHUNK_SIZE_BYTES = 1024 * 1024
MAX_SMART_APP_ICON_SIZE_BYTES = 2 * 1024 * 1024

KIND_BY_RESOURCE_TYPE = {
    "agent": "Team",
    "skill": "Skill",
}
PLUGIN_CATALOG_NAMESPACES = [
    OFFICIAL_CATALOG_NAMESPACE,
    ENTERPRISE_CATALOG_NAMESPACE,
]
PLUGIN_MANAGED_STATUSES = ["published", "unpublished"]


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
    icon_url = (
        marketplace_artifact_storage.presign_download(app.icon_storage_key)[0]
        if app.icon_storage_key
        else ""
    )
    return AdminMarketplaceSmartApp(
        id=app.id,
        name=app.name,
        display_name=app.display_name,
        summary=app.summary,
        description_md=app.description_md,
        tags=list(app.tags_json or []),
        icon_url=icon_url,
        publisher_user_name=publisher_user_name,
        is_system=app.owner_user_id == 0,
        featured_rank=app.featured_rank,
        is_listed=app.is_listed,
        needs_metadata=not bool(
            app.summary
            and app.description_md
            and app.tags_json
            and app.icon_storage_key
        ),
    )


def _plugin_response(
    plugin: Plugin, release: PluginRelease | None
) -> AdminMarketplacePlugin:
    manifest = (
        release.manifest_json
        if release and isinstance(release.manifest_json, dict)
        else {}
    )
    author = manifest.get("author")
    if isinstance(author, dict):
        author = author.get("name")
    return AdminMarketplacePlugin(
        id=plugin.id,
        catalog_namespace=plugin.catalog_namespace,
        name=plugin.name or plugin.slug,
        display_name=plugin.display_name or plugin.name or plugin.slug,
        description=plugin.summary or plugin.description_md,
        version=release.version if release else None,
        author=str(author) if author else None,
        featured_rank=plugin.featured_rank,
        is_listed=plugin.status == "published",
        created_at=plugin.created_at,
        updated_at=plugin.updated_at,
    )


def _managed_plugin(db: Session, plugin_id: int) -> tuple[Plugin, PluginRelease | None]:
    row = (
        db.query(Plugin, PluginRelease)
        .outerjoin(PluginRelease, PluginRelease.id == Plugin.latest_release_id)
        .filter(
            Plugin.id == plugin_id,
            Plugin.catalog_namespace.in_(PLUGIN_CATALOG_NAMESPACES),
            Plugin.status.in_(PLUGIN_MANAGED_STATUSES),
        )
        .first()
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Managed marketplace plugin not found",
        )
    return row


def _official_smart_app(db: Session, smart_app_id: int) -> SmartApp:
    app = (
        db.query(SmartApp)
        .filter(
            SmartApp.id == smart_app_id,
            SmartApp.owner_user_id == 0,
            SmartApp.source_type == "official",
            SmartApp.status == "published",
            SmartApp.visibility == "public",
        )
        .first()
    )
    if app is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Official marketplace Smart app not found",
        )
    return app


async def _read_optional_smart_app_icon(
    icon: UploadFile | None,
) -> tuple[bytes | None, str | None]:
    if icon is None:
        return None, None
    filename = (icon.filename or "").lower()
    content_type = {
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(PurePath(filename).suffix)
    if content_type is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Smart app icon must be PNG or WebP",
        )
    try:
        content = await icon.read(MAX_SMART_APP_ICON_SIZE_BYTES + 1)
    finally:
        await icon.close()
    if len(content) > MAX_SMART_APP_ICON_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="Smart app icon is too large",
        )
    return content, content_type


async def _read_smart_app_package(package: UploadFile) -> bytes:
    if not (package.filename or "").lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="Smart app package must be a ZIP")
    chunks = []
    size = 0
    try:
        while chunk := await package.read(UPLOAD_CHUNK_SIZE_BYTES):
            size += len(chunk)
            if size > MAX_SMART_APP_PACKAGE_SIZE_BYTES:
                raise HTTPException(
                    status_code=413, detail="Smart app package is too large"
                )
            chunks.append(chunk)
    finally:
        await package.close()
    return b"".join(chunks)


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
            Kind.is_active.is_(True),
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
            Kind.is_active.is_(True),
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
            Kind.is_active.is_(True),
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
    "/marketplace-plugins",
    response_model=AdminMarketplacePluginList,
)
@trace_async()
async def list_marketplace_plugins(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    search: str = Query(default="", max_length=100),
    listing_status: str = Query(default="all", pattern="^(all|listed|unlisted)$"),
    source: str = Query(default="all", pattern="^(all|wework-official|enterprise)$"),
    score_order: str = Query(default="desc", pattern="^(asc|desc)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplacePluginList:
    """List official and enterprise plugins managed in the Wework marketplace."""
    filters = [
        Plugin.catalog_namespace.in_(PLUGIN_CATALOG_NAMESPACES),
        Plugin.status.in_(PLUGIN_MANAGED_STATUSES),
    ]
    normalized_search = search.strip()
    if normalized_search:
        filters.append(
            or_(
                Plugin.name.contains(normalized_search, autoescape=True),
                Plugin.slug.contains(normalized_search, autoescape=True),
                Plugin.display_name.contains(normalized_search, autoescape=True),
                Plugin.summary.contains(normalized_search, autoescape=True),
                Plugin.description_md.contains(normalized_search, autoescape=True),
            )
        )
    if listing_status != "all":
        filters.append(
            Plugin.status
            == ("published" if listing_status == "listed" else "unpublished")
        )
    if source != "all":
        filters.append(Plugin.catalog_namespace == source)

    total = db.query(Plugin.id).filter(*filters).count()
    rows = (
        db.query(Plugin, PluginRelease)
        .outerjoin(PluginRelease, PluginRelease.id == Plugin.latest_release_id)
        .filter(*filters)
        .order_by(
            case(
                (Plugin.catalog_namespace == OFFICIAL_CATALOG_NAMESPACE, 1),
                else_=0,
            ).desc(),
            (
                Plugin.featured_rank.asc()
                if score_order == "asc"
                else Plugin.featured_rank.desc()
            ),
            Plugin.updated_at.desc(),
            Plugin.id.desc(),
        )
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )
    return AdminMarketplacePluginList(
        items=[_plugin_response(plugin, release) for plugin, release in rows],
        total=total,
        page=page,
        limit=limit,
    )


@router.put(
    "/marketplace-plugins/{plugin_id}",
    response_model=AdminMarketplacePlugin,
)
@trace_async()
async def update_marketplace_plugin(
    update: AdminMarketplacePluginUpdate,
    plugin_id: int = Path(gt=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplacePlugin:
    """Update marketplace copy, ranking, or listing state for one plugin."""
    plugin, release = _managed_plugin(db, plugin_id)
    if "description" in update.model_fields_set and update.description is not None:
        normalized_description = update.description.strip()
        plugin.summary = normalized_description
        if not normalized_description:
            plugin.description_md = ""
    if "featured_rank" in update.model_fields_set and update.featured_rank is not None:
        plugin.featured_rank = update.featured_rank
    if "is_listed" in update.model_fields_set and update.is_listed is not None:
        if update.is_listed:
            if (
                release is None
                or release.status != "ready"
                or release.scan_status != "passed"
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Plugin has no release ready for marketplace publication",
                )
            plugin.status = "published"
            if plugin.published_at == EPOCH_TIME:
                plugin.published_at = datetime.now()
        else:
            plugin.status = "unpublished"
    db.commit()
    db.refresh(plugin)
    if release is not None:
        db.refresh(release)
    return _plugin_response(plugin, release)


@router.get(
    "/marketplace-smart-apps",
    response_model=AdminMarketplaceSmartAppList,
)
@trace_async()
async def list_marketplace_smart_apps(
    page: int = Query(default=1, ge=1),
    limit: int = Query(default=50, ge=1, le=200),
    search: str = Query(default="", max_length=100),
    listing_status: str = Query(default="all", pattern="^(all|listed|unlisted)$"),
    source: str = Query(default="all", pattern="^(all|official|user)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplaceSmartAppList:
    """List official and user-published Smart apps visible to everyone."""
    filters = [
        SmartApp.status == "published",
        SmartApp.visibility == "public",
    ]
    normalized_search = search.strip()
    if normalized_search:
        filters.append(
            or_(
                SmartApp.name.contains(normalized_search, autoescape=True),
                SmartApp.display_name.contains(normalized_search, autoescape=True),
                SmartApp.summary.contains(normalized_search, autoescape=True),
                SmartApp.description_md.contains(normalized_search, autoescape=True),
            )
        )
    if listing_status != "all":
        filters.append(SmartApp.is_listed.is_(listing_status == "listed"))
    if source != "all":
        filters.append(SmartApp.source_type == source)
    total = db.query(SmartApp.id).filter(*filters).count()
    rows = (
        db.query(SmartApp, User.user_name)
        .outerjoin(User, User.id == SmartApp.owner_user_id)
        .filter(*filters)
        .order_by(
            SmartApp.featured_rank.desc(),
            case((SmartApp.source_type == "official", 1), else_=0).desc(),
            SmartApp.updated_at.desc(),
            SmartApp.id.desc(),
        )
        .offset((page - 1) * limit)
        .limit(limit)
        .all()
    )
    return AdminMarketplaceSmartAppList(
        items=[
            _smart_app_response(app, publisher_user_name)
            for app, publisher_user_name in rows
        ],
        total=total,
        page=page,
        limit=limit,
    )


@router.post(
    "/marketplace-smart-apps/import",
    response_model=AdminMarketplaceSmartApp,
)
@trace_async()
async def import_official_marketplace_smart_app(
    package: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplaceSmartApp:
    """Import and immediately publish one trusted official Smart app ZIP."""
    package_bytes = await _read_smart_app_package(package)
    try:
        built = official_smart_app_publisher.build_uploaded_package(package_bytes)
        existing_app = (
            db.query(SmartApp)
            .filter(SmartApp.owner_user_id == 0, SmartApp.name == built.name)
            .first()
        )
        featured_rank = existing_app.featured_rank if existing_app else 0
        app, _, _ = official_smart_app_publisher.publish_package(
            db, built=built, featured_rank=featured_rank
        )
    except HTTPException:
        db.rollback()
        raise
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        db.rollback()
        raise
    return _smart_app_response(app, None)


@router.put(
    "/marketplace-smart-apps/{smart_app_id}/metadata",
    response_model=AdminMarketplaceSmartApp,
)
@trace_async()
async def update_official_marketplace_smart_app_metadata(
    summary: str = Form(...),
    description_md: str = Form(...),
    tags: str = Form(...),
    icon: UploadFile | None = File(default=None),
    smart_app_id: int = Path(gt=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> AdminMarketplaceSmartApp:
    """Complete or revise marketplace presentation after an official import."""
    try:
        raw_tags = json.loads(tags)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Smart app tags must be a JSON array",
        ) from exc
    try:
        update = AdminMarketplaceSmartAppMetadataUpdate(
            summary=summary.strip(),
            description_md=description_md.strip(),
            tags=raw_tags,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    icon_content, icon_content_type = await _read_optional_smart_app_icon(icon)
    app = _official_smart_app(db, smart_app_id)
    updated = smart_app_marketplace_service.update_official_marketplace_metadata(
        db,
        app=app,
        summary=update.summary,
        description_md=update.description_md,
        tags=update.tags,
        icon=icon_content,
        icon_content_type=icon_content_type,
    )
    return _smart_app_response(updated, None)


@router.delete(
    "/marketplace-smart-apps/{smart_app_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
@trace_async()
async def delete_official_marketplace_smart_app(
    smart_app_id: int = Path(gt=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_admin_user),
) -> Response:
    """Permanently remove one platform-owned Smart app from the marketplace."""
    app = _official_smart_app(db, smart_app_id)
    smart_app_marketplace_service.delete_official_marketplace_app(db, app=app)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
    """Update curation fields for one public Smart app."""
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
    if update.featured_rank is not None:
        app.featured_rank = update.featured_rank
    if update.is_listed is not None:
        app.is_listed = update.is_listed
    db.commit()
    db.refresh(app)
    publisher = db.get(User, app.owner_user_id) if app.owner_user_id else None
    return _smart_app_response(app, publisher.user_name if publisher else None)

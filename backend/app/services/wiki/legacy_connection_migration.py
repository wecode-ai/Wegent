# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One-time migration from legacy Wiki preferences to named connections."""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument, KnowledgeDocumentExternalSource
from app.services.external_source_connections import (
    MAX_EXTERNAL_SOURCE_CONNECTIONS,
    external_source_connection_service,
)
from app.services.knowledge.external_document_identity import (
    WIKI_PROVIDER_ID,
    ExternalDocumentIdentityError,
    ExternalSyncLocator,
    decode_external_sync_resource_id,
    encode_external_sync_resource_id,
)
from app.services.user_mcp_service import UserMCPService
from app.services.wiki.connector import WIKI_CONNECTORS, register_builtin_connectors
from shared.models.db import User

LEGACY_CONNECTION_ID = "legacy-default"
WIKI_SERVICE_ID = "site"


@dataclass
class LegacyWikiMigrationReport:
    """Sanitized migration preview/result without credentials."""

    connection_count: int = 0
    document_count: int = 0
    user_ids: list[int] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)
    applied: bool = False


@dataclass(frozen=True)
class _MigrationPlan:
    user: User
    connection_id: str
    adapter_type: str
    enabled: bool
    site_url: str
    api_key: str
    default_locale: str | None
    documents: tuple[KnowledgeDocument, ...]


def _legacy_service(user: User) -> dict:
    preferences = UserMCPService.load_preferences(user.preferences)
    service = (
        ((preferences.get("mcps") or {}).get(WIKI_PROVIDER_ID) or {})
        .get("services", {})
        .get(WIKI_SERVICE_ID)
    )
    return dict(service) if isinstance(service, dict) else {}


def _legacy_documents(db: Session, user_id: int) -> list[KnowledgeDocument]:
    return (
        db.query(KnowledgeDocument)
        .join(KnowledgeDocument.external_source)
        .filter(
            KnowledgeDocument.user_id == user_id,
            KnowledgeDocumentExternalSource.external_provider == WIKI_PROVIDER_ID,
            KnowledgeDocumentExternalSource.external_resource_id.like(
                f"v1:{LEGACY_CONNECTION_ID}:%"
            ),
        )
        .all()
    )


def _target_resource_id(connection_id: str, document: KnowledgeDocument) -> str:
    try:
        locator = decode_external_sync_resource_id(
            WIKI_PROVIDER_ID, str(document.external_resource_id or "")
        )
    except ExternalDocumentIdentityError as exc:
        raise ValueError(f"invalid legacy identity on document {document.id}") from exc
    if locator.connection_id != LEGACY_CONNECTION_ID:
        raise ValueError(f"invalid legacy identity on document {document.id}")
    return encode_external_sync_resource_id(
        ExternalSyncLocator(WIKI_PROVIDER_ID, connection_id, locator.resource_id)
    )


def _identity_collision(
    db: Session, connection_id: str, documents: list[KnowledgeDocument]
) -> str | None:
    targets = {
        (document.kind_id, _target_resource_id(connection_id, document)): document.id
        for document in documents
    }
    if not targets:
        return None
    rows = (
        db.query(KnowledgeDocumentExternalSource)
        .filter(
            KnowledgeDocumentExternalSource.external_provider == WIKI_PROVIDER_ID,
            KnowledgeDocumentExternalSource.kind_id.in_(
                {kind_id for kind_id, _ in targets}
            ),
            KnowledgeDocumentExternalSource.external_resource_id.in_(
                {resource_id for _, resource_id in targets}
            ),
        )
        .all()
    )
    migrated_ids = {document.id for document in documents}
    for row in rows:
        key = (row.kind_id, row.external_resource_id)
        if key in targets and row.document_id not in migrated_ids:
            return (
                "identity collision for legacy Wiki document "
                f"{targets[key]} with document {row.document_id}"
            )
    return None


def _build_plan(db: Session, user: User) -> tuple[_MigrationPlan | None, str | None]:
    service = _legacy_service(user)
    if not service:
        return None, None
    credentials = UserMCPService.get_provider_service_credentials(
        user.preferences, WIKI_PROVIDER_ID, WIKI_SERVICE_ID
    )
    adapter_type = str(service.get("connector") or "")
    site_url = str(credentials.get("url") or "").strip().rstrip("/")
    api_key = str(credentials.get("api_key") or "").strip()
    enabled = bool(service.get("enabled"))
    options = service.get("options")
    default_locale = (
        str(options.get("default_locale"))
        if isinstance(options, dict) and options.get("default_locale")
        else None
    )
    issue = _validate_legacy_config(adapter_type, site_url, api_key, enabled)
    if issue:
        return None, f"user {user.id}: {issue}"

    connection_id = f"legacy-{user.id}"
    issue = _validate_connection_target(db, user, connection_id, adapter_type, site_url)
    documents = _legacy_documents(db, user.id)
    if not issue:
        issue = _identity_collision(db, connection_id, documents)
    if issue:
        return None, f"user {user.id}: {issue}"
    return (
        _MigrationPlan(
            user=user,
            connection_id=connection_id,
            adapter_type=adapter_type,
            enabled=enabled,
            site_url=site_url,
            api_key=api_key,
            default_locale=default_locale,
            documents=tuple(documents),
        ),
        None,
    )


def _validate_legacy_config(
    adapter_type: str, site_url: str, api_key: str, enabled: bool
) -> str | None:
    register_builtin_connectors()
    if not adapter_type or WIKI_CONNECTORS.get(adapter_type) is None:
        return f"unsupported Wiki connector: {adapter_type or '<empty>'}"
    if not site_url:
        return "legacy Wiki URL is empty"
    if enabled and not api_key:
        return "enabled legacy Wiki API key is empty"
    return None


def _validate_connection_target(
    db: Session,
    user: User,
    connection_id: str,
    adapter_type: str,
    site_url: str,
) -> str | None:
    existing = external_source_connection_service.get_owned(
        db,
        owner_user_id=user.id,
        provider_id=WIKI_PROVIDER_ID,
        connection_id=connection_id,
        include_inactive=True,
    )
    if existing:
        existing_url = str(existing.config.get("site_url") or "").rstrip("/")
        if existing.adapter_type != adapter_type or existing_url != site_url:
            return f"connection ID {connection_id} already targets another Wiki"
        return None
    if (
        len(
            external_source_connection_service.list_owned(
                db, owner_user_id=user.id, provider_id=WIKI_PROVIDER_ID
            )
        )
        >= MAX_EXTERNAL_SOURCE_CONNECTIONS
    ):
        return "external source connection limit reached"
    return None


def _plans(db: Session) -> tuple[list[_MigrationPlan], list[str]]:
    plans: list[_MigrationPlan] = []
    issues: list[str] = []
    for user in db.query(User).order_by(User.id.asc()).all():
        plan, issue = _build_plan(db, user)
        if plan:
            plans.append(plan)
        if issue:
            issues.append(issue)
    return plans, issues


def _report(
    plans: list[_MigrationPlan], issues: list[str]
) -> LegacyWikiMigrationReport:
    return LegacyWikiMigrationReport(
        connection_count=len(plans),
        document_count=sum(len(plan.documents) for plan in plans),
        user_ids=[plan.user.id for plan in plans],
        issues=issues,
    )


def inspect_legacy_wiki_connections(db: Session) -> LegacyWikiMigrationReport:
    """Return an exact read-only migration preview."""
    plans, issues = _plans(db)
    return _report(plans, issues)


def _remove_legacy_preferences(user: User) -> None:
    preferences = UserMCPService.load_preferences(user.preferences)
    mcps = dict(preferences.get("mcps") or {})
    provider = dict(mcps.get(WIKI_PROVIDER_ID) or {})
    services = dict(provider.get("services") or {})
    services.pop(WIKI_SERVICE_ID, None)
    if services:
        provider["services"] = services
        mcps[WIKI_PROVIDER_ID] = provider
    else:
        mcps.pop(WIKI_PROVIDER_ID, None)
    if mcps:
        preferences["mcps"] = mcps
    else:
        preferences.pop("mcps", None)
    user.preferences = UserMCPService.dump_preferences(preferences)


def _apply_plan(db: Session, plan: _MigrationPlan) -> None:
    external_source_connection_service.save_owned(
        db,
        owner_user_id=plan.user.id,
        provider_id=WIKI_PROVIDER_ID,
        connection_id=plan.connection_id,
        display_name="默认 Wiki",
        adapter_type=plan.adapter_type,
        enabled=plan.enabled,
        config={
            "site_url": plan.site_url,
            "default_locale": plan.default_locale,
        },
        credentials={"api_key": plan.api_key},
        commit=False,
        create_if_missing=True,
    )
    for document in plan.documents:
        document.external_source.external_resource_id = _target_resource_id(
            plan.connection_id, document
        )
        sync = dict(document.external_source_config.get("sync") or {})
        sync["connection_id"] = plan.connection_id
        sync["site_url"] = plan.site_url
        document.update_external_source_config(sync=sync)
    _remove_legacy_preferences(plan.user)


def migrate_legacy_wiki_connections(db: Session) -> LegacyWikiMigrationReport:
    """Atomically materialize every valid legacy Wiki preference."""
    plans, issues = _plans(db)
    report = _report(plans, issues)
    if issues:
        raise RuntimeError("; ".join(issues))
    if not plans:
        return report
    try:
        for plan in plans:
            _apply_plan(db, plan)
        db.commit()
    except Exception:
        db.rollback()
        raise
    report.applied = True
    return report

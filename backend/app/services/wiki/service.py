# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wiki connection and synchronized-document management services."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.orm import Session

from app.models.knowledge import DocumentSourceType, KnowledgeDocument
from app.services.external_source_connections import (
    ExternalSourceConnection,
    external_source_connection_service,
)
from app.services.wiki.connector import (
    WIKI_CONNECTORS,
    WikiApiError,
    WikiConnector,
    WikiSiteConfig,
    register_builtin_connectors,
)
from shared.models.db import User

WIKI_PROVIDER_ID = "wiki"


@dataclass(frozen=True)
class ResolvedWikiConnection:
    """A ready-to-use connection: config plus its connector."""

    config: WikiSiteConfig
    connector: WikiConnector
    owner_user_id: int
    owner_name: str
    connection_id: str
    revision: int
    display_name: str = "Wiki"


class WikiConnectionService:
    """Read/write user-owned Wiki connections stored as ``Kind`` rows."""

    @staticmethod
    def get_user_wiki_connection(
        user: User,
        db: Session,
        connection_id: str,
    ) -> ResolvedWikiConnection | None:
        stored = external_source_connection_service.get_owned(
            db,
            owner_user_id=user.id,
            provider_id=WIKI_PROVIDER_ID,
            connection_id=connection_id,
        )
        return WikiConnectionService._resolve_stored_connection(stored, user)

    @staticmethod
    def get_user_wiki_connection_for_connection_test(
        user: User,
        db: Session,
        connection_id: str,
    ) -> ResolvedWikiConnection | None:
        """Resolve saved credentials even when the connection is disabled."""
        stored = external_source_connection_service.get_owned(
            db,
            owner_user_id=user.id,
            provider_id=WIKI_PROVIDER_ID,
            connection_id=connection_id,
        )
        return WikiConnectionService._resolve_stored_connection(
            stored, user, require_enabled=False
        )

    @staticmethod
    def _resolve_stored_connection(
        stored: ExternalSourceConnection | None,
        user: User,
        *,
        require_enabled: bool = True,
    ) -> ResolvedWikiConnection | None:
        if stored is None or (require_enabled and not stored.enabled):
            return None
        register_builtin_connectors()
        connector = WIKI_CONNECTORS.get(stored.adapter_type)
        site_url = str(stored.config.get("site_url") or "").strip().rstrip("/")
        api_key = str(stored.credentials.get("api_key") or "").strip()
        if connector is None or not site_url or not api_key:
            return None
        default_locale = str(stored.config.get("default_locale") or "") or None
        return ResolvedWikiConnection(
            config=WikiSiteConfig(
                site_url=site_url,
                api_key=api_key,
                default_locale=default_locale,
            ),
            connector=connector,
            owner_user_id=user.id,
            owner_name=user.user_name,
            connection_id=stored.connection_id,
            revision=stored.revision,
            display_name=stored.display_name,
        )

    @staticmethod
    def lock_user_wiki_connection(
        user: User,
        db: Session,
        connection_id: str,
        *,
        include_inactive: bool = False,
    ) -> ResolvedWikiConnection | None:
        """Lock and resolve one connection for a mutation transaction."""
        stored = external_source_connection_service.get_owned(
            db,
            owner_user_id=user.id,
            provider_id=WIKI_PROVIDER_ID,
            connection_id=connection_id,
            include_inactive=include_inactive,
            for_update=True,
        )
        return WikiConnectionService._resolve_stored_connection(stored, user)

    @staticmethod
    def list_connections(db: Session, user: User) -> list[dict[str, Any]]:
        """Return stored connection summaries without plaintext keys."""
        summaries: list[dict[str, Any]] = []
        for stored in external_source_connection_service.list_owned(
            db, owner_user_id=user.id, provider_id=WIKI_PROVIDER_ID
        ):
            summaries.append(
                {
                    "id": stored.connection_id,
                    "display_name": stored.display_name,
                    "enabled": stored.enabled,
                    "connector_type": stored.adapter_type,
                    "site_url": str(stored.config.get("site_url") or ""),
                    "default_locale": stored.config.get("default_locale"),
                    "api_key_masked": (
                        WikiConnectionService.mask_api_key(
                            str(stored.credentials.get("api_key") or "")
                        )
                        if stored.credentials.get("api_key")
                        else ""
                    ),
                }
            )
        return summaries

    @staticmethod
    def save_named_connection(
        db: Session,
        user: User,
        *,
        connection_id: str | None,
        display_name: str,
        connector_type: str,
        site_url: str,
        api_key: str,
        default_locale: str | None,
        enabled: bool,
    ) -> dict[str, Any]:
        register_builtin_connectors()
        if WIKI_CONNECTORS.get(connector_type) is None:
            raise WikiApiError("bad_request", f"不支持的连接器类型：{connector_type}")
        if enabled and not api_key.strip():
            existing = (
                external_source_connection_service.get_owned(
                    db,
                    owner_user_id=user.id,
                    provider_id=WIKI_PROVIDER_ID,
                    connection_id=connection_id,
                    include_inactive=True,
                )
                if connection_id
                else None
            )
            if not existing or not existing.credentials.get("api_key"):
                raise WikiApiError("bad_request", "启用连接时必须提供 API Key")
        try:
            stored = external_source_connection_service.save_owned(
                db,
                owner_user_id=user.id,
                provider_id=WIKI_PROVIDER_ID,
                connection_id=connection_id,
                display_name=display_name,
                adapter_type=connector_type,
                enabled=enabled,
                config={
                    "site_url": site_url.strip().rstrip("/"),
                    "default_locale": default_locale or None,
                },
                credentials={"api_key": api_key.strip()},
            )
        except ValueError as exc:
            raise WikiApiError("bad_request", str(exc)) from exc
        return next(
            item
            for item in WikiConnectionService.list_connections(db, user)
            if item["id"] == stored.connection_id
        )

    @staticmethod
    def mask_api_key(api_key: str) -> str:
        if len(api_key) <= 8:
            return "****"
        return f"{api_key[:4]}****{api_key[-4:]}"


def list_kb_wiki_source_documents(
    db: Session, knowledge_base_id: int
) -> list[KnowledgeDocument]:
    """Return synchronized Wiki documents for the management UI."""
    documents = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.kind_id == knowledge_base_id,
            KnowledgeDocument.source_type == DocumentSourceType.EXTERNAL.value,
        )
        .all()
    )
    result: list[KnowledgeDocument] = []
    for document in documents:
        external = document.external_source_config
        sync = external.get("sync")
        if (
            document.source_type == DocumentSourceType.EXTERNAL.value
            and document.external_provider == WIKI_PROVIDER_ID
            and isinstance(sync, dict)
            and sync.get("enabled")
        ):
            result.append(document)
    return result


def wiki_document_uses_connection(
    document: KnowledgeDocument, connection_id: str
) -> bool:
    """Use the stable external identity so corrupt JSON cannot hide references."""
    if (
        document.source_type != DocumentSourceType.EXTERNAL.value
        or document.external_provider != WIKI_PROVIDER_ID
    ):
        return False
    encoded = str(document.external_resource_id or "")
    prefix, separator, remainder = encoded.partition(":")
    encoded_connection, second_separator, _resource_id = remainder.partition(":")
    return bool(
        prefix == "v1"
        and separator
        and second_separator
        and encoded_connection == connection_id
    )


def unbind_kb_wiki_document(
    db: Session, knowledge_base_id: int, document_id: int, user_id: int
) -> None:
    """Remove a synchronized Wiki document through normal cleanup."""
    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == document_id,
            KnowledgeDocument.kind_id == knowledge_base_id,
        )
        .first()
    )
    if (
        document is None
        or document.source_type != DocumentSourceType.EXTERNAL.value
        or document.external_provider != WIKI_PROVIDER_ID
    ):
        raise WikiApiError("bad_request", "Wiki 文档不存在或已被移除")

    from app.services.knowledge.knowledge_service import KnowledgeService

    try:
        result = KnowledgeService.delete_document(db, document_id, user_id)
    except ValueError as exc:
        raise WikiApiError("bad_request", str(exc)) from exc
    if not result.success:
        raise WikiApiError("bad_request", result.error or "Wiki 文档不存在或已被移除")


wiki_connection_service = WikiConnectionService()

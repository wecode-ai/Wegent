# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Wiki connection, KB mounting and delegated-scope resolution services.

Design: tmp/2026-09-03-wikijs-mcp-knowledge-design.md (v2.4).

Lives in the ``app.services.wiki`` package because the module-level name
``wiki_service`` is already taken by the code-wiki feature.

Three consumers share this module:
- REST endpoints (/api/wiki/*, /api/knowledge/{id}/wiki-bindings)
- The bridge MCP tools (scope map built from task KB bindings + explicit refs)
- selected_knowledge derivation and request_builder degradation
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from sqlalchemy.orm import Session

from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    DocumentStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.external_source_connections import (
    ExternalSourceConnection,
    external_source_connection_service,
)
from app.services.user_mcp_service import UserMCPService, user_mcp_service
from app.services.wiki.connector import (
    WIKI_CONNECTORS,
    WikiApiError,
    WikiConnector,
    WikiPage,
    WikiSiteConfig,
    build_page_url,
    register_builtin_connectors,
)
from shared.models.db import Kind, User
from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted

logger = logging.getLogger(__name__)

WIKI_PROVIDER_ID = "wiki"
WIKI_SERVICE_ID = "site"
LEGACY_WIKI_CONNECTION_ID = "legacy-default"
_SCOPE_SPECIFICITY = {"document": 0, "folder": 1, "knowledge_base": 2}


@dataclass(frozen=True)
class ResolvedWikiConnection:
    """A ready-to-use connection: config plus its connector."""

    config: WikiSiteConfig
    connector: WikiConnector
    owner_user_id: int
    owner_name: str
    connection_id: str = LEGACY_WIKI_CONNECTION_ID
    display_name: str = "Wiki"


@dataclass(frozen=True)
class WikiScopeEntry:
    """One authorized scope: a path anchor resolved to the adder connection."""

    target_type: str
    path: str
    config: WikiSiteConfig
    connector: WikiConnector
    owner_user_id: int
    owner_name: str
    kb_id: int | None = None


class WikiConnectionService:
    """Read/write the per-user wiki connection stored in user preferences."""

    @staticmethod
    def _raw_service(preferences: str | dict[str, Any] | None) -> dict[str, Any]:
        prefs = UserMCPService.load_preferences(preferences)
        service = (
            ((prefs.get("mcps") or {}).get(WIKI_PROVIDER_ID) or {})
            .get("services", {})
            .get(WIKI_SERVICE_ID)
        )
        return service if isinstance(service, dict) else {}

    @staticmethod
    def get_connection_from_preferences(
        preferences: str | dict[str, Any] | None,
        *,
        owner_user_id: int = 0,
        owner_name: str = "",
    ) -> ResolvedWikiConnection | None:
        """Resolve a usable connection; half-configured states return None."""
        register_builtin_connectors()
        service = WikiConnectionService._raw_service(preferences)
        if not service.get("enabled"):
            return None
        connector_type = str(service.get("connector") or "")
        connector = WIKI_CONNECTORS.get(connector_type)
        if connector is None:
            return None
        credentials = service.get("credentials")
        if not isinstance(credentials, dict):
            return None

        def _decrypted(key: str) -> str:
            value = credentials.get(key)
            if not isinstance(value, str) or not value:
                return ""
            if is_data_encrypted(value):
                return decrypt_sensitive_data(value) or ""
            return value

        site_url = _decrypted("url").strip()
        api_key = _decrypted("api_key").strip()
        if not site_url or not api_key:
            return None
        options = service.get("options")
        default_locale = None
        if isinstance(options, dict) and options.get("default_locale"):
            default_locale = str(options["default_locale"])
        return ResolvedWikiConnection(
            config=WikiSiteConfig(
                site_url=site_url.rstrip("/"),
                api_key=api_key,
                default_locale=default_locale,
            ),
            connector=connector,
            owner_user_id=owner_user_id,
            owner_name=owner_name,
            connection_id=LEGACY_WIKI_CONNECTION_ID,
            display_name="Wiki",
        )

    @staticmethod
    def get_user_wiki_connection(
        user: User,
        db: Session | None = None,
        connection_id: str | None = None,
    ) -> ResolvedWikiConnection | None:
        if connection_id and connection_id != LEGACY_WIKI_CONNECTION_ID:
            if db is None:
                return None
            stored = external_source_connection_service.get_owned(
                db,
                owner_user_id=user.id,
                provider_id=WIKI_PROVIDER_ID,
                connection_id=connection_id,
            )
            return WikiConnectionService._resolve_stored_connection(stored, user)
        return WikiConnectionService.get_connection_from_preferences(
            getattr(user, "preferences", None),
            owner_user_id=user.id,
            owner_name=user.user_name,
        )

    @staticmethod
    def get_connection_by_user_id(
        db: Session, user_id: int, connection_id: str | None = None
    ) -> ResolvedWikiConnection | None:
        """Delegated-consumption entry: resolve the adder's live connection."""
        user = (
            db.query(User).filter(User.id == user_id, User.is_active.is_(True)).first()
        )
        if user is None:
            return None
        return WikiConnectionService.get_user_wiki_connection(
            user, db=db, connection_id=connection_id
        )

    @staticmethod
    def _resolve_stored_connection(
        stored: ExternalSourceConnection | None, user: User
    ) -> ResolvedWikiConnection | None:
        if stored is None or not stored.enabled:
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
            display_name=stored.display_name,
        )

    @staticmethod
    def list_connections(db: Session, user: User) -> list[dict[str, Any]]:
        """Return legacy plus stored connection summaries without plaintext keys."""
        summaries: list[dict[str, Any]] = []
        legacy = WikiConnectionService.describe(user)
        if legacy["connector_type"] or legacy["site_url"]:
            summaries.append(
                {
                    **legacy,
                    "id": LEGACY_WIKI_CONNECTION_ID,
                    "display_name": "默认 Wiki",
                    "legacy": True,
                }
            )
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
                    "legacy": False,
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
    def save_connection(
        user: User,
        *,
        connector_type: str,
        site_url: str,
        api_key: str,
        default_locale: str | None,
        enabled: bool,
    ) -> str:
        """Persist the connection and return serialized preferences.

        Switching connector_type naturally resets credentials: url/api_key
        are always rewritten in full, so no stale values survive a switch.
        """
        register_builtin_connectors()
        connector = WIKI_CONNECTORS.get(connector_type)
        if connector is None:
            raise WikiApiError("bad_request", f"不支持的连接器类型：{connector_type}")
        if enabled and not api_key.strip():
            raise WikiApiError("bad_request", "启用连接时必须提供 API Key")
        cleaned_url = site_url.strip().rstrip("/")
        prefs = user_mcp_service.set_provider_service_config(
            user.preferences,
            provider_id=WIKI_PROVIDER_ID,
            service_id=WIKI_SERVICE_ID,
            enabled=enabled,
            url=cleaned_url,
            extra_credentials={"api_key": api_key.strip()},
            connector=connector_type,
        )
        service = (
            (prefs.get("mcps", {}).get(WIKI_PROVIDER_ID) or {})
            .get("services", {})
            .get(WIKI_SERVICE_ID)
        )
        if isinstance(service, dict):
            options = dict(service.get("options") or {})
            if default_locale:
                options["default_locale"] = default_locale
            else:
                options.pop("default_locale", None)
            service["options"] = options
        return UserMCPService.dump_preferences(prefs)

    @staticmethod
    def delete_legacy_connection(user: User) -> str:
        """Remove the legacy Wiki service while preserving other preferences."""
        prefs = UserMCPService.load_preferences(getattr(user, "preferences", None))
        mcps = dict(prefs.get("mcps") or {})
        provider = dict(mcps.get(WIKI_PROVIDER_ID) or {})
        services = dict(provider.get("services") or {})
        services.pop(WIKI_SERVICE_ID, None)

        if services:
            provider["services"] = services
            mcps[WIKI_PROVIDER_ID] = provider
        else:
            provider.pop("services", None)
            if provider:
                mcps[WIKI_PROVIDER_ID] = provider
            else:
                mcps.pop(WIKI_PROVIDER_ID, None)

        if mcps:
            prefs["mcps"] = mcps
        else:
            prefs.pop("mcps", None)
        return UserMCPService.dump_preferences(prefs)

    @staticmethod
    def describe(user: User) -> dict[str, Any]:
        """Connection summary for the settings UI; the key never returns clear."""
        service = WikiConnectionService._raw_service(getattr(user, "preferences", None))
        credentials = service.get("credentials")
        credentials = credentials if isinstance(credentials, dict) else {}
        raw_url = credentials.get("url")
        site_url = ""
        if isinstance(raw_url, str) and raw_url:
            site_url = (
                (
                    decrypt_sensitive_data(raw_url) or ""
                    if is_data_encrypted(raw_url)
                    else raw_url
                )
                .strip()
                .rstrip("/")
            )
        raw_key = credentials.get("api_key")
        api_key = ""
        if isinstance(raw_key, str) and raw_key:
            api_key = (
                decrypt_sensitive_data(raw_key) or ""
                if is_data_encrypted(raw_key)
                else raw_key
            ).strip()
        options = service.get("options")
        default_locale = None
        if isinstance(options, dict) and options.get("default_locale"):
            default_locale = str(options["default_locale"])
        return {
            "enabled": bool(service.get("enabled")),
            "connector_type": str(service.get("connector") or "") or None,
            "site_url": site_url,
            "default_locale": default_locale,
            "api_key_masked": (
                WikiConnectionService.mask_api_key(api_key) if api_key else ""
            ),
        }

    @staticmethod
    def mask_api_key(api_key: str) -> str:
        if len(api_key) <= 8:
            return "****"
        return f"{api_key[:4]}****{api_key[-4:]}"


# ---------------------------------------------------------------------------
# KB wiki documents (live-bound pages as knowledge_documents rows)
# ---------------------------------------------------------------------------

WIKI_SOURCE_TYPE = DocumentSourceType.EXTERNAL_WIKI.value
WIKI_SOURCE_CONFIG_KEY = "wiki"


def parse_wiki_updated_at(raw: str | None) -> datetime | None:
    """Parse a wiki ISO 8601 timestamp into a naive datetime.

    Project datetime columns are naive local time, so tz-aware values are
    converted to local time and stripped. Returns None on invalid input —
    callers fall back to the row default instead of failing the operation.
    """
    value = (raw or "").strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("[wiki] Unparseable page_updated_at %r ignored", value)
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _wiki_source_config(document: KnowledgeDocument) -> dict[str, Any]:
    source_config = getattr(document, "source_config", None)
    if not isinstance(source_config, dict):
        return {}
    config = source_config.get(WIKI_SOURCE_CONFIG_KEY)
    return config if isinstance(config, dict) else {}


def list_kb_wiki_documents(
    db: Session, knowledge_base_id: int
) -> list[KnowledgeDocument]:
    """All live-bound wiki pages of one knowledge base.

    The in-memory filter keeps test doubles (SimpleNamespace documents
    behind fake sessions) and future query shapes honest about source_type.
    """
    documents = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.kind_id == knowledge_base_id,
            KnowledgeDocument.source_type == WIKI_SOURCE_TYPE,
        )
        .all()
    )
    return [
        document
        for document in documents
        if getattr(document, "source_type", None) == WIKI_SOURCE_TYPE
    ]


def list_kb_wiki_source_documents(
    db: Session, knowledge_base_id: int
) -> list[KnowledgeDocument]:
    """Return live bindings plus synchronized Wiki documents for management UI."""
    documents = (
        db.query(KnowledgeDocument)
        .filter(KnowledgeDocument.kind_id == knowledge_base_id)
        .all()
    )
    result: list[KnowledgeDocument] = []
    for document in documents:
        if document.source_type == WIKI_SOURCE_TYPE:
            result.append(document)
            continue
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


def wiki_document_path(document: KnowledgeDocument) -> str:
    return str(_wiki_source_config(document).get("path") or "").strip("/")


def wiki_document_source_identity(
    document: KnowledgeDocument,
) -> tuple[str, str] | None:
    """Return the connection/path identity shared by live and sync modes."""
    if document.source_type == WIKI_SOURCE_TYPE:
        wiki = _wiki_source_config(document)
        return (
            str(wiki.get("connection_id") or LEGACY_WIKI_CONNECTION_ID),
            str(wiki.get("path") or "").strip("/"),
        )
    external = document.external_source_config
    sync = external.get("sync")
    if (
        document.source_type == DocumentSourceType.EXTERNAL.value
        and document.external_provider == WIKI_PROVIDER_ID
        and isinstance(sync, dict)
        and sync.get("enabled")
    ):
        return (
            str(sync.get("connection_id") or LEGACY_WIKI_CONNECTION_ID),
            str(sync.get("path") or "").strip("/"),
        )
    return None


def wiki_document_uses_connection(
    document: KnowledgeDocument, connection_id: str
) -> bool:
    """Return whether a live or synchronized Wiki document uses a connection."""
    identity = wiki_document_source_identity(document)
    return identity is not None and identity[0] == connection_id


def apply_wiki_page_metadata(document: KnowledgeDocument, page: Any) -> datetime | None:
    """Write page-derived metadata onto a bound wiki document row.

    file_size is the UTF-8 byte length of the Markdown source (the shared
    byte semantics of the file_size column); updated_at is the wiki page's
    content update time so list ordering matches what users see. Returns
    the parsed source timestamp (None when unparseable).
    """
    document.file_size = len((page.content or "").encode("utf-8"))
    page_updated_at = parse_wiki_updated_at(page.updated_at)
    if page_updated_at is not None:
        document.updated_at = page_updated_at
    return page_updated_at


async def bind_kb_wiki_documents(
    db: Session,
    kb: Kind,
    user: User,
    *,
    paths: list[str],
    connection_id: str | None = None,
) -> tuple[list[KnowledgeDocument], list[str]]:
    """Bind wiki pages as live documents, deduped by path.

    Returns (created documents, notes for skipped paths). The acting user's
    connection is the delegated credential owner for the new rows.
    """
    connection = WikiConnectionService.get_user_wiki_connection(
        user, db=db, connection_id=connection_id
    )
    if connection is None:
        raise WikiApiError(
            "wiki_not_configured",
            "请先在「设置 → 集成」配置外部 Wiki 连接后再添加绑定",
        )
    existing_paths = {
        identity
        for document in list_kb_wiki_source_documents(db, kb.id)
        if (identity := wiki_document_source_identity(document)) is not None
    }
    created: list[KnowledgeDocument] = []
    notes: list[str] = []
    for raw_path in paths:
        cleaned = (raw_path or "").strip().strip("/")
        if not cleaned:
            continue
        identity = (connection.connection_id, cleaned)
        if identity in existing_paths:
            notes.append(f"已绑定，已跳过：{cleaned}")
            continue
        try:
            page = await connection.connector.get_page(connection.config, cleaned)
        except WikiApiError as exc:
            notes.append(f"绑定失败（{exc.message}）：{cleaned}")
            continue
        if page is None:
            notes.append(f"Wiki 页面不存在：{cleaned}")
            continue
        document = KnowledgeDocument(
            kind_id=kb.id,
            name=page.title or cleaned,
            file_extension="md",
            file_size=0,
            status=DocumentStatus.ENABLED,
            user_id=user.id,
            is_active=True,  # live document: always readable, never indexed
            index_status=DocumentIndexStatus.NOT_INDEXED,
            source_type=WIKI_SOURCE_TYPE,
            updated_at=parse_wiki_updated_at(page.updated_at),
            source_config={
                WIKI_SOURCE_CONFIG_KEY: {
                    "path": cleaned,
                    "locale": page.locale or connection.config.default_locale or "",
                    "resource_url": build_page_url(connection.config.site_url, cleaned),
                    "site_url": connection.config.site_url,
                    "connection_id": connection.connection_id,
                    "page_id": page.id,
                    "page_updated_at": page.updated_at or "",
                    "bound_by_user_id": user.id,
                    "bound_by": user.user_name,
                    "bound_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
        document.external_source = KnowledgeDocumentExternalSource(
            kind_id=kb.id,
            external_provider="wiki",
            external_resource_id=(
                cleaned
                if connection.connection_id == LEGACY_WIKI_CONNECTION_ID
                else f"v1:{connection.connection_id}:{page.id}"
            ),
        )
        apply_wiki_page_metadata(document, page)
        db.add(document)
        existing_paths.add(identity)
        created.append(document)
    if not created and not notes:
        raise WikiApiError("bad_request", "没有可绑定的 Wiki 页面")
    db.commit()
    for document in created:
        db.refresh(document)
    return created, notes


def unbind_kb_wiki_document(
    db: Session, knowledge_base_id: int, document_id: int, user_id: int
) -> None:
    """Remove a live or synchronized wiki document through normal cleanup."""
    document = (
        db.query(KnowledgeDocument)
        .filter(
            KnowledgeDocument.id == document_id,
            KnowledgeDocument.kind_id == knowledge_base_id,
        )
        .first()
    )
    if document is None or wiki_document_source_identity(document) is None:
        raise WikiApiError("bad_request", "Wiki 文档不存在或已被移除")

    from app.services.knowledge.knowledge_service import KnowledgeService

    try:
        result = KnowledgeService.delete_document(db, document_id, user_id)
    except ValueError as exc:
        raise WikiApiError("bad_request", str(exc)) from exc
    if not result.success:
        raise WikiApiError("bad_request", result.error or "Wiki 文档不存在或已被移除")


def wiki_document_ref_value(document: KnowledgeDocument) -> dict[str, Any] | None:
    """Map a wiki document row to the ExternalKnowledgeRef value shape."""
    config = _wiki_source_config(document)
    path = str(config.get("path") or "").strip("/")
    if not path:
        return None
    return {
        "provider": "wiki",
        "mode": "explicit",
        "id": "wiki",
        "name": "外部 Wiki",
        "target_type": "document",
        "document_id": path,
        "target_name": document.name or path,
        "resource_url": str(config.get("resource_url") or ""),
        "bound_by_user_id": int(config.get("bound_by_user_id") or 0) or None,
        "boundBy": config.get("bound_by"),
        "connection_id": config.get("connection_id"),
    }


# ---------------------------------------------------------------------------
# Task-scope resolution shared by bridge tools and execution degradation
# ---------------------------------------------------------------------------


def _int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _task_kb_state(task: Any) -> tuple[list[int], set[int]]:
    """Return task KB ids and the ids whose persisted scope is restricted."""
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    kb_ids: list[int] = []
    for ref in spec.get("knowledgeBaseRefs") or []:
        kb_id = _int(ref.get("id") if isinstance(ref, dict) else None)
        if kb_id:
            kb_ids.append(kb_id)
    restricted: set[int] = set()
    for scope in spec.get("knowledgeBaseScopes") or []:
        if not isinstance(scope, dict):
            continue
        kb_id = _int(scope.get("id"))
        if kb_id and scope.get("scopeRestricted"):
            restricted.add(kb_id)
    return list(dict.fromkeys(kb_ids)), restricted


def collect_wiki_scope_entries(
    db: Session,
    task: Any,
    subtask_id: int | None,
) -> tuple[list[WikiScopeEntry], list[str]]:
    """Resolve all authorized wiki scopes for one task execution.

    Returns (entries, unavailable_notes). Entries come from KB bindings of
    the task's effective KB set plus explicit provider=wiki refs; a KB whose
    selection is scope-restricted to internal folders/documents contributes
    nothing (v2.4 "only what is selected" rule).
    """
    register_builtin_connectors()
    kb_ids, restricted = _task_kb_state(task)
    task_user_id = _int(getattr(task, "user_id", None))

    explicit_values: list[dict[str, Any]] = []
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    for ref in spec.get("externalKnowledgeRefs") or []:
        if isinstance(ref, dict) and ref.get("provider") == "wiki":
            explicit_values.append(ref)

    if subtask_id:
        contexts = (
            db.query(SubtaskContext)
            .filter(
                SubtaskContext.subtask_id == subtask_id,
                SubtaskContext.context_type.in_(
                    [
                        ContextType.KNOWLEDGE_BASE.value,
                        ContextType.EXTERNAL_KNOWLEDGE.value,
                    ]
                ),
                SubtaskContext.status == ContextStatus.READY.value,
            )
            .all()
        )
        for context in contexts:
            data = context.type_data if isinstance(context.type_data, dict) else {}
            if context.context_type == ContextType.EXTERNAL_KNOWLEDGE.value:
                if str(data.get("provider") or "").lower() == "wiki":
                    explicit_values.append(
                        {**data, "name": data.get("name") or context.name}
                    )
                continue
            kb_id = _int(data.get("knowledge_id"))
            if kb_id is None:
                continue
            if data.get("folder_ids") or data.get("document_ids"):
                restricted.add(kb_id)
            else:
                kb_ids.append(kb_id)

    if task_user_id:
        try:
            from app.services.chat.task_default_knowledge_bases import (
                resolve_task_default_knowledge_base_ids,
            )

            kb_ids.extend(
                resolve_task_default_knowledge_base_ids(db, task.id, task_user_id)
            )
        except Exception:
            logger.warning(
                "Failed to resolve default KBs for task %s", task.id, exc_info=True
            )

    kb_ids = [kb_id for kb_id in dict.fromkeys(kb_ids) if kb_id not in restricted]
    wiki_documents: list[tuple[int | None, KnowledgeDocument]] = []
    for kb_id in kb_ids:
        for document in list_kb_wiki_documents(db, kb_id):
            wiki_documents.append((kb_id, document))

    return _resolve_entries(db, wiki_documents, explicit_values)


def _resolve_entries(
    db: Session,
    wiki_documents: Iterable[tuple[int | None, KnowledgeDocument]],
    explicit_values: Iterable[dict[str, Any]],
) -> tuple[list[WikiScopeEntry], list[str]]:
    """Resolve owners once, build deduped entries and unavailable notes."""
    connection_cache: dict[tuple[int, str], ResolvedWikiConnection | None] = {}
    unavailable: list[str] = []
    entries: list[WikiScopeEntry] = []
    seen: set[tuple[int, str, str]] = set()

    def connection_for(
        owner_id: int, label: str, connection_id: str | None = None
    ) -> ResolvedWikiConnection | None:
        cache_key = (owner_id, connection_id or LEGACY_WIKI_CONNECTION_ID)
        if cache_key not in connection_cache:
            connection_cache[cache_key] = (
                WikiConnectionService.get_connection_by_user_id(
                    db, owner_id, connection_id=connection_id
                )
            )
            if connection_cache[cache_key] is None:
                note = f"「{label}」的添加者连接不可用，请联系添加者恢复或重新绑定"
                if note not in unavailable:
                    unavailable.append(note)
        return connection_cache[cache_key]

    document_owners_by_path: dict[str, int] = {}
    for kb_id, document in wiki_documents:
        config = _wiki_source_config(document)
        path = str(config.get("path") or "").strip("/")
        owner_id = _int(config.get("bound_by_user_id"))
        if not path or owner_id is None:
            continue
        document_owners_by_path[path] = owner_id
        connection_id = str(config.get("connection_id") or "") or None
        connection = connection_for(owner_id, document.name or path, connection_id)
        if connection is None:
            continue
        key = (owner_id, "document", path)
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            WikiScopeEntry(
                target_type="document",
                path=path,
                config=connection.config,
                connector=connection.connector,
                owner_user_id=owner_id,
                owner_name=connection.owner_name,
                kb_id=kb_id,
            )
        )

    for value in explicit_values:
        target_type = str(value.get("target_type") or "document")
        path = str(value.get("document_id") or value.get("node_id") or "").strip("/")
        owner_id = _int(value.get("bound_by_user_id"))
        label = str(value.get("target_name") or path or "Wiki")
        if owner_id is None:
            owner_id = document_owners_by_path.get(path)
        if owner_id is None:
            unavailable.append(f"「{label}」缺少凭据归属，无法委托读取")
            continue
        connection_id = str(value.get("connection_id") or "") or None
        connection = connection_for(owner_id, label, connection_id)
        if connection is None:
            continue
        key = (owner_id, target_type, path)
        if key in seen:
            continue
        seen.add(key)
        entries.append(
            WikiScopeEntry(
                target_type=target_type,
                path=path if target_type != "knowledge_base" else "",
                config=connection.config,
                connector=connection.connector,
                owner_user_id=owner_id,
                owner_name=connection.owner_name,
            )
        )

    entries.sort(key=lambda e: _SCOPE_SPECIFICITY.get(e.target_type, 3))
    return entries, unavailable


def path_in_scope(entry: WikiScopeEntry, page_path: str) -> bool:
    """Server-side authorization check: is page_path inside this scope?"""
    if entry.target_type == "knowledge_base" or not entry.path:
        return True
    page = page_path.strip().strip("/")
    anchor = entry.path.strip("/")
    if entry.target_type == "document":
        return page == anchor
    return page == anchor or page.startswith(f"{anchor}/")


def pick_scope_for_path(
    entries: list[WikiScopeEntry], page_path: str
) -> WikiScopeEntry | None:
    """Pick the most specific entry covering page_path (doc > subtree > site)."""
    matching = sorted(
        (entry for entry in entries if path_in_scope(entry, page_path)),
        key=lambda entry: _SCOPE_SPECIFICITY.get(entry.target_type, 3),
    )
    if not matching:
        return None
    return matching[0]


async def fetch_live_wiki_document_page(
    db: Session, document: KnowledgeDocument
) -> WikiPage:
    """Fetch the latest page body for one live-bound wiki document."""
    if document.source_type != WIKI_SOURCE_TYPE:
        raise WikiApiError("bad_request", "该文档不是实时外部 Wiki 文档")
    config = _wiki_source_config(document)
    path = str(config.get("path") or "").strip("/")
    if not path:
        raise WikiApiError("bad_request", "外部 Wiki 文档缺少页面路径")

    entries, unavailable = _resolve_entries(db, [(document.kind_id, document)], [])
    entry = pick_scope_for_path(entries, path)
    if entry is None:
        message = unavailable[0] if unavailable else "外部 Wiki 连接不可用"
        raise WikiApiError("wiki_not_configured", message)
    page = await entry.connector.get_page(entry.config, path, config.get("locale"))
    if page is None:
        raise WikiApiError("bad_request", "Wiki 页面不存在")
    return page


def any_site_scope(entries: list[WikiScopeEntry]) -> WikiScopeEntry | None:
    for entry in entries:
        if entry.target_type == "knowledge_base" or not entry.path:
            return entry
    return None


async def gather_scope_pages(
    entries: list[WikiScopeEntry],
    *,
    path: str | None,
    locale: str | None,
    limit: int,
    offset: int,
    max_pages: int,
) -> tuple[list[tuple[WikiScopeEntry, Any]], int | None, list[str]]:
    """List pages visible through the entries, scoped and merged.

    Multiple sites: only the first site participates and a warning is
    returned (callers should disambiguate with an explicit path prefix).
    """
    warnings: list[str] = []
    sites = list(dict.fromkeys(e.config.site_url for e in entries))
    if len(sites) > 1:
        warnings.append(
            "存在多个已绑定的 Wiki 站点，未指定 path 时仅返回其中一个；请用 path 前缀指定"
        )
    active = [e for e in entries if e.config.site_url == sites[0]]

    merged: dict[str, tuple[WikiScopeEntry, Any]] = {}
    site_entry = any_site_scope(active)
    if site_entry is not None:
        pages, _ = await site_entry.connector.list_pages(
            site_entry.config, path=path, locale=locale, limit=max_pages
        )
        for meta in pages:
            merged[meta.path] = (site_entry, meta)
    else:
        prefix = (path or "").strip("/")
        for entry in active:
            if entry.target_type == "folder":
                if prefix and not (
                    prefix == entry.path or prefix.startswith(f"{entry.path}/")
                ):
                    continue
                pages, _ = await entry.connector.list_pages(
                    entry.config,
                    path=entry.path,
                    locale=locale,
                    limit=min(max_pages, 500),
                )
                for meta in pages:
                    merged.setdefault(meta.path, (entry, meta))
            elif entry.target_type == "document" and (
                not prefix
                or entry.path == prefix
                or entry.path.startswith(f"{prefix}/")
            ):
                page = await entry.connector.get_page(entry.config, entry.path, locale)
                if page is not None:
                    merged.setdefault(page.path, (entry, page))

    ordered = [merged[key] for key in sorted(merged)]
    if len(ordered) > max_pages:
        warnings.append(f"页面数超过上限 {max_pages}，仅展示部分结果")
        ordered = ordered[:max_pages]
    batch = ordered[offset : offset + limit]
    next_offset = offset + limit if len(ordered) > offset + limit else None
    return batch, next_offset, warnings


async def search_scope_pages(
    entries: list[WikiScopeEntry],
    query: str,
    *,
    path: str | None,
    locale: str | None,
    limit: int,
    max_pages: int,
) -> tuple[list[tuple[WikiScopeEntry, Any]], list[str]]:
    """Search within authorized scopes; metadata only, deduped by path."""
    warnings: list[str] = []
    sites = list(dict.fromkeys(e.config.site_url for e in entries))
    if len(sites) > 1:
        warnings.append(
            "存在多个已绑定的 Wiki 站点，未指定 path 时仅搜索其中一个；请用 path 前缀指定"
        )
    active = [e for e in entries if e.config.site_url == sites[0]]

    if path:
        entry = pick_scope_for_path(active, path)
        if entry is None:
            return [], warnings
        metas = await entry.connector.search_pages(
            entry.config, query, path=path, locale=locale, limit=limit
        )
        return [(entry, meta) for meta in metas if path_in_scope(entry, meta.path)], (
            warnings
        )

    results: dict[str, tuple[WikiScopeEntry, Any]] = {}
    site_entry = any_site_scope(active)
    if site_entry is not None:
        metas = await site_entry.connector.search_pages(
            site_entry.config, query, locale=locale, limit=limit
        )
        for meta in metas:
            results[meta.path] = (site_entry, meta)
        return list(results.values())[:limit], warnings

    for entry in active:
        if entry.target_type not in {"folder", "document"}:
            continue
        if entry.target_type == "document":
            page = await entry.connector.get_page(entry.config, entry.path, locale)
            if page is not None:
                text = f"{page.title}\n{page.description}\n{page.path}".lower()
                if query.lower() in text:
                    results.setdefault(page.path, (entry, page))
            continue
        metas = await entry.connector.search_pages(
            entry.config, query, path=entry.path, locale=locale, limit=limit
        )
        for meta in metas:
            if path_in_scope(entry, meta.path):
                results.setdefault(meta.path, (entry, meta))
    return list(results.values())[:limit], warnings


wiki_connection_service = WikiConnectionService()

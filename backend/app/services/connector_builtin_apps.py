# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Built-in connector apps with vendor-fixed OAuth endpoints.

DingTalk hosts these MCP servers itself, so users never need to paste a URL:
the administrator publishes the app once and every user authorizes their own
account through the same connector OAuth flow.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from types import SimpleNamespace

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind
from app.schemas.connector import ConnectorAppWrite
from app.services.connector_apps import (
    CONNECTOR_APP_KIND,
    CONNECTOR_APP_NAMESPACE,
    CONNECTOR_APP_USER_ID,
    ConnectorAppService,
)

logger = logging.getLogger(__name__)

BUILTIN_TOOL_LOADING_MODE = "lazy"
BUILTIN_TOOL_LOADING_MODE_MARKER = "builtinToolLoadingMode"
BUILTIN_KEYWORDS_MARKER = "builtinKeywordsSeeded"


@dataclass(frozen=True)
class BuiltinConnectorApp:
    slug: str
    name: str
    mcp_url: str
    keywords: tuple[str, ...]


BUILTIN_CONNECTOR_APPS: tuple[BuiltinConnectorApp, ...] = (
    BuiltinConnectorApp(
        slug="dingtalk_docs",
        name="钉钉文档",
        mcp_url="https://mcp-gw.dingtalk.com/oauth/server/doc",
        keywords=(
            "钉钉文档",
            "钉钉 文档",
            "dingtalk docs",
            "dingtalk document",
        ),
    ),
    BuiltinConnectorApp(
        slug="dingtalk_sheet",
        name="钉钉表格",
        mcp_url="https://mcp-gw.dingtalk.com/oauth/server/sheet",
        keywords=(
            "钉钉表格",
            "钉钉 表格",
            "dingtalk table",
            "spreadsheet",
            "worksheet",
            "sheet",
            "dingtalk spreadsheet",
            "dingtalk worksheet",
            "dingtalk sheet",
            "钉钉工作表",
            "钉钉 工作表",
            "钉钉单元格",
            "钉钉 单元格",
            "钉钉公式",
            "钉钉 公式",
        ),
    ),
    BuiltinConnectorApp(
        slug="dingtalk_aitable",
        name="钉钉 AI 表格",
        mcp_url="https://mcp-gw.dingtalk.com/oauth/server/aitable",
        keywords=(
            "钉钉ai表格",
            "钉钉 ai 表格",
            "dingtalk ai table",
            "ai table",
            "notable",
            "钉钉多维表",
            "钉钉 多维表",
        ),
    ),
    BuiltinConnectorApp(
        slug="dingtalk_wiki",
        name="钉钉知识库",
        mcp_url="https://mcp-gw.dingtalk.com/oauth/server/wiki",
        keywords=(
            "钉钉知识库",
            "钉钉 知识库",
            "dingtalk wikispace",
            "dingtalk knowledge base",
        ),
    ),
)


def _endpoint_taken(db: Session, mcp_url: str) -> bool:
    """Whether an enabled system app already points at this upstream.

    Only owner ``CONNECTOR_APP_USER_ID`` is published in the system catalog, so
    another owner's app at the same URL must not hide the built-in one.
    """
    normalized = mcp_url.rstrip("/").casefold()
    rows = (
        db.query(Kind)
        .filter(
            Kind.kind == CONNECTOR_APP_KIND,
            Kind.namespace == CONNECTOR_APP_NAMESPACE,
            Kind.user_id == CONNECTOR_APP_USER_ID,
            Kind.is_active,
        )
        .all()
    )
    return any(
        str((row.json or {}).get("spec", {}).get("mcpUrl") or "").rstrip("/").casefold()
        == normalized
        for row in rows
    )


def _active_builtin_row(db: Session, slug: str) -> Kind | None:
    """Return the system-owned built-in app, never another owner's namesake."""
    return (
        db.query(Kind)
        .filter(
            Kind.kind == CONNECTOR_APP_KIND,
            Kind.namespace == CONNECTOR_APP_NAMESPACE,
            Kind.name == slug,
            Kind.user_id == CONNECTOR_APP_USER_ID,
            Kind.is_active,
        )
        .first()
    )


def _set_builtin_loading_mode(row: Kind, *, keywords: tuple[str, ...]) -> bool:
    """Apply the built-in lazy loading mode once, preserving later admin edits."""
    data = dict(row.json or {})
    spec = dict(data.get("spec") or {})
    changed = False
    if spec.get(BUILTIN_TOOL_LOADING_MODE_MARKER) != BUILTIN_TOOL_LOADING_MODE:
        spec["toolLoadingMode"] = BUILTIN_TOOL_LOADING_MODE
        spec[BUILTIN_TOOL_LOADING_MODE_MARKER] = BUILTIN_TOOL_LOADING_MODE
        changed = True
    if not spec.get(BUILTIN_KEYWORDS_MARKER):
        if not spec.get("keywords"):
            spec["keywords"] = list(keywords)
        spec[BUILTIN_KEYWORDS_MARKER] = True
        changed = True
    if not changed:
        return False
    data["spec"] = spec
    row.json = data
    flag_modified(row, "json")
    return True


def ensure_builtin_connector_apps(db: Session) -> list[str]:
    """Create the missing built-in apps and return the slugs that were created."""
    created: list[str] = []
    updated: list[str] = []
    for definition in BUILTIN_CONNECTOR_APPS:
        existing = _active_builtin_row(db, definition.slug)
        if existing:
            if _set_builtin_loading_mode(existing, keywords=definition.keywords):
                updated.append(definition.slug)
            continue
        if _endpoint_taken(db, definition.mcp_url):
            logger.info(
                "[Connectors] Skipping built-in app %s: upstream already published",
                definition.slug,
            )
            continue
        ConnectorAppService.create_app(
            db,
            ConnectorAppWrite(
                slug=definition.slug,
                name=definition.name,
                description="",
                visibility="all",
                auth_type="oauth2",
                transport="streamable-http",
                mcp_url=definition.mcp_url,
                tool_loading_mode=BUILTIN_TOOL_LOADING_MODE,
                keywords=list(definition.keywords),
            ),
            # No human administrator exists at startup; 0 marks a bootstrap.
            SimpleNamespace(id=0),
        )
        app_row = _active_builtin_row(db, definition.slug)
        if app_row is not None:
            _set_builtin_loading_mode(app_row, keywords=definition.keywords)
        created.append(definition.slug)
    if updated or created:
        db.commit()
    if updated:
        logger.info(
            "[Connectors] Backfilled built-in apps to %s loading: %s",
            BUILTIN_TOOL_LOADING_MODE,
            updated,
        )
    if created:
        logger.info("[Connectors] Created built-in apps: %s", created)
    return created

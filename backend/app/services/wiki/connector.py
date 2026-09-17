# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Connector abstraction for external Wiki synchronization."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import ClassVar


@dataclass(frozen=True)
class WikiSiteConfig:
    """Decrypted connection config. Lives in backend memory only."""

    site_url: str
    api_key: str
    default_locale: str | None = None


@dataclass(frozen=True)
class WikiPageMeta:
    """Metadata of one wiki page (no content)."""

    id: str
    path: str
    title: str
    description: str = ""
    updated_at: str = ""
    tags: tuple[str, ...] = ()
    locale: str = ""
    is_published: bool = True
    is_private: bool = False


@dataclass(frozen=True)
class WikiPage(WikiPageMeta):
    """A wiki page including its Markdown content."""

    content: str = ""


@dataclass(frozen=True)
class WikiPageProbe:
    """Metadata probe result for one stable remote page identity."""

    page: WikiPageMeta | None = None
    confirmed_missing: bool = False
    error_code: str | None = None
    error_message: str | None = None


def build_page_url(site_url: str, path: str) -> str:
    """Compose the human-facing page URL from a site root and page path."""
    return f"{site_url.rstrip('/')}/{path.lstrip('/')}"


@dataclass(frozen=True)
class WikiConnectionTest:
    """Result of a connector connection test."""

    ok: bool
    message: str
    version: str | None = None


class WikiApiError(Exception):
    """Normalized connector error surfaced through the error contract.

    Not a frozen dataclass: raising requires assigning __traceback__.
    """

    def __init__(self, error_code: str, message: str, retryable: bool = False) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.message = message
        self.retryable = retryable


class WikiConnector(ABC):
    """Protocol every wiki system connector implements."""

    supports_scheduled_sync: ClassVar[bool] = False
    connector_type: str
    display_name: str
    # Credential keys this connector reads from the encrypted service store.
    credential_fields: tuple[str, ...] = ("url", "api_key")

    @abstractmethod
    async def test_connection(self, config: WikiSiteConfig) -> WikiConnectionTest:
        """Probe the site and report reachability plus product version."""

    @abstractmethod
    async def list_pages(
        self,
        config: WikiSiteConfig,
        *,
        path: str | None = None,
        locale: str | None = None,
        limit: int,
        offset: int = 0,
    ) -> tuple[list[WikiPageMeta], int | None]:
        """List published pages, optionally under a path prefix.

        Returns the page batch and the next offset (None when exhausted).
        """

    async def get_page_metadata_by_id(
        self,
        config: WikiSiteConfig,
        resource_id: str,
    ) -> WikiPageMeta | None:
        """Read page metadata by the provider's stable resource identity.

        Connectors should implement this when their list API can be truncated.
        A lookup error is intentionally different from a confirmed missing page.
        """
        raise WikiApiError(
            "wiki_lookup_unsupported",
            "当前 Wiki 连接器不支持按资源 ID 查询",
            retryable=False,
        )

    async def inspect_page_metadata_by_ids(
        self,
        config: WikiSiteConfig,
        resource_ids: list[str],
        *,
        batch_size: int,
    ) -> dict[str, WikiPageProbe]:
        """Inspect stable page identities without listing the entire Wiki."""
        raise WikiApiError(
            "wiki_lookup_unsupported",
            "当前 Wiki 连接器不支持批量查询页面元数据",
            retryable=False,
        )

    async def get_page_by_id(
        self,
        config: WikiSiteConfig,
        resource_id: str,
    ) -> WikiPage | None:
        """Read one page body by the provider's stable resource identity."""
        raise WikiApiError(
            "wiki_lookup_unsupported",
            "当前 Wiki 连接器不支持按资源 ID 查询页面正文",
            retryable=False,
        )


@dataclass
class _ConnectorRegistry:
    """In-process registry of available wiki connectors."""

    connectors: dict[str, WikiConnector] = field(default_factory=dict)

    def register(self, connector: WikiConnector) -> None:
        self.connectors[connector.connector_type] = connector

    def get(self, connector_type: str) -> WikiConnector | None:
        return self.connectors.get(connector_type)

    def list(self) -> list[WikiConnector]:
        return list(self.connectors.values())


WIKI_CONNECTORS = _ConnectorRegistry()


def register_builtin_connectors() -> None:
    """Register shipped connectors once (idempotent)."""
    if WIKI_CONNECTORS.get("wikijs"):
        return
    from app.services.wiki.connectors.wikijs import WikijsConnector

    WIKI_CONNECTORS.register(WikijsConnector())

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Wiki.js connector (GraphQL adapter)."""

from unittest.mock import patch

import pytest

from app.core.config import settings as app_settings
from app.services.wiki.connector import (
    WikiApiError,
    WikiConnector,
    WikiPageMeta,
    WikiSiteConfig,
)
from app.services.wiki.connectors.wikijs import (
    WikijsConnector,
    validate_wiki_site_url,
)


def _config(url: str = "https://wiki.example.com") -> WikiSiteConfig:
    return WikiSiteConfig(site_url=url, api_key="key-123")


def _async_returning(value):
    async def _return(*_args, **_kwargs):
        return value

    return _return


def test_scheduled_sync_capability_is_opt_in() -> None:
    assert WikiConnector.supports_scheduled_sync is False
    assert WikijsConnector.supports_scheduled_sync is True


class TestValidateWikiSiteUrl:
    def test_accepts_https(self):
        # DNS-dependent host policy is stubbed: scheme handling under test.
        with patch("app.services.wiki.connectors.wikijs._assert_public_host"):
            assert (
                validate_wiki_site_url("https://wiki.example.com/")
                == "https://wiki.example.com"
            )

    def test_accepts_http_scheme(self):
        # http is allowed as a scheme; private-host policy is a separate check
        with patch("app.services.wiki.connectors.wikijs._assert_public_host"):
            assert (
                validate_wiki_site_url("http://wiki.example.com")
                == "http://wiki.example.com"
            )

    def test_rejects_other_schemes(self):
        with pytest.raises(WikiApiError):
            validate_wiki_site_url("ftp://wiki.example.com")

    def test_rejects_missing_host(self):
        with pytest.raises(WikiApiError):
            validate_wiki_site_url("https://")

    def test_rejects_embedded_credentials(self):
        with pytest.raises(WikiApiError):
            validate_wiki_site_url("https://user:pass@wiki.example.com")

    def test_rejects_private_host_by_default(self, monkeypatch):
        # Pin the flag: deployments (and local .env files) may enable it.
        monkeypatch.setattr(app_settings, "WIKI_ALLOW_PRIVATE_NETWORK", False)
        # The localhost name is rejected before any DNS resolution.
        with pytest.raises(WikiApiError):
            validate_wiki_site_url("https://localhost")

    def test_public_host_policy_is_applied(self, monkeypatch):
        monkeypatch.setattr(app_settings, "WIKI_ALLOW_PRIVATE_NETWORK", False)
        # The platform host policy must run for non-localhost hosts.
        with patch(
            "app.services.wiki.connectors.wikijs._assert_public_host"
        ) as mock_assert:
            validate_wiki_site_url("https://wiki.example.com")
        mock_assert.assert_called_once_with("wiki.example.com")

    def test_private_host_allowed_with_flag(self, monkeypatch):
        monkeypatch.setattr(app_settings, "WIKI_ALLOW_PRIVATE_NETWORK", True)
        assert (
            validate_wiki_site_url("https://intranet.local") == "https://intranet.local"
        )


class TestListPages:
    def _connector(self):
        return WikijsConnector()

    @pytest.mark.asyncio
    async def test_client_side_offset_and_prefix(self):
        connector = self._connector()
        pages = [
            WikiPageMeta(id=str(i), path=p, title=p)
            for i, p in enumerate(
                [
                    "docs/a",
                    "docs/b",
                    "docs/sub/c",
                    "other/d",
                    "unpublished",
                ]
            )
        ]
        pages[-1] = WikiPageMeta(
            id="4", path="unpublished", title="x", is_published=False
        )

        async def fake_post(config, query, variables):
            # list has no server-side path filter: prefixing is client-side
            assert "path" not in variables
            return {"pages": {"list": [meta.__dict__ for meta in pages]}}

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            batch, next_offset = await connector.list_pages(
                _config(), path="docs", locale=None, limit=2, offset=1
            )
        assert [meta.path for meta in batch] == ["docs/b", "docs/sub/c"]
        assert next_offset is None  # only 3 published pages under docs

    @pytest.mark.asyncio
    async def test_subtree_listing_fetches_bounded_full_list(self):
        """Regression: pages.list has no path filter, so a subtree query with
        a small limit must still fetch broadly — otherwise the target page is
        missed whenever recent updates live outside the subtree (this was the
        "directory not found" misreport on folder binding)."""
        connector = self._connector()

        async def fake_post(config, query, variables):
            assert variables["limit"] == app_settings.WIKI_TREE_MAX_PAGES
            # Newest page is outside the requested subtree on purpose.
            return {
                "pages": {
                    "list": [
                        {"id": 1, "path": "other/recent", "title": "recent"},
                        {
                            "id": 2,
                            "path": "tech-wiki/elasticsearch",
                            "title": "Elasticsearch",
                        },
                    ]
                }
            }

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            metas, _ = await connector.list_pages(
                _config(), path="tech-wiki", locale=None, limit=1
            )
        assert [meta.path for meta in metas] == ["tech-wiki/elasticsearch"]

    @pytest.mark.asyncio
    async def test_private_pages_are_filtered(self):
        connector = self._connector()

        async def fake_post(config, query, variables):
            return {
                "pages": {
                    "list": [
                        {"id": 1, "path": "docs/a", "title": "a"},
                        {
                            "id": 2,
                            "path": "docs/private",
                            "title": "p",
                            "isPrivate": True,
                        },
                    ]
                }
            }

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            metas, _ = await connector.list_pages(_config(), limit=10)
        assert [meta.path for meta in metas] == ["docs/a"]

    @pytest.mark.asyncio
    async def test_pages_are_requested_in_recently_updated_order(self):
        connector = self._connector()
        captured = {}

        async def fake_post(config, query, variables):
            captured["query"] = query
            return {"pages": {"list": []}}

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            await connector.list_pages(_config(), limit=10)

        assert "orderByDirection: DESC" in captured["query"]


class TestGetPageMetadataById:
    @pytest.mark.asyncio
    async def test_queries_single_by_numeric_id(self):
        connector = WikijsConnector()
        captured = {}

        async def fake_post(config, query, variables):
            captured["query"] = query
            captured["variables"] = variables
            return {
                "pages": {
                    "single": {
                        "id": 5001,
                        "path": "docs/recent",
                        "title": "Recent",
                        "description": "",
                        "updatedAt": "2026-09-08T02:00:00Z",
                        "locale": "zh",
                        "tags": [],
                    }
                }
            }

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            meta = await connector.get_page_metadata_by_id(_config(), "5001")

        assert "single(id: $id)" in captured["query"]
        assert captured["variables"] == {"id": 5001}
        assert meta is not None
        assert meta.path == "docs/recent"

    @pytest.mark.asyncio
    async def test_missing_page_returns_none(self):
        connector = WikijsConnector()

        async def fake_post(config, query, variables):
            raise WikiApiError(
                "upstream_error", "Wiki 站点返回错误：This page does not exist."
            )

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            assert await connector.get_page_metadata_by_id(_config(), "5001") is None

    @pytest.mark.asyncio
    async def test_permission_error_propagates(self):
        connector = WikijsConnector()

        async def fake_post(config, query, variables):
            raise WikiApiError("wiki_auth_failed", "bad key")

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            with pytest.raises(WikiApiError, match="bad key"):
                await connector.get_page_metadata_by_id(_config(), "5001")


class TestGetPageById:
    @pytest.mark.asyncio
    async def test_reads_content_by_stable_numeric_id(self):
        connector = WikijsConnector()
        captured = {}

        async def fake_post(config, query, variables):
            captured["query"] = query
            captured["variables"] = variables
            return {
                "pages": {
                    "single": {
                        "id": 5001,
                        "path": "docs/renamed",
                        "title": "Renamed",
                        "updatedAt": "2026-09-13T02:00:00Z",
                        "locale": "zh",
                        "content": "# Renamed",
                        "tags": [],
                    }
                }
            }

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            page = await connector.get_page_by_id(_config(), "5001")

        assert "single(id: $id)" in captured["query"]
        assert captured["variables"] == {"id": 5001}
        assert page is not None
        assert page.path == "docs/renamed"
        assert page.content == "# Renamed"


class TestPageQuerySchema:
    """Lock the field shapes required by the Wiki.js schema (2.x)."""

    @pytest.mark.asyncio
    async def test_page_query_selects_tag_subfields(self):
        connector = WikijsConnector()
        captured = {}

        async def fake_post(config, query, variables):
            captured["query"] = query
            return {
                "pages": {
                    "singleByPath": {
                        "id": 7,
                        "path": "docs/a",
                        "title": "A",
                        "description": "",
                        "updatedAt": "2026-09-01T00:00:00Z",
                        "locale": "zh",
                        "content": "# A",
                        "render": "",
                        "tags": [{"id": 1, "tag": "arch", "title": "Architecture"}],
                    }
                }
            }

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            page = await connector.get_page(_config(), "docs/a")

        # Page.tags is [PageTag]!: the query must use a subfield selection and
        # must not select auth-gated fields (content needs read:source,
        # isPublished needs write:pages).
        assert "tags { id tag title }" in captured["query"]
        assert "isPublished" not in captured["query"]
        assert page is not None
        assert page.content == "# A"
        assert page.tags == ("arch",)
        assert page.is_private is False


class TestGetPageLocaleFallback:
    """singleByPath requires an exact locale match; Wiki.js reports a miss
    as a GraphQL error ("This page does not exist.")."""

    @staticmethod
    def _connector_with_locales(monkeypatch, locales):
        from app.services.wiki.connectors import wikijs as wikijs_module

        monkeypatch.setattr(wikijs_module, "_SITE_LOCALES_CACHE", {})
        connector = WikijsConnector()
        monkeypatch.setattr(
            connector,
            "_installed_locales",
            _async_returning(locales),
        )
        return connector

    @pytest.mark.asyncio
    async def test_default_locale_miss_falls_back_to_installed(self, monkeypatch):
        connector = self._connector_with_locales(monkeypatch, ["en", "zh"])
        tried = []

        async def fake_post(config, query, variables):
            if "localization" in query:
                return {"localization": {"locales": []}}
            tried.append(variables["locale"])
            if variables["locale"] != "en":
                raise WikiApiError(
                    "upstream_error", "Wiki 站点返回错误：This page does not exist."
                )
            return {
                "pages": {
                    "singleByPath": {
                        "id": 7,
                        "path": "docs/a",
                        "title": "A",
                        "locale": "en",
                        "content": "# A",
                        "tags": [],
                    }
                }
            }

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            page = await connector.get_page(
                WikiSiteConfig(
                    site_url="https://wiki.example.com",
                    api_key="k",
                    default_locale="zh",
                ),
                "docs/a",
            )
        # default_locale zh first, then installed fallbacks
        assert tried == ["zh", "en"]
        assert page is not None
        assert page.locale == "en"

    @pytest.mark.asyncio
    async def test_explicit_locale_is_strict(self, monkeypatch):
        connector = self._connector_with_locales(monkeypatch, ["en", "zh"])

        async def fake_post(config, query, variables):
            raise WikiApiError(
                "upstream_error", "Wiki 站点返回错误：This page does not exist."
            )

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            page = await connector.get_page(_config(), "docs/a", "ja")
        assert page is None

    @pytest.mark.asyncio
    async def test_all_locales_miss_returns_none(self, monkeypatch):
        connector = self._connector_with_locales(monkeypatch, ["en", "zh"])
        calls = []

        async def fake_post(config, query, variables):
            if "localization" in query:
                return {"localization": {"locales": []}}
            calls.append(variables["locale"])
            raise WikiApiError(
                "upstream_error", "Wiki 站点返回错误：This page does not exist."
            )

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            page = await connector.get_page(_config(), "docs/a")
        assert page is None
        assert calls == ["en", "zh"]

    @pytest.mark.asyncio
    async def test_other_errors_propagate(self, monkeypatch):
        connector = self._connector_with_locales(monkeypatch, ["en"])

        async def fake_post(config, query, variables):
            raise WikiApiError("wiki_auth_failed", "bad key")

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            with pytest.raises(WikiApiError):
                await connector.get_page(_config(), "docs/a")


class TestInspectPageMetadataByIds:
    @pytest.mark.asyncio
    async def test_maps_partial_success_missing_and_forbidden(self):
        connector = WikijsConnector()
        payload = {
            "data": {
                "pages": {
                    "p0": {
                        "id": 11,
                        "path": "docs/a",
                        "title": "A",
                        "updatedAt": "2026-09-11T01:00:00Z",
                        "locale": "zh",
                        "tags": [],
                    },
                    "p1": None,
                    "p2": None,
                }
            },
            "errors": [{"message": "Forbidden", "path": ["pages", "p2"]}],
        }

        with patch.object(connector, "_request_graphql", return_value=payload):
            probes = await connector.inspect_page_metadata_by_ids(
                _config(), ["11", "12", "13"], batch_size=500
            )

        assert probes["11"].page.path == "docs/a"
        assert probes["12"].confirmed_missing is True
        assert probes["13"].error_code == "wiki_page_forbidden"
        assert probes["13"].error_message == "无权访问 Wiki 源文档"

    @pytest.mark.asyncio
    async def test_global_error_prevents_null_page_from_being_confirmed_missing(self):
        connector = WikijsConnector()
        payload = {
            "data": {"pages": {"p0": None}},
            "errors": [{"message": "Upstream temporarily unavailable"}],
        }

        with patch.object(connector, "_request_graphql", return_value=payload):
            probes = await connector.inspect_page_metadata_by_ids(
                _config(), ["11"], batch_size=500
            )

        assert probes["11"].confirmed_missing is False
        assert probes["11"].error_code == "upstream_error"

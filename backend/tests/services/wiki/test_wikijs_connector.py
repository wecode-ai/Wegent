# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for the Wiki.js connector (GraphQL adapter)."""

from unittest.mock import AsyncMock, MagicMock, patch

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


def test_scheduled_sync_capability_is_opt_in() -> None:
    assert WikiConnector.supports_scheduled_sync is False
    assert WikijsConnector.supports_scheduled_sync is True


class TestValidateWikiSiteUrl:
    def test_accepts_https(self):
        assert (
            validate_wiki_site_url("https://wiki.example.com/")
            == "https://wiki.example.com"
        )

    def test_accepts_http_scheme(self):
        # Self-hosted Wiki.js deployments may only be reachable over intranet HTTP.
        assert (
            validate_wiki_site_url("http://wiki.example.com")
            == "http://wiki.example.com"
        )

    @pytest.mark.parametrize(
        "site_url",
        [
            "ftp://wiki.example.com",
            "https://",
            "https://user:pass@wiki.example.com",
        ],
    )
    def test_rejects_invalid_urls(self, site_url):
        with pytest.raises(WikiApiError):
            validate_wiki_site_url(site_url)

    @pytest.mark.parametrize(
        "site_url",
        [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
            "https://intranet.local",
        ],
    )
    def test_accepts_local_and_private_hosts(self, site_url):
        assert validate_wiki_site_url(site_url) == site_url


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
            assert variables["limit"] == app_settings.WIKI_TREE_MAX_PAGES + 1
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

    @pytest.mark.asyncio
    async def test_page_cap_cursor_does_not_repeat_the_current_offset(
        self, monkeypatch
    ):
        connector = self._connector()
        monkeypatch.setattr(app_settings, "WIKI_TREE_MAX_PAGES", 2)

        with patch.object(
            connector,
            "_post_graphql",
            return_value={
                "pages": {
                    "list": [
                        {"id": 1, "path": "docs/a", "title": "A"},
                        {"id": 2, "path": "docs/b", "title": "B"},
                        {"id": 3, "path": "docs/c", "title": "C"},
                    ]
                }
            },
        ):
            pages, next_offset = await connector.list_pages(
                _config(), limit=2, offset=2
            )

        assert pages == []
        assert next_offset is None


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
                        "tags": [{"id": 1, "tag": "arch", "title": "Architecture"}],
                    }
                }
            }

        with patch.object(connector, "_post_graphql", side_effect=fake_post):
            page = await connector.get_page_by_id(_config(), "5001")

        assert "single(id: $id)" in captured["query"]
        assert "tags { id tag title }" in captured["query"]
        assert "isPublished" not in captured["query"]
        assert captured["variables"] == {"id": 5001}
        assert page is not None
        assert page.path == "docs/renamed"
        assert page.content == "# Renamed"
        assert page.tags == ("arch",)

    @pytest.mark.asyncio
    async def test_falls_back_to_render_when_source_content_is_blank(self):
        connector = WikijsConnector()

        with patch.object(
            connector,
            "_post_graphql",
            return_value={
                "pages": {
                    "single": {
                        "id": 5001,
                        "path": "docs/renamed",
                        "title": "Renamed",
                        "updatedAt": "2026-09-13T02:00:00Z",
                        "locale": "zh",
                        "content": "",
                        "render": "<h1>Renamed</h1><p>Body</p>",
                        "tags": [],
                    }
                }
            },
        ):
            page = await connector.get_page_by_id(_config(), "5001")

        assert page is not None
        assert page.content == "# Renamed\n\nBody"

    @pytest.mark.asyncio
    async def test_falls_back_to_render_when_source_read_is_forbidden(self):
        connector = WikijsConnector()
        requests = []

        async def fake_request(config, query, variables):
            requests.append(query)
            if "content render" in query:
                return {
                    "data": {"pages": {"single": None}},
                    "errors": [
                        {
                            "message": "Forbidden",
                            "path": ["pages", "single", "content"],
                        }
                    ],
                }
            return {
                "data": {
                    "pages": {
                        "single": {
                            "id": 5001,
                            "path": "docs/renamed",
                            "title": "Renamed",
                            "updatedAt": "2026-09-13T02:00:00Z",
                            "locale": "zh",
                            "render": "<h1>Renamed</h1><p>Body</p>",
                            "tags": [],
                        }
                    }
                }
            }

        with patch.object(connector, "_request_graphql", side_effect=fake_request):
            page = await connector.get_page_by_id(_config(), "5001")

        assert len(requests) == 2
        assert "content" not in requests[1]
        assert page is not None
        assert page.content == "# Renamed\n\nBody"


class TestGraphqlRequest:
    @pytest.mark.asyncio
    async def test_uses_normalized_https_endpoint_and_disables_redirects(self):
        connector = WikijsConnector()
        response = MagicMock()
        response.status = 200
        response.json = AsyncMock(return_value={"data": {"ok": True}})
        response.__aenter__ = AsyncMock(return_value=response)
        response.__aexit__ = AsyncMock(return_value=None)
        session = MagicMock()
        session.post.return_value = response
        manager = MagicMock()
        manager.__aenter__ = AsyncMock(return_value=session)
        manager.__aexit__ = AsyncMock(return_value=None)

        with (
            patch(
                "app.services.wiki.connectors.wikijs.AsyncSessionManager",
                return_value=manager,
            ),
            patch(
                "app.services.wiki.connectors.wikijs.validate_wiki_site_url",
                return_value="https://wiki.example.com",
            ),
        ):
            await connector._request_graphql(
                _config(" https://WIKI.example.com/ "), "query { ok }", {}
            )

        session.post.assert_called_once()
        assert session.post.call_args.args[0] == "https://wiki.example.com/graphql"
        assert session.post.call_args.kwargs["allow_redirects"] is False


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

    @pytest.mark.asyncio
    async def test_uses_structured_page_forbidden_code(self):
        connector = WikijsConnector()
        payload = {
            "data": {"pages": {"p0": None}},
            "errors": [
                {
                    "message": "Access denied",
                    "path": ["pages", "p0"],
                    "extensions": {"code": "PageViewForbidden"},
                }
            ],
        }

        with patch.object(connector, "_request_graphql", return_value=payload):
            probes = await connector.inspect_page_metadata_by_ids(
                _config(), ["11"], batch_size=500
            )

        assert probes["11"].error_code == "wiki_page_forbidden"
        assert probes["11"].confirmed_missing is False


class TestConnectionCompatibility:
    @pytest.mark.parametrize(
        ("version", "expected_message"),
        [
            ("2.4.999", "2.5.0"),
            ("3.0.0", "2.x"),
        ],
    )
    @pytest.mark.asyncio
    async def test_rejects_unsupported_wikijs_versions(self, version, expected_message):
        connector = WikijsConnector()

        with patch.object(connector, "_probe_version", return_value=version):
            result = await connector.test_connection(_config())

        assert result.ok is False
        assert expected_message in result.message
        assert result.version == version

    @pytest.mark.parametrize("version", ["2.5.0", "2.5.297"])
    @pytest.mark.asyncio
    async def test_accepts_supported_wikijs_versions(self, version):
        connector = WikijsConnector()

        with (
            patch.object(
                connector,
                "_probe_version",
                return_value=version,
            ),
            patch.object(
                connector,
                "_post_graphql",
                return_value={"pages": {"list": []}},
            ),
        ):
            result = await connector.test_connection(_config())

        assert result.ok is True
        assert result.version == version

    @pytest.mark.asyncio
    async def test_structured_forbidden_error_is_auth_failure(self):
        connector = WikijsConnector()
        payload = {
            "errors": [
                {
                    "message": "Access denied",
                    "extensions": {"code": "PageViewForbidden"},
                }
            ]
        }

        with patch.object(connector, "_request_graphql", return_value=payload):
            with pytest.raises(WikiApiError) as exc_info:
                await connector._post_graphql(_config(), "query { pages { list } }", {})

        assert exc_info.value.error_code == "wiki_auth_failed"

    @pytest.mark.asyncio
    async def test_requires_version_evidence_for_empty_site(self):
        connector = WikijsConnector()
        with (
            patch.object(connector, "_probe_version", return_value=None),
            patch.object(
                connector,
                "_post_graphql",
                return_value={"pages": {"list": []}},
            ),
        ):
            result = await connector.test_connection(_config())

        assert result.ok is False
        assert "不能确认" in result.message

    @pytest.mark.asyncio
    async def test_probes_metadata_and_body_for_supported_site(self):
        connector = WikijsConnector()
        list_data = {
            "pages": {
                "list": [{"id": 7, "path": "docs/a", "locale": "zh", "title": "A"}]
            }
        }
        metadata = WikiPageMeta(id="7", path="docs/a", title="A", locale="zh")

        with (
            patch.object(connector, "_probe_version", return_value="2.5.314"),
            patch.object(connector, "_post_graphql", return_value=list_data),
            patch.object(
                connector, "get_page_metadata_by_id", return_value=metadata
            ) as get_metadata,
            patch.object(
                connector, "get_page_by_id", return_value=metadata
            ) as get_by_id,
        ):
            result = await connector.test_connection(_config())

        assert result.ok is True
        get_metadata.assert_awaited_once_with(_config(), "7")
        get_by_id.assert_awaited_once_with(_config(), "7")

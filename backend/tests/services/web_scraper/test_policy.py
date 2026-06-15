import logging

import pytest

from app.services.web_scraper.policy import ScrapePolicy, SitePolicyResolver


def test_resolve_default_policy_for_unknown_site() -> None:
    resolver = SitePolicyResolver(site_configs={})

    policy = resolver.resolve("https://example.com/page")

    assert policy == ScrapePolicy()


def test_resolve_matches_most_specific_domain() -> None:
    resolver = SitePolicyResolver(
        site_configs={
            "example.com": {"profile": "desktop_chrome_en"},
            "docs.example.com": {"profile": "mobile_safari"},
        }
    )

    policy = resolver.resolve("https://docs.example.com/page")

    assert policy.profile == "mobile_safari"


def test_unknown_site_config_fields_are_ignored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    resolver = SitePolicyResolver(
        site_configs={
            "example.com": {
                "wait_until": "load",
                "js_code": "window.__legacy = true",
                "prefer_html_markdown": False,
            }
        }
    )

    with caplog.at_level(logging.WARNING):
        policy = resolver.resolve("https://example.com/page")

    assert policy.wait_until == "load"
    assert policy.prefer_html_markdown is False
    assert not hasattr(policy, "js_code")
    assert "Ignoring unknown site config field: js_code" in caplog.text


def test_invalid_numeric_site_config_is_ignored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    resolver = SitePolicyResolver(
        site_configs={
            "example.com": {
                "page_timeout_ms": -1,
            }
        }
    )

    with caplog.at_level(logging.WARNING):
        policy = resolver.resolve("https://example.com/page")

    assert policy == ScrapePolicy()
    assert "Invalid site config ignored" in caplog.text

from app.services.web_scraper.proxy import ProxyMode, ProxyResolver

PROXY_URL = "http://proxy.example.com:8080"


def test_resolve_none_without_proxy_url() -> None:
    plan = ProxyResolver().resolve("fallback", "")

    assert plan.mode == ProxyMode.NONE
    assert plan.raw_url is None
    assert plan.crawl4ai_proxy_config() is None
    assert plan.playwright_proxy_config() is None
    assert plan.httpx_client_kwargs() == {}


def test_direct_is_legacy_force_proxy() -> None:
    plan = ProxyResolver().resolve("direct", PROXY_URL)

    assert plan.mode == ProxyMode.DIRECT_LEGACY
    assert plan.force_proxy is True
    assert plan.crawl4ai_proxy_config() == {"server": PROXY_URL}


def test_proxy_mode_builds_client_specific_proxy_configs() -> None:
    plan = ProxyResolver().resolve("proxy", PROXY_URL)

    assert plan.force_proxy is True
    assert plan.playwright_proxy_config() == {"server": PROXY_URL}
    assert plan.httpx_client_kwargs() == {"proxy": PROXY_URL}


def test_fallback_mode_requires_proxy_url() -> None:
    plan = ProxyResolver().resolve("fallback", PROXY_URL)

    assert plan.mode == ProxyMode.FALLBACK
    assert plan.fallback is True
    assert plan.httpx_client_kwargs() == {}
    assert plan.httpx_client_kwargs(use_proxy=True) == {"proxy": PROXY_URL}


def test_proxy_resolver_trims_mode_and_proxy_url() -> None:
    plan = ProxyResolver().resolve(" fallback ", f" {PROXY_URL} ")

    assert plan.mode == ProxyMode.FALLBACK
    assert plan.raw_url == PROXY_URL


def test_proxy_resolver_treats_whitespace_proxy_as_none() -> None:
    plan = ProxyResolver().resolve("proxy", "   ")

    assert plan.mode == ProxyMode.NONE
    assert plan.raw_url is None

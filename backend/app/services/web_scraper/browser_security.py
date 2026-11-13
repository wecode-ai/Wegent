# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Install the same network policy on both browser-backed scrape paths."""

import asyncio
from dataclasses import dataclass
from typing import Any
from weakref import WeakSet

from app.services.web_scraper.chromium_security import ChromiumRequestGuard
from app.services.web_scraper.models import ERROR_SSRF_BLOCKED
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
    redact_url_for_logging,
)


@dataclass
class BrowserNavigation:
    """Retain a main-navigation denial even if the browser wraps its error."""

    blocked_url: str | None = None

    def raise_if_blocked(self) -> None:
        if self.blocked_url is not None:
            raise WebScraperSecurityError(
                ERROR_SSRF_BLOCKED,
                "Navigation blocked by security policy: "
                + redact_url_for_logging(self.blocked_url),
            )


class BrowserRequestGuard:
    """One set of context routes, with navigation errors kept per page."""

    def __init__(self, guard: WebScraperUrlGuard) -> None:
        self._guard = guard
        self._lock = asyncio.Lock()
        self._installed = False
        self._chromium = ChromiumRequestGuard(guard)
        self._pages: WeakSet[Any] = WeakSet()

    async def install(self, context: Any) -> None:
        async with self._lock:
            if self._installed:
                return
            await context.route("**/*", self._route_request)
            await context.route_web_socket("**/*", self._route_websocket)
            self._installed = True

    async def begin_navigation(
        self, context: Any, page: Any, navigation: BrowserNavigation
    ) -> None:
        await self._chromium.begin_navigation(context, page, navigation)
        self._pages.add(page)

    async def _route_request(self, route: Any, request: Any) -> None:
        # Popups are not extraction targets. Their first request must not escape
        # before a page-specific CDP guard has been installed.
        try:
            owned = request.frame.page in self._pages
        except Exception:
            owned = False
        if owned:
            await route.continue_()
            return
        await route.abort()

    async def _route_websocket(self, websocket: Any) -> None:
        if self._guard.is_allowed_fetch_url(websocket.url):
            websocket.connect_to_server()
        else:
            await websocket.close()


async def install_browser_guard(
    context: Any, guard: WebScraperUrlGuard
) -> BrowserRequestGuard:
    """Reuse the installed routes when Crawl4AI reuses a browser context."""
    attribute = "_wegent_web_scraper_request_guard"
    installed = getattr(context, attribute, None)
    if installed is None:
        installed = BrowserRequestGuard(guard)
        setattr(context, attribute, installed)
    await installed.install(context)
    return installed


def configure_crawler_security(crawler: Any, guard: WebScraperUrlGuard) -> None:
    """Configure hooks before starting the service-owned managed browser."""
    strategy = crawler.crawler_strategy

    async def on_browser_created(browser: Any, **kwargs: Any) -> None:
        # The persistent default context cannot block service workers at creation.
        # Replace it with one reusable, guarded context owned by this crawler.
        context = await browser.new_context(service_workers="block")
        await strategy.browser_manager.setup_context(context)
        await install_browser_guard(context, guard)
        strategy.browser_manager.default_context = context

    async def on_page_context_created(
        page: Any, context: Any, config: Any, **kwargs: Any
    ) -> Any:
        installed = await install_browser_guard(context, guard)
        await installed.begin_navigation(context, page, config._wegent_navigation)
        return page

    strategy.set_hook("on_browser_created", on_browser_created)
    strategy.set_hook("on_page_context_created", on_page_context_created)

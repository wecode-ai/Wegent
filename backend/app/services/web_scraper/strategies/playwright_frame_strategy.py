# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Playwright frame extraction fallback strategy."""

import logging
from dataclasses import dataclass
from typing import Any

from app.core.blocking_work import run_knowledge_io
from app.core.bounded_executor import BoundedExecutorOverloaded
from app.services.web_scraper.markdown.cleaner import MarkdownCleaner
from app.services.web_scraper.markdown.html_to_markdown import HtmlToMarkdownConverter
from app.services.web_scraper.models import InternalScrapeResult, SourcePart
from app.services.web_scraper.policy import ScrapePolicy
from app.services.web_scraper.profiles import BrowserProfile
from app.services.web_scraper.proxy import ProxyPlan
from app.services.web_scraper.quality import MarkdownQualityEvaluator
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
    redact_url_for_logging,
)

logger = logging.getLogger(__name__)

MIN_FRAME_TEXT_LENGTH = 30
PROXY_RETRY_STATUS_CODES = {403, 429}
SCROLL_SCRIPT = """
async () => {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const height = Math.max(
    document.body ? document.body.scrollHeight : 0,
    document.documentElement ? document.documentElement.scrollHeight : 0
  );
  for (let y = 0; y < height; y += Math.max(window.innerHeight, 400)) {
    window.scrollTo(0, y);
    await delay(100);
  }
  window.scrollTo(0, 0);
}
"""


@dataclass
class PlaywrightResources:
    """Resources that must be closed after a Playwright scrape attempt."""

    browser: Any = None
    context: Any = None
    page: Any = None


class PlaywrightFrameExtractionStrategy:
    """Extract structured Markdown from page and nested frames."""

    def __init__(
        self,
        converter: HtmlToMarkdownConverter | None = None,
        cleaner: MarkdownCleaner | None = None,
        quality_evaluator: MarkdownQualityEvaluator | None = None,
    ) -> None:
        self._converter = converter or HtmlToMarkdownConverter()
        self._cleaner = cleaner or MarkdownCleaner()
        self._quality_evaluator = quality_evaluator or MarkdownQualityEvaluator()

    async def scrape(
        self,
        url: str,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
    ) -> InternalScrapeResult:
        """Scrape page and frames through Playwright."""
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            return InternalScrapeResult(url=url, success=False, error_message=str(exc))

        attempted_method = "playwright_html"
        try:
            async with async_playwright() as playwright:
                result = await self._scrape_with_proxy_plan(
                    playwright, url, policy, profile, proxy_plan, guard
                )
                attempted_method = result.extraction_method
                return result
        except WebScraperSecurityError as exc:
            return InternalScrapeResult(
                url=url,
                success=False,
                error_message=exc.message,
                security_error_code=exc.error_code,
                extraction_method=attempted_method,
            )
        except BoundedExecutorOverloaded:
            raise
        except Exception as exc:
            logger.warning(
                "Playwright frame extraction failed for %s: %s",
                redact_url_for_logging(url),
                exc,
            )
            return InternalScrapeResult(url=url, success=False, error_message=str(exc))

    async def _scrape_with_proxy_plan(
        self,
        playwright: Any,
        url: str,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
    ) -> InternalScrapeResult:
        if proxy_plan.fallback:
            try:
                direct_result = await self._scrape_once(
                    playwright, url, policy, profile, proxy_plan, guard, False
                )
            except WebScraperSecurityError:
                raise
            except BoundedExecutorOverloaded:
                raise
            except Exception as exc:
                if proxy_plan.has_proxy:
                    logger.info(
                        "Retrying Playwright extraction with proxy after direct failure for %s",
                        redact_url_for_logging(url),
                    )
                    return await self._scrape_once(
                        playwright, url, policy, profile, proxy_plan, guard, True
                    )
                raise exc

            if self._should_retry_with_proxy(direct_result, proxy_plan):
                return await self._scrape_once(
                    playwright, url, policy, profile, proxy_plan, guard, True
                )
            return direct_result

        return await self._scrape_once(
            playwright,
            url,
            policy,
            profile,
            proxy_plan,
            guard,
            proxy_plan.force_proxy,
        )

    async def _scrape_once(
        self,
        playwright: Any,
        url: str,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
        use_proxy: bool,
    ) -> InternalScrapeResult:
        resources = PlaywrightResources()
        try:
            return await self._perform_playwright_scrape(
                playwright=playwright,
                resources=resources,
                url=url,
                policy=policy,
                profile=profile,
                proxy_plan=proxy_plan,
                guard=guard,
                use_proxy=use_proxy,
            )
        finally:
            await self._close_quietly(resources.page)
            await self._close_quietly(resources.context)
            await self._close_quietly(resources.browser)

    async def _perform_playwright_scrape(
        self,
        playwright: Any,
        resources: PlaywrightResources,
        url: str,
        policy: ScrapePolicy,
        profile: BrowserProfile,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
        use_proxy: bool,
    ) -> InternalScrapeResult:
        launch_kwargs = {"headless": True}
        if use_proxy and proxy_plan.has_proxy:
            launch_kwargs["proxy"] = proxy_plan.playwright_proxy_config()

        resources.browser = await playwright.chromium.launch(**launch_kwargs)
        resources.context = await resources.browser.new_context(
            **self._context_kwargs(profile)
        )
        await self._install_guard_route(resources.context, guard)

        resources.page = await resources.context.new_page()
        response = await resources.page.goto(
            url,
            wait_until=self._normalize_wait_until(policy.wait_until),
            timeout=policy.page_timeout_ms,
        )
        await run_knowledge_io(guard.validate_final_url, url, resources.page.url)

        if policy.wait_for:
            await resources.page.wait_for_selector(
                policy.wait_for, timeout=policy.page_timeout_ms
            )
        elif policy.delay_before_return_html:
            await resources.page.wait_for_timeout(
                int(policy.delay_before_return_html * 1000)
            )

        if policy.scroll_main_page:
            await self._scroll_frame(resources.page)

        source_parts = await self._extract_source_parts(resources.page, policy, guard)
        page_title = await resources.page.title()
        markdown = await run_knowledge_io(
            self._combine_source_parts,
            page_title,
            resources.page.url,
            source_parts,
            policy.max_total_chars,
        )
        status_code = response.status if response else None
        content_type = response.headers.get("content-type") if response else None
        return await run_knowledge_io(
            self._build_internal_result,
            url,
            resources.page.url,
            page_title,
            markdown,
            content_type,
            status_code,
            source_parts,
        )

    def _build_internal_result(
        self,
        url: str,
        final_url: str,
        page_title: str,
        markdown: str,
        content_type: str | None,
        status_code: int | None,
        source_parts: list[SourcePart],
    ) -> InternalScrapeResult:
        quality_level = self._result_quality_level(source_parts)
        extraction_method = (
            "playwright_text" if quality_level == "degraded" else "playwright_html"
        )
        return InternalScrapeResult(
            url=url,
            final_url=final_url,
            title=page_title,
            markdown=markdown,
            content_type=content_type,
            status_code=status_code,
            success=bool(markdown),
            error_message=None if markdown else "No extractable frame content",
            extraction_method=extraction_method,
            quality_level=quality_level,
            source_parts=source_parts,
        )

    async def _install_guard_route(
        self, context: Any, guard: WebScraperUrlGuard
    ) -> None:
        async def guard_route(route: Any, request: Any) -> None:
            if await run_knowledge_io(guard.is_allowed_fetch_url, request.url):
                await route.continue_()
            else:
                await route.abort()

        await context.route("**/*", guard_route)

    async def _extract_source_parts(
        self,
        page: Any,
        policy: ScrapePolicy,
        guard: WebScraperUrlGuard,
    ) -> list[SourcePart]:
        parts: list[SourcePart] = []
        seen: set[str] = set()
        total_chars = 0
        frames = page.frames[: policy.max_frames]

        for frame in frames:
            frame_url = frame.url or ""
            if frame_url and not await run_knowledge_io(
                guard.is_allowed_frame_url,
                frame_url,
            ):
                continue

            part = await self._extract_frame_part(frame, policy)
            if not part:
                continue

            normalized = await run_knowledge_io(
                self._normalize_markdown_for_deduplication,
                part.markdown,
            )
            if len(normalized) < MIN_FRAME_TEXT_LENGTH or normalized in seen:
                continue
            seen.add(normalized)
            parts.append(part)
            total_chars += len(part.markdown)

            if total_chars >= policy.max_total_chars:
                break

        return parts

    @staticmethod
    def _normalize_markdown_for_deduplication(markdown: str) -> str:
        return " ".join(markdown.split())

    async def _extract_frame_part(
        self, frame: Any, policy: ScrapePolicy
    ) -> SourcePart | None:
        try:
            await frame.wait_for_load_state("domcontentloaded", timeout=3000)
        except Exception:
            pass

        if policy.scroll_frames:
            await self._scroll_frame(frame)

        title = await self._frame_title(frame)
        frame_url = frame.url or None

        if policy.prefer_html_markdown:
            html = await self._frame_html(frame)
            part = await run_knowledge_io(
                self._prepare_html_source_part,
                html,
                title,
                frame_url,
                policy,
            )
            if part is not None:
                return part

        if not policy.allow_text_degraded:
            return None

        text = await self._frame_text(frame)
        return await run_knowledge_io(
            self._prepare_plain_text_source_part,
            text,
            title,
            frame_url,
            policy,
        )

    def _prepare_html_source_part(
        self,
        html: str,
        title: str,
        frame_url: str | None,
        policy: ScrapePolicy,
    ) -> SourcePart | None:
        markdown, quality = self._prepare_html_markdown(html, frame_url, policy)
        if not quality.acceptable:
            return None
        return SourcePart(
            title=title or None,
            url=frame_url,
            markdown=markdown[: policy.max_chars_per_frame],
            text_length=len(markdown),
            method="playwright_html",
            quality_level="structured",
        )

    def _prepare_plain_text_source_part(
        self,
        text: str,
        title: str,
        frame_url: str | None,
        policy: ScrapePolicy,
    ) -> SourcePart | None:
        markdown, quality = self._prepare_plain_text_markdown(text, policy)
        if not quality.acceptable:
            return None
        return SourcePart(
            title=title or None,
            url=frame_url,
            markdown=markdown[: policy.max_chars_per_frame],
            text_length=len(markdown),
            method="playwright_text",
            quality_level="degraded",
        )

    def _markdown_from_html(
        self, html: str, base_url: str | None, policy: ScrapePolicy
    ) -> str:
        cleaned_html = self._cleaner.clean_html(html, policy)
        markdown = self._converter.to_markdown(cleaned_html, base_url=base_url)
        return self._cleaner.clean_markdown(markdown, policy)

    def _prepare_html_markdown(
        self,
        html: str,
        base_url: str | None,
        policy: ScrapePolicy,
    ) -> tuple[str, Any]:
        markdown = self._markdown_from_html(html, base_url, policy)
        quality = self._quality_evaluator.evaluate(markdown, policy, "structured")
        return markdown, quality

    def _prepare_plain_text_markdown(
        self,
        text: str,
        policy: ScrapePolicy,
    ) -> tuple[str, Any]:
        markdown = self._cleaner.clean_plain_text(text, policy)
        quality = self._quality_evaluator.evaluate(markdown, policy, "degraded")
        return markdown, quality

    def _combine_source_parts(
        self,
        page_title: str,
        page_url: str,
        source_parts: list[SourcePart],
        max_total_chars: int,
    ) -> str:
        if not source_parts:
            return ""

        sections = []
        title = page_title or "Web Page"
        sections.append(f"# {title}\n\nSource: {page_url}")

        for index, part in enumerate(source_parts):
            heading = part.title or ("Main Page" if index == 0 else f"Frame {index}")
            source = f"\n\nSource: {part.url}" if part.url else ""
            sections.append(f"## {heading}{source}\n\n{part.markdown}")

        return "\n\n".join(sections)[:max_total_chars]

    async def _frame_html(self, frame: Any) -> str:
        try:
            return await frame.evaluate(
                "() => document.body ? document.body.innerHTML : ''"
            )
        except Exception:
            return ""

    async def _frame_text(self, frame: Any) -> str:
        try:
            return await frame.evaluate(
                "() => document.body ? document.body.innerText : ''"
            )
        except Exception:
            return ""

    async def _frame_title(self, frame: Any) -> str:
        try:
            return await frame.evaluate("() => document.title || ''")
        except Exception:
            return ""

    async def _scroll_frame(self, frame: Any) -> None:
        try:
            await frame.evaluate(SCROLL_SCRIPT)
        except Exception:
            pass

    async def _close_quietly(self, resource: Any) -> None:
        if resource is None:
            return
        try:
            await resource.close()
        except Exception:
            pass

    def _normalize_wait_until(self, wait_until: str) -> str:
        if wait_until in {"commit", "domcontentloaded", "load", "networkidle"}:
            return wait_until
        return "domcontentloaded"

    def _context_kwargs(self, profile: BrowserProfile) -> dict[str, Any]:
        kwargs = {
            "locale": profile.locale,
            "timezone_id": profile.timezone_id,
            "viewport": profile.viewport,
            "extra_http_headers": profile.headers,
        }
        if profile.user_agent:
            kwargs["user_agent"] = profile.user_agent
        return kwargs

    def _should_retry_with_proxy(
        self,
        result: InternalScrapeResult,
        proxy_plan: ProxyPlan,
    ) -> bool:
        if not proxy_plan.has_proxy:
            return False
        if not result.success:
            return True
        if result.status_code is None:
            return False
        return (
            result.status_code in PROXY_RETRY_STATUS_CODES or result.status_code >= 500
        )

    def _result_quality_level(self, source_parts: list[SourcePart]) -> str:
        if source_parts and all(
            part.quality_level == "degraded" for part in source_parts
        ):
            return "degraded"
        return "structured"

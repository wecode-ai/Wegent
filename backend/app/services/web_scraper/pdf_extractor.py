# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""PDF text extraction for web scraper results."""

import io
import logging
from typing import Any

import httpx

from app.services.web_scraper.models import InternalScrapeResult, SourcePart
from app.services.web_scraper.proxy import ProxyPlan
from app.services.web_scraper.security import (
    WebScraperSecurityError,
    WebScraperUrlGuard,
    redact_url_for_logging,
)
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

PDF_DOWNLOAD_TIMEOUT = 30
PDF_MAX_REDIRECTS = 10
PROXY_RETRY_STATUS_CODES = {403, 429}
REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}


class PdfExtractor:
    """Download and extract text from PDF documents."""

    @trace_async(
        span_name="pdf_extractor.extract",
        tracer_name="web_scraper",
        extract_attributes=lambda self, pdf_url, *args, **kwargs: {
            "pdf.url": redact_url_for_logging(pdf_url)
        },
    )
    async def extract(
        self,
        pdf_url: str,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
    ) -> InternalScrapeResult:
        """Extract PDF content as degraded markdown."""
        try:
            guard.validate_initial_url(pdf_url)

            response = await self._download_pdf(pdf_url, proxy_plan, guard)
            markdown, source_part = self._extract_pdf_text(response)
            return InternalScrapeResult(
                url=pdf_url,
                final_url=str(response.url),
                markdown=markdown,
                content_type=response.headers.get("content-type"),
                status_code=response.status_code,
                success=True,
                error_message=None,
                extraction_method="pdf",
                quality_level="degraded",
                source_parts=[source_part] if markdown else [],
            )
        except WebScraperSecurityError as exc:
            return InternalScrapeResult(
                url=pdf_url,
                success=False,
                error_message=exc.message,
                security_error_code=exc.error_code,
                extraction_method="pdf",
                quality_level="degraded",
            )
        except ImportError:
            logger.error("PyPDF2 not installed, cannot extract PDF content")
            return InternalScrapeResult(
                url=pdf_url,
                success=False,
                error_message="PyPDF2 not installed, cannot extract PDF content",
                extraction_method="pdf",
                quality_level="degraded",
            )
        except httpx.HTTPStatusError as exc:
            return InternalScrapeResult(
                url=pdf_url,
                final_url=str(exc.response.url),
                success=False,
                error_message=str(exc),
                content_type=exc.response.headers.get("content-type"),
                status_code=exc.response.status_code,
                extraction_method="pdf",
                quality_level="degraded",
            )
        except httpx.TimeoutException as exc:
            return InternalScrapeResult(
                url=pdf_url,
                success=False,
                error_message=str(exc),
                extraction_method="pdf",
                quality_level="degraded",
            )
        except Exception as exc:
            logger.warning(
                "Failed to extract PDF content from %s: %s",
                redact_url_for_logging(pdf_url),
                exc,
            )
            return InternalScrapeResult(
                url=pdf_url,
                success=False,
                error_message=str(exc),
                extraction_method="pdf",
                quality_level="degraded",
            )

    async def _download_pdf(
        self,
        pdf_url: str,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
    ) -> httpx.Response:
        if proxy_plan.fallback:
            try:
                return await self._download_once(pdf_url, proxy_plan, guard, False)
            except Exception as exc:
                if self._should_retry_with_proxy(exc):
                    return await self._download_once(pdf_url, proxy_plan, guard, True)
                raise

        return await self._download_once(
            pdf_url,
            proxy_plan,
            guard,
            proxy_plan.force_proxy,
        )

    async def _download_once(
        self,
        pdf_url: str,
        proxy_plan: ProxyPlan,
        guard: WebScraperUrlGuard,
        use_proxy: bool,
    ) -> httpx.Response:
        async with httpx.AsyncClient(
            timeout=PDF_DOWNLOAD_TIMEOUT,
            follow_redirects=False,
            **proxy_plan.httpx_client_kwargs(use_proxy=use_proxy),
        ) as client:
            current_url = pdf_url
            for _ in range(PDF_MAX_REDIRECTS + 1):
                response = await client.get(current_url)
                if response.status_code not in REDIRECT_STATUS_CODES:
                    guard.validate_final_url(pdf_url, str(response.url))
                    response.raise_for_status()
                    return response

                location = response.headers.get("location")
                if not location:
                    response.raise_for_status()
                    return response

                current_url = guard.validate_redirect_target(
                    pdf_url,
                    str(response.url),
                    location,
                )

            raise httpx.TooManyRedirects(
                f"Exceeded {PDF_MAX_REDIRECTS} redirects",
                request=httpx.Request("GET", pdf_url),
            )

    def _should_retry_with_proxy(self, exc: Exception) -> bool:
        if isinstance(exc, (httpx.TimeoutException, httpx.RequestError)):
            return True
        if isinstance(exc, httpx.HTTPStatusError):
            status_code = exc.response.status_code
            return status_code in PROXY_RETRY_STATUS_CODES or status_code >= 500
        return False

    def _extract_pdf_text(self, response: httpx.Response) -> tuple[str, SourcePart]:
        from PyPDF2 import PdfReader

        reader = PdfReader(io.BytesIO(response.content))
        text_parts = []
        for index, page in enumerate(reader.pages):
            page_text = page.extract_text()
            if page_text:
                text_parts.append(f"## Page {index + 1}\n\n{page_text}")

        markdown = "\n\n".join(text_parts)
        source_part = SourcePart(
            title="PDF",
            url=str(response.url),
            markdown=markdown,
            text_length=len(markdown),
            method="pdf",
            quality_level="degraded",
        )
        return markdown, source_part

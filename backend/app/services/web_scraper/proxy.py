# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Proxy mode normalization for web scraper clients."""

from enum import Enum
from typing import Optional

from pydantic import BaseModel


class ProxyMode(str, Enum):
    """Supported web scraper proxy modes."""

    NONE = "none"
    FALLBACK = "fallback"
    PROXY = "proxy"
    DIRECT_LEGACY = "direct"


class ProxyPlan(BaseModel):
    """Normalized proxy execution plan."""

    mode: ProxyMode
    raw_url: Optional[str] = None

    @property
    def has_proxy(self) -> bool:
        """Whether a proxy URL is configured."""
        return bool(self.raw_url)

    @property
    def force_proxy(self) -> bool:
        """Whether all attempts should use proxy."""
        return self.mode in {ProxyMode.PROXY, ProxyMode.DIRECT_LEGACY}

    @property
    def fallback(self) -> bool:
        """Whether direct should be tried before proxy."""
        return self.mode == ProxyMode.FALLBACK and self.has_proxy

    def crawl4ai_proxy_config(self) -> Optional[dict[str, str]]:
        """Return Crawl4AI 0.8-compatible proxy config."""
        if not self.raw_url:
            return None
        return {"server": self.raw_url}

    def playwright_proxy_config(self) -> Optional[dict[str, str]]:
        """Return Playwright-compatible proxy config."""
        if not self.raw_url:
            return None
        return {"server": self.raw_url}

    def httpx_client_kwargs(self, use_proxy: bool | None = None) -> dict[str, str]:
        """Return httpx AsyncClient kwargs for this proxy."""
        should_use_proxy = self.force_proxy if use_proxy is None else use_proxy
        if not self.raw_url or not should_use_proxy:
            return {}
        return {"proxy": self.raw_url}


class ProxyResolver:
    """Resolve settings into a proxy plan."""

    def resolve(self, mode: str, raw_url: Optional[str]) -> ProxyPlan:
        """Normalize proxy settings."""
        normalized_mode = (mode or ProxyMode.NONE.value).strip().lower()
        if normalized_mode not in {item.value for item in ProxyMode}:
            normalized_mode = ProxyMode.NONE.value

        proxy_mode = ProxyMode(normalized_mode)
        cleaned = (raw_url or "").strip()
        cleaned_url = cleaned or None

        if not cleaned_url and proxy_mode in {
            ProxyMode.FALLBACK,
            ProxyMode.PROXY,
            ProxyMode.DIRECT_LEGACY,
        }:
            return ProxyPlan(mode=ProxyMode.NONE, raw_url=None)

        return ProxyPlan(mode=proxy_mode, raw_url=cleaned_url)

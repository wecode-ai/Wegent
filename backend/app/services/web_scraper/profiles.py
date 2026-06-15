# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Browser profiles used by web scraper strategies."""

from typing import Any, Optional

from pydantic import BaseModel, Field


class BrowserProfile(BaseModel):
    """Browser context profile."""

    name: str
    user_agent: Optional[str] = None
    user_agent_mode: Optional[str] = None
    locale: str = "zh-CN"
    timezone_id: str = "Asia/Shanghai"
    viewport: dict[str, int] = Field(
        default_factory=lambda: {"width": 1366, "height": 768}
    )
    headers: dict[str, str] = Field(
        default_factory=lambda: {"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"}
    )
    enable_stealth: bool = True
    use_managed_browser: bool = False
    cookies: list[dict[str, Any]] = Field(default_factory=list)


class BrowserProfileFactory:
    """Create built-in browser profiles by name."""

    _profiles = {
        "desktop_chrome_cn": BrowserProfile(name="desktop_chrome_cn"),
        "desktop_chrome_en": BrowserProfile(
            name="desktop_chrome_en",
            locale="en-US",
            timezone_id="America/Los_Angeles",
            headers={"Accept-Language": "en-US,en;q=0.9"},
        ),
        "mobile_safari": BrowserProfile(
            name="mobile_safari",
            user_agent=(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                "Mobile/15E148 Safari/604.1"
            ),
            user_agent_mode=None,
            viewport={"width": 390, "height": 844},
        ),
        "managed_session": BrowserProfile(
            name="managed_session",
            user_agent_mode="random",
            use_managed_browser=True,
        ),
    }

    def create(self, profile_name: str) -> BrowserProfile:
        """Return a configured profile, falling back to desktop Chrome CN."""
        profile = self._profiles.get(profile_name, self._profiles["desktop_chrome_cn"])
        return profile.model_copy(deep=True)

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk configuration - loaded from pydantic settings."""
from dataclasses import dataclass, field
from typing import List

from app.core.config import settings


@dataclass
class DingTalkConfig:
    """DingTalk OAuth configuration."""

    # Required credentials
    corp_id: str = ""
    client_id: str = ""
    client_secret: str = ""

    # ERP API key for employee email lookup
    erp_api_key: str = ""

    # Optional configuration
    fallback_url: str = "https://github.com/aspect-build/wegent"
    allowed_referers: List[str] = field(default_factory=list)
    ip_whitelist: List[str] = field(default_factory=list)
    code_expire_seconds: int = 300  # 5 minutes
    rate_limit_requests: int = 10
    rate_limit_window: int = 60  # seconds

    @classmethod
    def from_settings(cls) -> "DingTalkConfig":
        """Load configuration from pydantic settings."""
        return cls(
            corp_id=settings.DINGTALK_CORP_ID,
            client_id=settings.DINGTALK_CLIENT_ID,
            client_secret=settings.DINGTALK_CLIENT_SECRET,
            erp_api_key=settings.ERP_API_KEY,
            fallback_url=settings.DINGTALK_FALLBACK_URL
            or "https://github.com/aspect-build/wegent",
            # Use default values for optional settings
            allowed_referers=[],
            ip_whitelist=[],
            code_expire_seconds=300,
            rate_limit_requests=10,
            rate_limit_window=60,
        )

    def validate(self) -> bool:
        """Check if required configuration is present."""
        return bool(self.corp_id and self.client_id and self.client_secret)


# Global config instance
dingtalk_config = DingTalkConfig.from_settings()

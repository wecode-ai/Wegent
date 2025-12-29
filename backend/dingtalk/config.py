# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""DingTalk configuration - loaded from environment variables."""
import os
from dataclasses import dataclass, field
from typing import List


@dataclass
class DingTalkConfig:
    """DingTalk OAuth configuration."""

    # Required credentials
    corp_id: str = ""
    client_id: str = ""
    client_secret: str = ""

    # Optional configuration
    fallback_url: str = "https://github.com/aspect-build/wegent"
    allowed_referers: List[str] = field(default_factory=list)
    ip_whitelist: List[str] = field(default_factory=list)
    code_expire_seconds: int = 300  # 5 minutes
    rate_limit_requests: int = 10
    rate_limit_window: int = 60  # seconds

    @classmethod
    def from_env(cls) -> "DingTalkConfig":
        """Load configuration from environment variables."""
        allowed_referers_str = os.getenv("DINGTALK_ALLOWED_REFERERS", "")
        ip_whitelist_str = os.getenv("DINGTALK_IP_WHITELIST", "")

        return cls(
            corp_id=os.getenv("DINGTALK_CORP_ID", ""),
            client_id=os.getenv("DINGTALK_CLIENT_ID", ""),
            client_secret=os.getenv("DINGTALK_CLIENT_SECRET", ""),
            fallback_url=os.getenv(
                "DINGTALK_FALLBACK_URL", "https://github.com/aspect-build/wegent"
            ),
            allowed_referers=[
                r.strip() for r in allowed_referers_str.split(",") if r.strip()
            ],
            ip_whitelist=[
                ip.strip() for ip in ip_whitelist_str.split(",") if ip.strip()
            ],
            code_expire_seconds=int(os.getenv("DINGTALK_CODE_EXPIRE_SECONDS", "300")),
            rate_limit_requests=int(os.getenv("DINGTALK_RATE_LIMIT_REQUESTS", "10")),
            rate_limit_window=int(os.getenv("DINGTALK_RATE_LIMIT_WINDOW", "60")),
        )

    def validate(self) -> bool:
        """Check if required configuration is present."""
        return bool(self.corp_id and self.client_id and self.client_secret)


# Global config instance
dingtalk_config = DingTalkConfig.from_env()
